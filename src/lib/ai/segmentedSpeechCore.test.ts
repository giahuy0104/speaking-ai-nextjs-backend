import assert from "node:assert/strict";
import test from "node:test";
import { pcmStreamToWav, wavHeader } from "@/lib/audio/wav";
import {
  createSegmentedAudioUrl,
  createWavHeaderStripper,
  joinSegmentWavs,
  splitSpeechSegments,
  verifySegmentedAudioUrl,
  wavToPcm,
  type SegmentAudio,
} from "./segmentedSpeechCore";

const RATE = 24_000;
const SECRET_ENV = { INSTALLATION_AUTH_SECRET: "x".repeat(40), AUDIO_STREAM_NODE: "3001" };

function pcmOf(value: number, samples: number) {
  const pcm = new Uint8Array(samples * 2);
  for (let i = 0; i < samples; i++) pcm[i * 2] = value;
  return pcm;
}

function finishedWav(pcm: Uint8Array, rate = RATE) {
  const out = new Uint8Array(44 + pcm.byteLength);
  out.set(wavHeader(rate, pcm.byteLength), 0);
  out.set(pcm, 44);
  return out;
}

/** A segment still being synthesized: its live WAV arrives in several chunks. */
function liveSegment(chunks: Uint8Array[], rate = RATE): SegmentAudio {
  const all = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
  return {
    live: () => pcmStreamToWav(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }), rate),
    finished: Promise.resolve(finishedWav(all, rate).buffer as ArrayBuffer),
  };
}

/** A segment that has already settled: no live stream any more. */
function settledSegment(pcm: Uint8Array, rate = RATE): SegmentAudio {
  return { live: () => null, finished: Promise.resolve(finishedWav(pcm, rate).buffer as ArrayBuffer) };
}

async function readAll(stream: ReadableStream<Uint8Array>) {
  const parts: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.byteLength; }
  return out;
}

test("splits a translation after clauses and joins short pieces to a neighbour", () => {
  assert.deepEqual(
    splitSpeechSegments("I'm so tired now, I want to go to sleep and stop working.", "en"),
    ["I'm so tired now,", "I want to go to sleep and stop working."],
  );
  assert.deepEqual(splitSpeechSegments("我现在很累，我想去睡觉，明天再工作。", "zh"), ["我现在很累，", "我想去睡觉，", "明天再工作。"]);
  // "please?" alone is too short to be spoken on its own.
  assert.deepEqual(splitSpeechSegments("Can you say that again, please?", "en"), ["Can you say that again, please?"]);
  assert.deepEqual(splitSpeechSegments("Flower", "en"), ["Flower"]);
  assert.deepEqual(splitSpeechSegments("   ", "en"), []);
});

test("never returns more than the segment limit, keeping every word in order", () => {
  const text = "One two three four, five six seven eight, nine ten eleven, twelve thirteen fourteen, fifteen sixteen.";
  const segments = splitSpeechSegments(text, "en", 3);

  assert.equal(segments.length, 3);
  assert.equal(segments.join(" "), text);
});

test("strips a header that arrives split across chunks and one with extra chunks", () => {
  const stripper = createWavHeaderStripper();
  const wav = finishedWav(pcmOf(7, 4));
  assert.equal(stripper.push(wav.subarray(0, 20)).byteLength, 0);
  assert.deepEqual([...stripper.push(wav.subarray(20))], [...pcmOf(7, 4)]);

  // A LIST chunk before data (some providers add one).
  const list = [..."LIST"].map((c) => c.charCodeAt(0)).concat([4, 0, 0, 0, 1, 2, 3, 4]);
  const header = wavHeader(RATE, 8);
  const withList = new Uint8Array([...header.subarray(0, 36), ...list, ...header.subarray(36), ...pcmOf(9, 4)]);
  const parsed = wavToPcm(withList);
  assert.equal(parsed.format.sampleRate, RATE);
  assert.deepEqual([...parsed.pcm], [...pcmOf(9, 4)]);
});

test("the live join plays segment 1 first, then a gap, then the next segments", async () => {
  const joined = joinSegmentWavs([
    liveSegment([pcmOf(1, 10), pcmOf(1, 10)]),
    settledSegment(pcmOf(2, 5)),
    liveSegment([pcmOf(3, 5)]),
  ], { gapMs: 1 }); // 1 ms at 24 kHz = 24 samples of silence

  const bytes = await readAll(joined.live());
  const data = bytes.subarray(44);

  assert.equal(String.fromCharCode(...bytes.subarray(0, 4)), "RIFF");
  assert.equal(new DataView(bytes.buffer).getUint32(40, true), 0xffffffff, "live sizes are unknown");
  assert.equal(data.byteLength, (20 + 24 + 5 + 24 + 5) * 2);
  assert.equal(data[0], 1);
  assert.equal(data[40], 0, "silence between segments");
  assert.equal(data[(20 + 24) * 2], 2);
  assert.equal(data[(20 + 24 + 5 + 24) * 2], 3);
});

