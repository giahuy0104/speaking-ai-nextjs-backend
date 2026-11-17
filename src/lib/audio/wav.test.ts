import assert from "node:assert/strict";
import { test } from "node:test";
import { isWav, pcmStreamToWav, WAV_HEADER_BYTES, wavHeader, withWavSizes } from "./wav";

const u32 = (bytes: Uint8Array, offset: number) => new DataView(bytes.buffer, bytes.byteOffset).getUint32(offset, true);
const u16 = (bytes: Uint8Array, offset: number) => new DataView(bytes.buffer, bytes.byteOffset).getUint16(offset, true);

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

test("the header describes 24 kHz mono 16-bit PCM", () => {
  const header = wavHeader(24_000, 4800);
  assert.equal(header.byteLength, WAV_HEADER_BYTES);
  assert.equal(u16(header, 20), 1, "PCM");
  assert.equal(u16(header, 22), 1, "mono");
  assert.equal(u32(header, 24), 24_000);
  assert.equal(u32(header, 28), 48_000, "byte rate");
  assert.equal(u16(header, 34), 16);
  assert.equal(u32(header, 4), 36 + 4800);
  assert.equal(u32(header, 40), 4800);
  assert.equal(u32(wavHeader(24_000), 40), 0xffffffff, "unknown length while streaming");
});

test("PCM passes through untouched, with the header only in front of the first audio", async () => {
  const chunks = await chunksOf(pcmStreamToWav(streamOf([new Uint8Array(0), new Uint8Array([1, 2]), new Uint8Array([3, 4])]), 24_000));
  assert.equal(chunks.length, 2, "an empty upstream chunk never sends the header alone");
  assert.equal(chunks[0].byteLength, WAV_HEADER_BYTES + 2);
  assert.ok(isWav(chunks[0]));
  assert.deepEqual([...chunks[0].subarray(WAV_HEADER_BYTES)], [1, 2]);
  assert.deepEqual([...chunks[1]], [3, 4]);
});

test("a stream with no audio emits nothing, so the caller can fall back", async () => {
  assert.deepEqual(await chunksOf(pcmStreamToWav(streamOf([]), 24_000)), []);
});

test("a finished streaming WAV gets its real sizes; other audio is left alone", () => {
  const streamed = new Uint8Array([...wavHeader(24_000), 1, 2, 3, 4]).buffer;
  const sized = new Uint8Array(withWavSizes(streamed));
  assert.equal(u32(sized, 4), sized.byteLength - 8);
  assert.equal(u32(sized, 40), 4);
  assert.equal(u32(new Uint8Array(streamed), 40), 0xffffffff, "the input is not mutated");

  const mp3 = new Uint8Array([0xff, 0xf3, 1, 2]).buffer;
  assert.equal(withWavSizes(mp3), mp3);
  const finished = new Uint8Array([...wavHeader(24_000, 2), 9, 9]).buffer;
  assert.equal(withWavSizes(finished), finished);
  assert.equal(isWav(mp3), false);
});
