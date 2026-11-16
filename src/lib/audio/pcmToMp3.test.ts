import assert from "node:assert/strict";
import { test } from "node:test";
import { encodePcmStreamToMp3 } from "./pcmToMp3";

const SAMPLE_RATE = 24_000;

function tone(seconds: number) {
  const samples = new Int16Array(Math.round(SAMPLE_RATE * seconds));
  for (let i = 0; i < samples.length; i++) samples[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE));
  return new Uint8Array(samples.buffer);
}

function streamOf(bytes: Uint8Array, chunkSize: number) {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) chunks.push(chunk);
  return chunks;
}

test("PCM is encoded to MP3 frames while it streams, not only at the end", async () => {
  const chunks = await collect(encodePcmStreamToMp3(streamOf(tone(2), 4800), SAMPLE_RATE));
  assert.ok(chunks.length > 2, "several MP3 chunks for 2 s of speech");
  // A Response body rejects anything but Uint8Array chunks (lamejs itself yields Int8Array).
  assert.ok(chunks.every(chunk => chunk instanceof Uint8Array));
  assert.ok((await new Response(encodePcmStreamToMp3(streamOf(tone(0.5), 4800), SAMPLE_RATE)).arrayBuffer()).byteLength > 0);
  const mp3 = Buffer.concat(chunks);
  // MPEG frame sync at the start of the clip.
  assert.equal(mp3[0], 0xff);
  assert.equal(mp3[1] & 0xe0, 0xe0);
  // 48 kbps for 2 s is ~12 KB.
  assert.ok(mp3.byteLength > 8_000 && mp3.byteLength < 16_000, `size ${mp3.byteLength}`);
});

test("a stream shorter than one encoder block still yields a playable clip", async () => {
  const chunks = await collect(encodePcmStreamToMp3(streamOf(tone(0.05), 400), SAMPLE_RATE));
  assert.ok(Buffer.concat(chunks).byteLength > 0);
});
