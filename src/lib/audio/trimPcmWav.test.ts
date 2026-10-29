import assert from "node:assert/strict";
import test from "node:test";
import { encodeMonoPcm16Wav } from "./trimRecordedAudio";
import { trimPcmWav } from "./trimPcmWav";

test("conservative WAV trimming removes edge silence while retaining exact speech samples", async () => {
  const rate = 16000; const samples = new Float32Array(rate * 3);
  for (let i = rate; i < rate * 2; i++) samples[i] = .2 * Math.sin(i / 7);
  const original = await encodeMonoPcm16Wav([samples], rate, 0, samples.length).arrayBuffer();
  const trimmed = trimPcmWav(original);
  assert.ok(trimmed.savedBytes > rate * 2);
  const pcm = Buffer.from(original).subarray(44); const output = Buffer.from(trimmed.bytes).subarray(44);
  const speech = pcm.subarray(rate * 2, rate * 4);
  assert.ok(output.includes(speech));
});
test("quiet speech, unsupported audio and malformed WAV pass through unchanged", async () => {
  const silent = await encodeMonoPcm16Wav([new Float32Array(16000)], 16000, 0, 16000).arrayBuffer();
  for (const bytes of [silent, new ArrayBuffer(20)]) { assert.equal(trimPcmWav(bytes).bytes, bytes); assert.equal(trimPcmWav(bytes).savedBytes, 0); }
  const malformed = silent.slice(0); new DataView(malformed).setUint32(40, 0xffffffff, true);
  assert.equal(trimPcmWav(malformed).bytes, malformed);
});
