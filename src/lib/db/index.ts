import { Pool, type PoolConfig } from "pg";
import { managedStorageSchemaStatements } from "@/lib/db/schema";
import { getPersistenceBackend } from "@/lib/storage/config";

/**
 * PostgreSQL over a regular connection pool (node-postgres). Works with a server on
 * the VPS (postgres://...@homi-dev-postgres:5432/...) and with Neon's TCP endpoint
 * (...neon.tech/...?sslmode=require). Backends are long-lived processes, so a pool
 * keeps connections open instead of paying an HTTP round trip per query.
 */

type DatabaseRow = Record<string, unknown>;
type QueryResult = { rows: DatabaseRow[] };
type PoolClientLike = { query(text: string, params?: unknown[]): Promise<QueryResult>; release(): void };

/** The part of pg's Pool this module uses; tests supply a fake. */
export type DatabasePool = {
  query(text: string, params?: unknown[]): Promise<QueryResult>;
  connect(): Promise<PoolClientLike>;
};

const DEFAULT_POOL_MAX = 10;
const IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

let pool: DatabasePool | null = null;
let schemaPromise: Promise<void> | null = null;
let poolFactory: ((config: PoolConfig) => DatabasePool) | undefined;

export function isPostgresStorageEnabled() {
  return getPersistenceBackend() === "postgres";
}

function positiveInteger(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function getDatabaseUrl() {
  const value = process.env.DATABASE_URL?.trim();

  if (!value) {
    throw new Error(
      "PERSISTENCE_BACKEND=postgres nhưng DATABASE_URL chưa được cấu hình.",
    );
  }

  return value;
}

function getPool(): DatabasePool {
  if (!pool) {
    const config: PoolConfig = {
      connectionString: getDatabaseUrl(),
      // Per backend process: N backends x this must stay under the server's max_connections.
      max: positiveInteger("DATABASE_POOL_MAX", DEFAULT_POOL_MAX),
      idleTimeoutMillis: IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: positiveInteger("DATABASE_CONNECT_TIMEOUT_MS", DEFAULT_CONNECT_TIMEOUT_MS),
    };
    if (poolFactory) {
      pool = poolFactory(config);
    } else {
      const created = new Pool(config);
      // An idle connection dropped by the server must not crash the process.
      created.on("error", () => undefined);
      pool = created as unknown as DatabasePool;
    }
  }

  return pool;
}

async function queryWithoutSchema<T extends DatabaseRow>(
  query: string,
  params: unknown[] = [],
) {
  return (await getPool().query(query, params)).rows as T[];
}

export async function ensureDatabaseSchema() {
  if (!isPostgresStorageEnabled()) {
    return;
  }

  if (!schemaPromise) {
    // Every idempotent DDL statement runs in one transaction on one connection.
    schemaPromise = (async () => {
      const client = await getPool().connect();
      try {
        await client.query("BEGIN");
        for (const statement of managedStorageSchemaStatements) await client.query(statement);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    })().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }

  await schemaPromise;
}

export async function queryDatabase<T extends DatabaseRow>(
  query: string,
  params: unknown[] = [],
) {
  await ensureDatabaseSchema();
  return queryWithoutSchema<T>(query, params);
}

export async function pingDatabase() {
  const startedAt = Date.now();
  const rows = await queryDatabase<{ ok: number }>("SELECT 1 AS ok");

  return {
    ok: rows[0]?.ok === 1,
    latencyMs: Date.now() - startedAt,
  };
}

/** Readiness probes must never initialize/migrate schema or alter user data. */
export async function probeDatabase(signal: AbortSignal) {
  const probe = queryWithoutSchema<{ ok: number; schema_ready: boolean }>(
    `SELECT 1 AS ok,
      to_regclass('app_records') IS NOT NULL
      AND to_regclass('audio_upload_sessions') IS NOT NULL
      AND to_regclass('audio_upload_chunks') IS NOT NULL
      AND to_regclass('generated_audio') IS NOT NULL AS schema_ready`,
  );
  // pg queries cannot be cancelled by a signal; the probe stops waiting instead.
  const aborted = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const rows = await Promise.race([probe, aborted]);
  return rows[0]?.ok === 1 && rows[0]?.schema_ready === true;
}

export function setDatabasePoolFactoryForTests(factory: ((config: PoolConfig) => DatabasePool) | undefined) {
  poolFactory = factory;
}

export function resetDatabaseForTests() {
  pool = null;
  schemaPromise = null;
}
