import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { PoolConfig } from "pg";
import { managedStorageSchemaStatements } from "./schema";
import {
  probeDatabase,
  queryDatabase,
  resetDatabaseForTests,
  setDatabasePoolFactoryForTests,
  type DatabasePool,
} from "./index";

const KEYS = ["DATABASE_URL", "DATABASE_POOL_MAX", "PERSISTENCE_BACKEND"] as const;
const saved = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));

beforeEach(() => {
  process.env.PERSISTENCE_BACKEND = "postgres";
  process.env.DATABASE_URL = "postgres://app:secret@homi-dev-postgres:5432/homi";
  delete process.env.DATABASE_POOL_MAX;
  resetDatabaseForTests();
});

afterEach(() => {
  setDatabasePoolFactoryForTests(undefined);
  resetDatabaseForTests();
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
});

type Fake = { configs: PoolConfig[]; poolQueries: string[]; clientQueries: string[]; released: number };

/** A pool that records what runs on it; `failOn` makes one statement fail. */
function fakePool(options: { rows?: Record<string, unknown>[]; failOn?: string; hang?: boolean } = {}) {
  const fake: Fake = { configs: [], poolQueries: [], clientQueries: [], released: 0 };
  setDatabasePoolFactoryForTests(config => {
    fake.configs.push(config);
    const pool: DatabasePool = {
      async query(text: string) {
        fake.poolQueries.push(text);
        if (options.hang) return new Promise(() => undefined);
        return { rows: options.rows ?? [] };
      },
      async connect() {
        return {
          async query(text: string) {
            fake.clientQueries.push(text);
            if (options.failOn && text.includes(options.failOn)) throw new Error("ddl failed");
            return { rows: [] };
          },
          release() { fake.released++; },
        };
      },
    };
    return pool;
  });
  return fake;
}

test("connects with DATABASE_URL and a bounded pool (DATABASE_POOL_MAX, default 10)", async () => {
  const fake = fakePool({ rows: [{ ok: 1 }] });
  await queryDatabase("SELECT 1 AS ok");
  assert.equal(fake.configs.length, 1);
  assert.equal(fake.configs[0].connectionString, "postgres://app:secret@homi-dev-postgres:5432/homi");
  assert.equal(fake.configs[0].max, 10);

  resetDatabaseForTests();
  process.env.DATABASE_POOL_MAX = "4";
  const second = fakePool();
  await queryDatabase("SELECT 1");
  assert.equal(second.configs[0].max, 4);
});

test("the schema is created once, in one transaction on one connection, before the first query", async () => {
  const fake = fakePool({ rows: [{ value: 7 }] });
  const rows = await queryDatabase("SELECT $1::int AS value", [7]);
  await queryDatabase("SELECT 2");
  assert.deepEqual(rows, [{ value: 7 }]);
  assert.deepEqual(fake.clientQueries, ["BEGIN", ...managedStorageSchemaStatements, "COMMIT"]);
  assert.equal(fake.released, 1);
  assert.deepEqual(fake.poolQueries, ["SELECT $1::int AS value", "SELECT 2"]);
});

test("a failed schema rolls back, releases its connection and is tried again next time", async () => {
  const fake = fakePool({ failOn: "audio_upload_chunks" });
  await assert.rejects(queryDatabase("SELECT 1"), /ddl failed/);
  assert.equal(fake.clientQueries.at(-1), "ROLLBACK");
  assert.equal(fake.released, 1);
  assert.deepEqual(fake.poolQueries, []);
  await assert.rejects(queryDatabase("SELECT 1"), /ddl failed/);
  assert.equal(fake.released, 2, "retried instead of caching the failure");
});

test("the readiness probe never creates the schema and reports whether the tables exist", async () => {
  const fake = fakePool({ rows: [{ ok: 1, schema_ready: true }] });
  assert.equal(await probeDatabase(new AbortController().signal), true);
  assert.deepEqual(fake.clientQueries, []);

  resetDatabaseForTests();
  fakePool({ rows: [{ ok: 1, schema_ready: false }] });
  assert.equal(await probeDatabase(new AbortController().signal), false);
});

test("the readiness probe gives up when its signal aborts", async () => {
  fakePool({ hang: true });
  const controller = new AbortController();
  const probe = probeDatabase(controller.signal);
  controller.abort(new Error("probe timeout"));
  await assert.rejects(probe, /probe timeout/);
});

test("a missing DATABASE_URL is a clear error", async () => {
  delete process.env.DATABASE_URL;
  fakePool();
  await assert.rejects(queryDatabase("SELECT 1"), /DATABASE_URL/);
});
