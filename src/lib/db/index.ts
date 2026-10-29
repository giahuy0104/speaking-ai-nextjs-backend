import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { managedStorageSchemaStatements } from "@/lib/db/schema";
import { getPersistenceBackend } from "@/lib/storage/config";

type DatabaseRow = Record<string, unknown>;

let databaseClient: NeonQueryFunction<false, false> | null = null;
let schemaPromise: Promise<void> | null = null;

export function isPostgresStorageEnabled() {
  return getPersistenceBackend() === "postgres";
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

function getDatabaseClient() {
  if (!databaseClient) {
    databaseClient = neon(getDatabaseUrl(), {
      fetchOptions: { cache: "no-store" },
    });
  }

  return databaseClient;
}

async function queryWithoutSchema<T extends DatabaseRow>(
  query: string,
  params: unknown[] = [],
) {
  return (await getDatabaseClient().query(query, params)) as T[];
}

export async function ensureDatabaseSchema() {
  if (!isPostgresStorageEnabled()) {
    return;
  }

  if (!schemaPromise) {
    // Neon can submit every idempotent DDL statement in one HTTP transaction.
    // Sending them one-by-one added one remote round trip per statement to the
    // first audio request of every cold server instance.
    schemaPromise = getDatabaseClient()
      .transaction((transaction) =>
        managedStorageSchemaStatements.map((statement) =>
          transaction.query(statement),
        ),
      )
      .then(() => undefined)
      .catch((error) => {
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
  const rows = await getDatabaseClient().query(
    `SELECT 1 AS ok,
      to_regclass('app_records') IS NOT NULL
      AND to_regclass('audio_upload_sessions') IS NOT NULL
      AND to_regclass('audio_upload_chunks') IS NOT NULL
      AND to_regclass('generated_audio') IS NOT NULL AS schema_ready`,
    [],
    { fetchOptions: { signal, cache: "no-store" } },
  ) as { ok: number; schema_ready: boolean }[];
  return rows[0]?.ok === 1 && rows[0]?.schema_ready === true;
}

export function resetDatabaseForTests() {
  databaseClient = null;
  schemaPromise = null;
}
