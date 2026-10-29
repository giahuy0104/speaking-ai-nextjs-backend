import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

// Exercise the production coordinator with database/R2 boundaries replaced.
// This intentionally never connects to the configured development database.
const harness = String.raw`
const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
const scenario = process.env.ARCHIVE_TEST_SCENARIO;
const queries = [];
let uploads = 0;
let stored;
let job;
process.env.APP_RECORDS_ARCHIVE_R2_BUCKET = 'archive-test-private';
const row = { namespace: 'conversation_preparations_v1', record_key: 'expired-preparation',
  expires_at: '2020-01-01T00:00:00Z' };
const buildJob = (batchId) => ({ batch_id: batchId, bucket: 'archive-test-private', object_key: 'archive.json', record_count: 1,
  body: JSON.stringify({ archive_policy: 'expired-preparations-v1', batch_id: batchId, record_count: 1, records: [row] }) });
const db = {
  isPostgresStorageEnabled: () => true,
  queryDatabase: async (sql, params = []) => {
    queries.push({sql, params});
    if (sql.startsWith('UPDATE app_records_archive_job')) {
      if (scenario === 'unsafe-pending') {
        job = {...buildJob('legacy-batch'), body: JSON.stringify({ records: [{namespace: 'installation_auth'}] })};
        return [job];
      }
      return [];
    }
    if (sql.startsWith('WITH oldest')) {
      assert.deepEqual(params[4], ['conversation_preparations_v1']);
      assert.match(sql, /namespace = ANY\(\$5::text\[\]\) AND expires_at <= NOW\(\)/);
      assert.match(sql, /HAVING COUNT\(\*\) > 0/);
      assert.equal(params[5], 'expired-preparations-v1');
      if (scenario === 'empty') return [];
      job = buildJob(params[0]);
      return [job];
    }
    if (sql.startsWith('DELETE FROM app_records_archive_job')) {
      assert.match(sql, /owner = \$1 AND lease_until > NOW\(\)/);
      return [{ batch_id: job.batch_id }];
    }
    if (sql.startsWith('WITH owned')) {
      assert.equal(uploads, 1, 'finalize must follow the verified upload');
      assert.match(sql, /lease_until > NOW\(\)/);
      assert.match(sql, /body::jsonb->>'archive_policy' = \$3/);
      assert.match(sql, /r.namespace = ANY\(\$2::text\[\]\) AND r.expires_at <= NOW\(\)/);
      assert.match(sql, /r.xmin::text = s->>'version'/);
      assert.match(sql, /to_jsonb\(r\) = s->'row'/);
      assert.deepEqual(params[1], ['conversation_preparations_v1']);
      assert.equal(params[2], 'expired-preparations-v1');
      return [{ deleted: 0 }]; // A concurrently renewed preparation is not the original snapshot.
    }
    throw new Error('Unexpected database operation');
  }
};
const r2 = {
  getR2Client: () => {
    assert.notEqual(scenario, 'unsafe-pending', 'old credential snapshots must not reach R2');
    return { send: async command => {
      if ('Body' in command.input) { uploads++; stored = Buffer.from(command.input.Body); return {}; }
      return {Body: {transformToByteArray: async () => stored}};
    }};
  },
  isR2PreconditionFailed: () => false,
};
Module._load = function(id, ...args) {
  if (id === '@/lib/db') return db;
  if (id === '@/lib/storage/r2') return r2;
  return originalLoad.call(this, id, ...args);
};
(async () => {
  const {archiveAppRecords} = require('./src/lib/storage/appRecordsArchive.ts');
  const result = await archiveAppRecords();
  if (scenario === 'unsafe-pending') {
    assert.deepEqual(result, {status: 'skipped', reason: 'unsafe_pending_archive_cancelled'});
    assert.equal(uploads, 0);
    assert.equal(queries.length, 2);
    assert.ok(queries.every(({sql}) => !sql.includes('DELETE FROM app_records r')));
  } else if (scenario === 'empty') {
    assert.deepEqual(result, {status: 'skipped', reason: 'busy_or_no_expired_records'});
    assert.equal(uploads, 0);
  } else {
    assert.equal(result.status, 'archived');
    assert.equal(result.exported, 1);
    assert.equal(result.deleted, 0);
    assert.equal(uploads, 1);
  }
})().catch(error => {console.error(error);process.exitCode = 1;});
`;

for (const [scenario, name] of [
  ["unsafe-pending", "cancels an old all-namespace archive without uploading or deleting application records"],
  ["partial", "archives a partial batch and retains expiry, namespace, snapshot and lease guards at finalization"],
  ["empty", "skips an empty eligible set without uploading an archive"],
] as const) {
  test(name, () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=commonjs", "-e", harness], {
      cwd: process.cwd(), env: { ...process.env, ARCHIVE_TEST_SCENARIO: scenario },
      encoding: "utf8", timeout: 20_000, windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
}