test("the live join emits exactly one WAV header", async () => {
  const joined = joinSegmentWavs([liveSegment([pcmOf(1, 4)]), liveSegment([pcmOf(2, 4)])], { gapMs: 0 });
  const bytes = await readAll(joined.live());

  assert.equal(bytes.byteLength, 44 + 16);
  assert.deepEqual([...bytes.subarray(44)], [...pcmOf(1, 4), ...pcmOf(2, 4)]);
});

test("the finished join has real sizes and the same audio as the live join", async () => {
  const joined = joinSegmentWavs([liveSegment([pcmOf(1, 10)]), settledSegment(pcmOf(2, 6))], { gapMs: 1 });

  const finished = await joined.finished();
  const live = await readAll(joined.live());
  const view = new DataView(finished.buffer);

  assert.equal(view.getUint32(40, true), finished.byteLength - 44);
  assert.equal(view.getUint32(4, true), finished.byteLength - 8);
  assert.deepEqual([...finished.subarray(44)], [...live.subarray(44)]);
});

test("segments in different sample rates are refused instead of playing at the wrong speed", async () => {
  const joined = joinSegmentWavs([settledSegment(pcmOf(1, 4), 24_000), settledSegment(pcmOf(2, 4), 16_000)], { gapMs: 0 });
  await assert.rejects(joined.finished(), /segment_format_mismatch/);
  await assert.rejects(readAll(joined.live()), /segment_format_mismatch/);
});

test("a failing segment fails the joined stream", async () => {
  const finished = Promise.reject(new Error("tts_failed"));
  finished.catch(() => undefined);
  const failing: SegmentAudio = {
    live: () => new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("tts_failed")); } }),
    finished,
  };
  const joined = joinSegmentWavs([settledSegment(pcmOf(1, 4)), failing], { gapMs: 0 });
  await assert.rejects(readAll(joined.live()), /tts_failed/);
});

test("segmented URLs are signed over language, job and every segment", () => {
  const url = createSegmentedAudioUrl("zh", ["我现在很累，", "我想去睡觉。"], "seg_abcdef12", { env: SECRET_ENV, now: 1_000 });
  assert.ok(url?.startsWith("/api/audio/segments?"));
  const params = new URL(url!, "http://local").searchParams;
  assert.equal(params.get("node"), "3001");

  assert.deepEqual(verifySegmentedAudioUrl(params, { env: SECRET_ENV, now: 2_000 }), {
    language: "zh", jobId: "seg_abcdef12", segments: ["我现在很累，", "我想去睡觉。"],
  });
  // iOS adds ?format=caf; unsigned parameters never break the signature.
  params.set("format", "caf");
  assert.ok(verifySegmentedAudioUrl(params, { env: SECRET_ENV, now: 2_000 }));

  const forged = new URLSearchParams(params);
  forged.delete("s");
  forged.append("s", "我现在很累，");
  forged.append("s", "请给我一百万。");
  assert.equal(verifySegmentedAudioUrl(forged, { env: SECRET_ENV, now: 2_000 }), undefined);
  assert.equal(verifySegmentedAudioUrl(params, { env: SECRET_ENV, now: 16 * 60_000 }), undefined, "expired");
  assert.equal(verifySegmentedAudioUrl(params, { env: { INSTALLATION_AUTH_SECRET: "y".repeat(40) }, now: 2_000 }), undefined);
});

test("no URL for one segment, too many segments, too much text or no signing secret", () => {
  assert.equal(createSegmentedAudioUrl("en", ["only one"], "seg_abcdef12", { env: SECRET_ENV }), undefined);
  assert.equal(createSegmentedAudioUrl("en", ["a", "b", "c", "d"], "seg_abcdef12", { env: SECRET_ENV }), undefined);
  assert.equal(createSegmentedAudioUrl("en", ["a".repeat(200), "b".repeat(101)], "seg_abcdef12", { env: SECRET_ENV }), undefined);
  assert.equal(createSegmentedAudioUrl("en", ["one,", "two"], "seg_abcdef12", { env: {} }), undefined);
});
