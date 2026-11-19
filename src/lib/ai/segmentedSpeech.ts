import { randomUUID } from "node:crypto";
import { logEvent } from "@/lib/observability";
import { turnContent } from "@/lib/turnContentLog";
import { canStreamSpeech, startKeyedSpeechStream, subscribeKeyedSpeechStream } from "./targetSpeech";
import {
  createSegmentedAudioUrl,
  joinSegmentWavs,
  splitSpeechSegments,
  type SegmentAudio,
  type SegmentLanguage,
} from "./segmentedSpeechCore";

/**
 * AUDIO_SEGMENTED_SPEECH_TEST=true (dev only): a translation with two or more clauses
 * is spoken as segments synthesized in parallel, joined into one WAV served by
 * /api/audio/segments. Prototype for clause-by-clause translation; nothing is cached.
 */
export function segmentedSpeechTestEnabled(env: Readonly<Record<string, string | undefined>> = process.env) {
  return env.AUDIO_SEGMENTED_SPEECH_TEST?.trim().toLowerCase() === "true";
}

const JOB_RETAIN_MS = 5 * 60_000;
// Each job holds its segments' WAV (~48 KB per second of speech) in memory.
const MAX_JOBS = 50;
const GAP_MS = 80;

export type SegmentedSpeechJob = Readonly<{
  jobId: string;
  language: SegmentLanguage;
  segments: readonly string[];
  startedAt: number;
  /** One WAV: live() streams it, finished() is the whole file. */
  joined: ReturnType<typeof joinSegmentWavs>;
  /** Segment 1's first byte, or its failure: lets the route answer with an HTTP error. */
  firstAudible: Promise<void>;
}>;

type SegmentedGlobal = typeof globalThis & {
  // Route bundles are separate module instances: the pipeline and the route share one map.
  __segmentedSpeechJobs?: Map<string, SegmentedSpeechJob>;
};

function jobs() {
  const state = globalThis as SegmentedGlobal;
  state.__segmentedSpeechJobs ??= new Map();
  return state.__segmentedSpeechJobs;
}

const segmentKey = (jobId: string, index: number) => `segments\n${jobId}\n${index}`;

function startJob(jobId: string, language: SegmentLanguage, segments: readonly string[], requestId?: string) {
  const startedAt = performance.now();
  // All segments at once: each holds its own provider stream slot while it runs.
  const audio: SegmentAudio[] = segments.map((text, index) => {
    const key = segmentKey(jobId, index);
    const finished = startKeyedSpeechStream(key, text, language);
    finished.then(
      (wav) => logEvent("info", "segmented_speech_segment_ready", {
        requestId, jobId, language, index, byteLength: wav.byteLength,
        readyMs: Math.round(performance.now() - startedAt),
      }),
      (error) => logEvent("warn", "segmented_speech_segment_failed", { requestId, jobId, language, index, error }),
    );
    return { live: () => subscribeKeyedSpeechStream(key), finished };
  });
  const firstAudible = new Promise<void>((resolve, reject) => {
    const reader = audio[0].live()?.getReader();
    if (!reader) {
      audio[0].finished.then(() => resolve(), reject);
      return;
    }
    // A subscriber reads the broadcast from its first byte, so this never steals audio.
    reader.read().then(() => { reader.cancel().catch(() => undefined); resolve(); }, reject);
  });
  firstAudible.catch(() => undefined);
  const job: SegmentedSpeechJob = {
    jobId, language, segments, startedAt: Date.now(),
    joined: joinSegmentWavs(audio, { gapMs: GAP_MS }),
    firstAudible,
  };
  const registry = jobs();
  if (registry.size >= MAX_JOBS) {
    const oldest = registry.keys().next().value;
    if (oldest !== undefined) registry.delete(oldest);
  }
  registry.set(jobId, job);
  const timer = setTimeout(() => {
    if (registry.get(jobId) === job) registry.delete(jobId);
  }, JOB_RETAIN_MS);
  timer.unref?.();
  logEvent("info", "segmented_speech_started", {
    requestId, jobId, language, segmentCount: segments.length,
    segmentChars: segments.map((segment) => segment.length),
    ...turnContent({ translatedText: segments.join(" | ") }),
  });
  return job;
}

/**
 * Starts the segmented speech of a translation and returns its signed URL, or
 * undefined (feature off, one clause only, the provider cannot stream this
 * language, or the text is too long): the caller keeps its usual speech path.
 */
export function startSegmentedSpeechUrl(language: SegmentLanguage, text: string, requestId?: string): string | undefined {
  if (!segmentedSpeechTestEnabled() || !canStreamSpeech(language)) return undefined;
  const segments = splitSpeechSegments(text, language);
  if (segments.length < 2) return undefined;
  const jobId = `seg_${randomUUID().replace(/-/g, "")}`;
  const url = createSegmentedAudioUrl(language, segments, jobId);
  if (!url) return undefined;
  startJob(jobId, language, segments, requestId);
  return url;
}

/**
 * The job of a verified URL: the one this backend started, or a new synthesis when
 * the request reached another backend (Nginx pinning missed, or the job expired).
 */
export function segmentedSpeechJob(jobId: string, language: SegmentLanguage, segments: readonly string[], requestId?: string) {
  const existing = jobs().get(jobId);
  if (existing && existing.language === language && existing.segments.join("\n") === segments.join("\n")) {
    return { job: existing, joined: true };
  }
  return { job: startJob(jobId, language, segments, requestId), joined: false };
}
