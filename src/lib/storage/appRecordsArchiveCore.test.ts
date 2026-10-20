import assert from "node:assert/strict";
import test from "node:test";
import { exportVerifiedArchive } from "./appRecordsArchiveCore";

const job = { batch_id: "batch", bucket: "private", object_key: "archive.json",
  body: '{"records":[{"value":{"large":9007199254740993,"text":"Tiếng Việt"}}]}' };

test("deletes only after uploading and verifying the exact bytes, without JSON number coercion", async () => {
  const calls: string[] = [];
  const result = await exportVerifiedArchive(job, {
    upload: async (body) => { calls.push("upload"); assert.equal(body.toString(), job.body); },
    download: async () => { calls.push("verify"); return Buffer.from(job.body); },
    finalize: async () => { calls.push("delete"); return 49; },
  });
  assert.deepEqual(calls, ["upload", "verify", "delete"]);
  assert.equal(result.deleted, 49);
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
