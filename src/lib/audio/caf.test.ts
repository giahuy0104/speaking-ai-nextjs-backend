import assert from "node:assert/strict";
import { test } from "node:test";
import { CAF_HEADER_BYTES, cafHeader, rewrapWavStreamAsCaf } from "./caf";
import { WAV_HEADER_BYTES, pcmStreamToWav } from "./wav";

const u32be = (bytes: Uint8Array, offset: number) => new DataView(bytes.buffer, bytes.byteOffset).getUint32(offset, false);
const f64be = (bytes: Uint8Array, offset: number) => new DataView(bytes.buffer, bytes.byteOffset).getFloat64(offset, false);
const i64be = (bytes: Uint8Array, offset: number) => new DataView(bytes.buffer, bytes.byteOffset).getBigInt64(offset, false);
const ascii = (bytes: Uint8Array, offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length));

function streamOf(chunks: Uint8Array[]) {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) return controller.close();
      controller.enqueue(chunks[index++]);
    },
  });
}

async function chunksOf(stream: ReadableStream<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return chunks;
    chunks.push(value);
  }
}

test("the header describes 24 kHz mono 16-bit little-endian PCM, unknown length", () => {
  const header = cafHeader(24_000);
  assert.equal(header.byteLength, CAF_HEADER_BYTES);
  assert.equal(ascii(header, 0, 4), "caff");
  assert.equal(ascii(header, 8, 4), "desc");
  assert.equal(i64be(header, 12), BigInt(32), "desc chunk body size");
  assert.equal(f64be(header, 20), 24_000);
  assert.equal(ascii(header, 28, 4), "lpcm");
  assert.equal(u32be(header, 32), 0x2, "signed int, little-endian samples");
  assert.equal(u32be(header, 36), 2, "bytes per packet (mono 16-bit)");
  assert.equal(u32be(header, 40), 1, "frames per packet");
  assert.equal(u32be(header, 44), 1, "channels per frame");
  assert.equal(u32be(header, 48), 16, "bits per channel");
  assert.equal(ascii(header, 52, 4), "data");
  assert.equal(i64be(header, 56), BigInt(-1), "unknown length while streaming");
  assert.equal(u32be(header, 64), 0, "mEditCount");
});

test("rewraps a live WAV stream as CAF: same PCM bytes, new header, correct sample rate", async () => {
  const wav = pcmStreamToWav(streamOf([new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6])]), 16_000);
  const chunks = await chunksOf(rewrapWavStreamAsCaf(wav));
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].byteLength, CAF_HEADER_BYTES + 4);
  const header = chunks[0].subarray(0, CAF_HEADER_BYTES);
  assert.equal(ascii(header, 0, 4), "caff");
  assert.equal(f64be(header, 20), 16_000, "sample rate read back out of the WAV header");
  assert.equal(i64be(header, 56), BigInt(-1));
  assert.deepEqual([...chunks[0].subarray(CAF_HEADER_BYTES)], [1, 2, 3, 4]);
  assert.deepEqual([...chunks[1]], [5, 6]);
});

test("still rewraps correctly when the WAV header arrives split across reads", async () => {
  const wav = pcmStreamToWav(streamOf([new Uint8Array([9])]), 24_000);
  const wavChunks = await chunksOf(wav);
  const whole = wavChunks[0];
  assert.equal(whole.byteLength, WAV_HEADER_BYTES + 1);
  const split = streamOf([whole.subarray(0, 10), whole.subarray(10)]);
  const chunks = await chunksOf(rewrapWavStreamAsCaf(split));
  const combined = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  assert.equal(combined.byteLength, CAF_HEADER_BYTES + 1);
  assert.deepEqual([...combined.subarray(CAF_HEADER_BYTES)], [9]);
});

test("a stream with no audio emits nothing, so the caller can fall back", async () => {
  assert.deepEqual(await chunksOf(rewrapWavStreamAsCaf(pcmStreamToWav(streamOf([]), 24_000))), []);
});
