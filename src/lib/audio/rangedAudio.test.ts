import assert from "node:assert/strict";
import { test } from "node:test";
import { isBoundedRangeRequest, parseByteRange, rangedAudioResponse } from "./rangedAudio";

const audio = Uint8Array.from({ length: 10 }, (_, index) => index);

test("parseByteRange reads start-end, open-ended and suffix ranges", () => {
  assert.equal(parseByteRange(null, 10), null);
  assert.deepEqual(parseByteRange("bytes=0-1", 10), { start: 0, end: 1 });
  assert.deepEqual(parseByteRange("bytes=4-", 10), { start: 4, end: 9 });
  assert.deepEqual(parseByteRange("bytes=-3", 10), { start: 7, end: 9 });
  assert.deepEqual(parseByteRange("bytes=8-99", 10), { start: 8, end: 9 });
});

test("parseByteRange rejects unsatisfiable or malformed ranges", () => {
  assert.equal(parseByteRange("bytes=10-12", 10), "invalid");
  assert.equal(parseByteRange("bytes=5-2", 10), "invalid");
  assert.equal(parseByteRange("bytes=-", 10), "invalid");
  assert.equal(parseByteRange("items=0-1", 10), "invalid");
});

test("isBoundedRangeRequest is true for AVPlayer's probe, false for open-ended reads", () => {
  assert.equal(isBoundedRangeRequest("bytes=0-1"), true);
  assert.equal(isBoundedRangeRequest("bytes=0-65535"), true);
  assert.equal(isBoundedRangeRequest("bytes=0-"), false);
  assert.equal(isBoundedRangeRequest(null), false);
});

test("rangedAudioResponse answers a range probe with 206 and the total length", async () => {
  const response = rangedAudioResponse(audio, "bytes=0-1", { "Content-Type": "audio/wav" });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 0-1/10");
  assert.equal(response.headers.get("content-length"), "2");
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(response.headers.get("content-type"), "audio/wav");
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [0, 1]);
});

test("rangedAudioResponse sends the whole file with its length when there is no range", async () => {
  const response = rangedAudioResponse(audio, null, { "Content-Type": "audio/mpeg" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-length"), "10");
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal((await response.arrayBuffer()).byteLength, 10);
});

test("rangedAudioResponse returns 416 for an unsatisfiable range", () => {
  const response = rangedAudioResponse(audio, "bytes=20-30", {});
  assert.equal(response.status, 416);
  assert.equal(response.headers.get("content-range"), "bytes */10");
});

test("rangedAudioResponse can omit the body for HEAD", () => {
  const response = rangedAudioResponse(audio, "bytes=0-1", {}, false);
  assert.equal(response.status, 206);
  assert.equal(response.body, null);
});
