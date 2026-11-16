import assert from "node:assert/strict";
import { test } from "node:test";
import { createTargetSpeechStreams } from "./targetSpeechStreams";

const SAMPLE_RATE = 24_000;
const quiet = () => undefined;

function pcmOf(seconds: number, failAfterChunks?: number) {
  const bytes = new Uint8Array(Math.round(SAMPLE_RATE * seconds) * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < bytes.byteLength / 2; i++) view.setInt16(i * 2, Math.round(6000 * Math.sin(i / 8)), true);
  let offset = 0;
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (failAfterChunks !== undefined && sent === failAfterChunks) return controller.error(new Error("upstream cut"));
      if (offset >= bytes.byteLength) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + 9600));
      offset += 9600;
      sent++;
    },
  });
}

const bytesOf = async (stream: ReadableStream<Uint8Array>) => new Uint8Array(await new Response(stream).arrayBuffer());

test("a listener streams the MP3 while it is produced, and the cache gets the same clip", async () => {
  let fallbacks = 0;
  const streams = createTargetSpeechStreams({
    openPcm: async () => ({ pcm: pcmOf(1.5), sampleRate: SAMPLE_RATE }),
    fallback: async () => { fallbacks++; return new ArrayBuffer(1); },
    log: quiet,
  });
  const completed = streams.start("今天我很开心。", "zh");
  const listener = streams.subscribe("今天我很开心。", "zh");
  assert.ok(listener, "a live stream is available right after start");
  assert.equal(streams.subscribe("今天我很开心。", "ja"), null, "the language is part of the key");

  const heard = await bytesOf(listener);
  const cached = new Uint8Array(await completed);
  assert.deepEqual(heard, cached);
  assert.equal(heard[0], 0xff);
  assert.equal(fallbacks, 0);
  assert.equal(streams.subscribe("今天我很开心。", "zh"), null, "a settled clip is served by the coordinator, not the stream");
});

test("a stream that fails before its first byte falls back to the finished clip", async () => {
  const clip = new Uint8Array([0xff, 0xf3, 1, 2, 3]);
  const streams = createTargetSpeechStreams({
    openPcm: async () => { throw new Error("rate_limited"); },
    fallback: async () => clip.slice().buffer,
    log: quiet,
  });
  const completed = streams.start("Bonjour.", "fr");
  const listener = streams.subscribe("Bonjour.", "fr")!;
  assert.deepEqual(await bytesOf(listener), clip);
  assert.deepEqual(new Uint8Array(await completed), clip);
});

test("a stream cut after audio was sent fails instead of splicing in another take", async () => {
  let fallbacks = 0;
  const streams = createTargetSpeechStreams({
    openPcm: async () => ({ pcm: pcmOf(3, 3), sampleRate: SAMPLE_RATE }),
    fallback: async () => { fallbacks++; return new ArrayBuffer(4); },
    toPublicError: () => new Error("TTS_FAILED"),
    log: quiet,
  });
  const completed = streams.start("안녕하세요.", "ko");
  const listener = streams.subscribe("안녕하세요.", "ko")!;
  await assert.rejects(bytesOf(listener), /TTS_FAILED/);
  await assert.rejects(completed, /TTS_FAILED/);
  assert.equal(fallbacks, 0);
});
