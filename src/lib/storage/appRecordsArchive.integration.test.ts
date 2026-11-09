import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const container = "speaking-ai-archive-test";
const label = "speaking-ai.archive-test=true";

// This adapter executes the production coordinator's SQL against a disposable
// PostgreSQL server, including the real DDL, xmin and data-modifying CTEs.
// R2 is replaced so the regression never sends user data to an external service.
const harness = String.raw`
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const Module = require('node:module');
const originalLoad = Module._load;
const container = process.env.APP_RECORDS_ARCHIVE_TEST_CONTAINER;
const literal = value => {
  if (value === null || value === undefined) return 'NULL';
  if (Array.isArray(value)) return 'ARRAY[' + value.map(literal).join(',') + ']::text[]';
  if (typeof value === 'number') { assert.ok(Number.isFinite(value)); return String(value); }
  return "'" + String(value).replaceAll("'", "''") + "'";
};
function parseCsv(text) {
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && c === ',') { row.push(field); field = ''; }
    else if (!quoted && c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (quoted || c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows.shift();
  return rows.filter(row => row.length === headers.length).map(row => Object.fromEntries(
    headers.map((key, i) => [key, ['record_count', 'deleted', 'count'].includes(key) ? Number(row[i]) : row[i]])));
}
function sql(statement, params = []) {
  const query = statement.replace(/\$(\d+)\b/g, (_, index) => literal(params[Number(index) - 1]));
  const result = spawnSync('docker', ['exec', '-i', container, 'psql', '-X', '-q', '--csv',
    '-P', 'footer=off', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'], {
    input: 'SET search_path=archive_policy_test;\n' + query + ';\n', encoding: 'utf8', timeout: 15_000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return parseCsv(result.stdout);
}
let uploads = 0, stored, uploadAction;
const db = {isPostgresStorageEnabled: () => true, queryDatabase: async (query, params) => sql(query, params)};
const r2 = {
  getR2Client: () => ({send: async command => {
    if ('Body' in command.input) {
      uploads++; stored = Buffer.from(command.input.Body);
      if (uploadAction) await uploadAction();
      return {};
    }
    return {Body: {transformToByteArray: async () => stored}};
  }}),
  isR2PreconditionFailed: () => false,
};
Module._load = function(id, ...args) {
  if (id === '@/lib/db') return db;
  if (id === '@/lib/storage/r2') return r2;
  return originalLoad.call(this, id, ...args);
};
const count = where => sql('SELECT COUNT(*)::integer AS count FROM app_records WHERE ' + where)[0].count;
const add = (key, namespace, expired = true) => sql(
  "INSERT INTO app_records (namespace, record_key, created_at, expires_at, value) " +
  "VALUES ($1, $2, NOW() - INTERVAL '2 days', NOW() + " + (expired ? "INTERVAL '-1 hour'" : "INTERVAL '1 hour'") +
  ", jsonb_build_object('test', true))", [namespace, key]);
(async () => {
  sql('CREATE SCHEMA archive_policy_test');
  const {managedStorageSchemaStatements} = require('./src/lib/db/schema.ts');
  for (const statement of managedStorageSchemaStatements) sql(statement);
  process.env.APP_RECORDS_ARCHIVE_R2_BUCKET = 'archive-test-private';
  const {archiveAppRecords} = require('./src/lib/storage/appRecordsArchive.ts');
  const protectedNamespaces = ['installation_auth', 'device_profiles', 'conversation_history', 'promoted_rules',
    'ai_text_cache', 'conversation_preparation_commits_v1', 'future_namespace'];
  protectedNamespaces.forEach(namespace => add('protected-' + namespace, namespace));
  add('live', 'conversation_preparations_v1', false);
  add('renewed', 'conversation_preparations_v1');
  add('expired', 'conversation_preparations_v1');
  uploadAction = () => sql("UPDATE app_records SET expires_at=NOW()+INTERVAL '1 hour', revision=revision+1 " +
    "WHERE record_key='renewed'");
  const archived = await archiveAppRecords();
  assert.equal(archived.status, 'archived');
  assert.equal(archived.exported, 2);
  assert.equal(archived.deleted, 1);
  assert.equal(count("record_key='expired'"), 0);
  assert.equal(count("record_key='renewed'"), 1);
  assert.equal(count("record_key='live'"), 1);
  assert.equal(count("namespace <> 'conversation_preparations_v1'"), protectedNamespaces.length);
  assert.deepEqual(JSON.parse(stored.toString()).records.map(row => row.record_key).sort(), ['expired', 'renewed']);
  assert.equal(sql('SELECT COUNT(*)::integer AS count FROM app_records_archive_job')[0].count, 0);
  const empty = await archiveAppRecords();
  assert.equal(empty.reason, 'busy_or_no_expired_records');
  assert.equal(uploads, 1, 'a completed batch must not be exported repeatedly');

  // A pending snapshot from the old policy may contain credential rows. Claim
  // and cancel the queue entry, preserving both app_records and remote storage.
  sql("INSERT INTO app_records_archive_job (id,batch_id,bucket,object_key,body,snapshot,owner,lease_until) " +
    "SELECT 1,'legacy','private','old.json',jsonb_build_object('export_version',1,'records',jsonb_agg(to_jsonb(r)))::text," +
    "jsonb_agg(jsonb_build_object('row',to_jsonb(r),'version',r.xmin::text)),'old-worker',NOW()-INTERVAL '1 minute' " +
    "FROM app_records r WHERE namespace='installation_auth'");
  const cancelled = await archiveAppRecords();
  assert.equal(cancelled.reason, 'unsafe_pending_archive_cancelled');
  assert.equal(count("namespace='installation_auth'"), 1);
  assert.equal(uploads, 1);
  assert.equal(sql('SELECT COUNT(*)::integer AS count FROM app_records_archive_job')[0].count, 0);

  // Upload failure leaves the source row and durable snapshot for a safe retry.
  add('retry', 'conversation_preparations_v1');
  uploadAction = () => {throw Error('test-provider-unavailable');};
  await assert.rejects(archiveAppRecords(), /test-provider-unavailable/);
  assert.equal(count("record_key='retry'"), 1);
  assert.equal(sql('SELECT COUNT(*)::integer AS count FROM app_records_archive_job')[0].count, 1);
  uploadAction = undefined;
  const retried = await archiveAppRecords();
  assert.equal(retried.exported, 1);
  assert.equal(retried.deleted, 1);
  assert.equal(count("record_key='retry'"), 0);

  // An expired worker cannot finalize after a different owner has taken over.
  add('lease-lost', 'conversation_preparations_v1');
  uploadAction = () => sql("UPDATE app_records_archive_job SET owner='another-worker'");
  await assert.rejects(archiveAppRecords(), /lease lost/);
  assert.equal(count("record_key='lease-lost'"), 1);
  assert.equal(count("namespace <> 'conversation_preparations_v1'"), protectedNamespaces.length);
  console.log('POSTGRES_ARCHIVE_POLICY=PASS');
})().catch(error => {console.error(error);process.exitCode=1;});
`;

