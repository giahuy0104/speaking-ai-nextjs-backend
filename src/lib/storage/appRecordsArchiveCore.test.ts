import assert from "node:assert/strict";
import test from "node:test";
import {
  ARCHIVE_POLICY_VERSION,
  createArchiveObjectKey,
  exportVerifiedArchive,
  isSafeArchiveJob,
  type ArchiveJob,
} from "./appRecordsArchiveCore";

test("archive filenames use Vietnam time regardless of the server timezone", () => {
  assert.equal(createArchiveObjectKey(new Date("2026-10-20T04:10:00Z"), "abc-def"),
    "archives/app_records/2026-10-20/20_10_2026_11h_10_abcdef.json");
});

test("archive filename and folder roll over together at Vietnam midnight", () => {
  assert.equal(createArchiveObjectKey(new Date("2026-12-31T17:00:00Z"), "abc-def"),
    "archives/app_records/2027-01-01/01_01_2027_00h_00_abcdef.json");
});

const job = { batch_id: "batch", bucket: "private", object_key: "archive.json",
  body: '{"records":[{"value":{"large":9007199254740993,"text":"Tiếng Việt"}}]}', record_count: 1 };

test("deletes only after uploading and verifying the exact bytes, without JSON number coercion", async () => {
  const calls: string[] = [];
  const result = await exportVerifiedArchive(job, {
    upload: async (body) => { calls.push("upload"); assert.equal(body.toString(), job.body); },
    download: async () => { calls.push("verify"); return Buffer.from(job.body); },
    finalize: async () => { calls.push("delete"); return 1; },
  });
  assert.deepEqual(calls, ["upload", "verify", "delete"]);
  assert.equal(result.deleted, 1);
  assert.equal(result.exported, 1);
});

const now = Date.parse("2026-10-29T00:00:00Z");
function policyJob(records: unknown[], policy = ARCHIVE_POLICY_VERSION): ArchiveJob {
  return { ...job, record_count: records.length, body: JSON.stringify({
    archive_policy: policy, batch_id: job.batch_id, record_count: records.length, records,
  }) };
}
const expiredPreparation = {
  namespace: "conversation_preparations_v1", record_key: "expired-preparation",
  expires_at: "2026-10-28T23:59:59Z",
};

test("accepts a partial batch containing only expired disposable preparations", () => {
  assert.equal(isSafeArchiveJob(policyJob([expiredPreparation]), now), true);
});

test("rejects active, renewed or malformed preparation expiry", () => {
  for (const expires_at of ["2026-10-29T00:00:01Z", null, "invalid"]) {
    assert.equal(isSafeArchiveJob(policyJob([{ ...expiredPreparation, expires_at }]), now), false);
  }
});

test("old and expired auth, profiles, history, rules and commit markers cannot be archived", () => {
  for (const namespace of ["installation_auth", "device_profiles", "conversation_history", "promoted_rules",
    "ai_text_cache", "conversation_preparation_commits_v1", "new_unreviewed_namespace"]) {
    assert.equal(isSafeArchiveJob(policyJob([{ ...expiredPreparation, namespace }]), now), false, namespace);
  }
});

test("rejects old-policy pending jobs, mixed snapshots and inconsistent record counts", () => {
  assert.equal(isSafeArchiveJob(job, now), false);
  assert.equal(isSafeArchiveJob(policyJob([expiredPreparation], "all-records-v1"), now), false);
  assert.equal(isSafeArchiveJob(policyJob([expiredPreparation, { ...expiredPreparation, namespace: "installation_auth" }]), now), false);
  assert.equal(isSafeArchiveJob({ ...policyJob([expiredPreparation]), record_count: 50 }, now), false);
  assert.equal(isSafeArchiveJob(policyJob([]), now), false);
  assert.equal(isSafeArchiveJob(policyJob(Array(51).fill(expiredPreparation)), now), false);
});

for (const failure of ["upload", "download", "mismatch"] as const) {
  test(`never deletes when ${failure} fails`, async () => {
    let deleted = false;
    await assert.rejects(exportVerifiedArchive(job, {
      upload: async () => { if (failure === "upload") throw new Error("network"); },
      download: async () => {
        if (failure === "download") throw new Error("network");
        return Buffer.from("corrupt");
      },
      finalize: async () => { deleted = true; return 50; },
    }));
    assert.equal(deleted, false);
  });
}

test("does not report success when finalization loses its lease", async () => {
  await assert.rejects(exportVerifiedArchive(job, {
    upload: async () => {}, download: async () => Buffer.from(job.body),
    finalize: async () => { throw new Error("lease lost"); },
  }), /lease lost/);
});
