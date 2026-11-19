import assert from "node:assert/strict";
import { test } from "node:test";
import { wavHeader } from "@/lib/audio/wav";
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

const u32 = (bytes: Uint8Array, offset: number) => new DataView(bytes.buffer, bytes.byteOffset).getUint32(offset, true);
const ascii = (bytes: Uint8Array, offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));

test("a listener streams uncompressed WAV while it is produced, and the cache gets the same audio with real sizes", async () => {
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
  const pcmBytes = Math.round(SAMPLE_RATE * 1.5) * 2;
  assert.equal(heard.byteLength, 44 + pcmBytes, "PCM is passed through, not compressed");
  assert.equal(ascii(heard, 0), "RIFF");
  assert.equal(ascii(heard, 8), "WAVE");
  assert.equal(u32(heard, 24), SAMPLE_RATE);
  assert.equal(u32(heard, 40), 0xffffffff, "the live stream does not know its length yet");
  assert.deepEqual(heard.subarray(44), cached.subarray(44), "the cache holds the same audio");
  assert.equal(u32(cached, 4), cached.byteLength - 8);
  assert.equal(u32(cached, 40), pcmBytes);
  assert.equal(fallbacks, 0);
  assert.equal(streams.subscribe("今天我很开心。", "zh"), null, "a settled clip is served by the coordinator, not the stream");
});

test("a stream that fails before its first byte falls back to the finished clip", async () => {
  const clip = new Uint8Array([...wavHeader(SAMPLE_RATE, 4), 1, 2, 3, 4]);
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

test("a stream refused because the provider is busy does not try the fallback, which would hit the same limit", async () => {
  let fallbacks = 0;
  const busy = Object.assign(new Error("busy"), { reason: "queue_timeout" });
  const streams = createTargetSpeechStreams({
    openPcm: async () => { throw busy; },
    fallback: async () => { fallbacks++; return new ArrayBuffer(1); },
    shouldFallback: error => (error as { reason?: string }).reason !== "queue_timeout",
    log: quiet,
  });
  await assert.rejects(streams.start("今天我很开心。", "zh"), /busy/);
  assert.equal(fallbacks, 0);
});

test("a listener waiting for the first byte gets the refusal as an error, not an empty stream", async () => {
  const busy = Object.assign(new Error("busy"), { reason: "rate_limited" });
  const streams = createTargetSpeechStreams({
    openPcm: async () => { throw busy; },
    fallback: async () => new ArrayBuffer(1),
    shouldFallback: () => false,
    toPublicError: () => new Error("TTS_FAILED 429"),
    log: quiet,
  });
  const completed = streams.start("今天我很开心。", "zh");
  await assert.rejects(streams.subscribeWhenAudible("今天我很开心。", "zh"), /TTS_FAILED 429/);
  await assert.rejects(completed, /TTS_FAILED 429/);
  assert.equal(await streams.subscribeWhenAudible("今天我很开心。", "zh"), null, "a settled failure has no live stream");
});

test("a refused stream falls back per language, and a listener waiting for the first byte gets the whole clip", async () => {
  const clip = new Uint8Array([...wavHeader(SAMPLE_RATE, 4), 1, 2, 3, 4]);
  const decisions: string[] = [];
  const fellBack: string[] = [];
  const streams = createTargetSpeechStreams({
    openPcm: async () => { throw Object.assign(new Error("rate_limited"), { reason: "rate_limited" }); },
    fallback: async () => clip.slice().buffer,
    shouldFallback: (_error, language) => { decisions.push(language); return language === "zh"; },
    onFallback: (text, language) => fellBack.push(`${language}:${text}`),
    log: quiet,
  });
  const completed = streams.start("今天我很开心。", "zh");
  const listener = await streams.subscribeWhenAudible("今天我很开心。", "zh");
  assert.ok(listener);
  assert.deepEqual(await bytesOf(listener), clip, "the clip settled meanwhile, yet the listener gets every byte");
  assert.deepEqual(new Uint8Array(await completed), clip);
  await assert.rejects(streams.start("Bonjour.", "fr"), /rate_limited/);
  assert.deepEqual(decisions, ["zh", "fr"]);
  assert.deepEqual(fellBack, ["zh:今天我很开心。"]);
});

test("onFallback tells a sentence's shared stream from one started under its own key", async () => {
  const clip = new Uint8Array([...wavHeader(SAMPLE_RATE, 4), 1, 2, 3, 4]);
  const fellBack: Array<{ text: string; shared: boolean }> = [];
  const streams = createTargetSpeechStreams({
    openPcm: async () => { throw new Error("rate_limited"); },
    fallback: async () => clip.slice().buffer,
    onFallback: (text, _language, { shared }) => fellBack.push({ text, shared }),
    log: quiet,
  });
  await streams.start("今天我很开心。", "zh");
  await streams.start("今天我很开心。", "zh", "uncached\nturn-1");
  assert.deepEqual(fellBack, [
    { text: "今天我很开心。", shared: true },
    { text: "今天我很开心。", shared: false },
  ]);
});

test("a listener waiting for the first byte of a live stream gets the whole stream", async () => {
  const streams = createTargetSpeechStreams({
    openPcm: async () => ({ pcm: pcmOf(0.5), sampleRate: SAMPLE_RATE }),
    fallback: async () => new ArrayBuffer(1),
    log: quiet,
  });
  const completed = streams.start("안녕하세요.", "ko");
  const listener = await streams.subscribeWhenAudible("안녕하세요.", "ko");
  assert.ok(listener);
  const heard = await bytesOf(listener);
  assert.equal(heard.byteLength, 44 + Math.round(SAMPLE_RATE * 0.5) * 2);
  await completed;
});