test("PostgreSQL archive policy integration (isolated Docker only)", {
  skip: process.env.APP_RECORDS_ARCHIVE_DOCKER_TEST !== "true",
  timeout: 120_000,
}, async (t) => {
  const docker = (args: string[]) => spawnSync("docker", args, {
    encoding: "utf8", timeout: 30_000, windowsHide: true,
  });
  const existing = docker(["container", "inspect", container]);
  assert.notEqual(existing.status, 0, `Refusing to reuse or remove an existing ${container} container.`);
  const started = docker(["run", "--detach", "--name", container, "--label", label, "--network", "none",
    "--tmpfs", "/var/lib/postgresql/data:rw,noexec,nosuid,size=256m",
    "--env", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17-alpine"]);
  assert.equal(started.status, 0, started.stderr);
  t.after(() => {
    const inspect = docker(["container", "inspect", "--format", '{{index .Config.Labels "speaking-ai.archive-test"}}', container]);
    if (inspect.status === 0 && inspect.stdout.trim() === "true") {
      const removed = docker(["rm", "--force", container]);
      assert.equal(removed.status, 0, removed.stderr);
    }
  });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    // The image's initialization server listens on its Unix socket only.
    // TCP readiness waits for the final server, avoiding its shutdown window.
    if (docker(["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]).status === 0) { ready = true; break; }
    await delay(100);
  }
  assert.ok(ready, "Dedicated PostgreSQL test container did not become ready.");
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=commonjs", "-e", harness], {
    cwd: process.cwd(), env: { ...process.env, APP_RECORDS_ARCHIVE_TEST_CONTAINER: container },
    encoding: "utf8", timeout: 90_000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /POSTGRES_ARCHIVE_POLICY=PASS/);
});
