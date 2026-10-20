import assert from "node:assert/strict";
import test from "node:test";
import { createArchiveObjectKey, exportVerifiedArchive } from "./appRecordsArchiveCore";

test("archive filenames use Vietnam time regardless of the server timezone", () => {
  assert.equal(createArchiveObjectKey(new Date("2026-10-20T04:10:00Z"), "abc-def"),
    "archives/app_records/2026-10-20/20_10_2026_11h_10_abcdef.json");
});

test("archive filename and folder roll over together at Vietnam midnight", () => {
  assert.equal(createArchiveObjectKey(new Date("2026-12-31T17:00:00Z"), "abc-def"),
    "archives/app_records/2027-01-01/01_01_2027_00h_00_abcdef.json");
});

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
