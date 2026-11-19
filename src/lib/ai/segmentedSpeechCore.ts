import { createHmac, timingSafeEqual } from "node:crypto";
import { wavHeader } from "@/lib/audio/wav";

/**
 * Speech of one translation in several segments, played as one WAV.
 *
 * Prototype for clause-by-clause translation: each segment (a clause of the
 * translated sentence) is synthesized on its own, all of them at once, and the
 * segments are joined in order. A player that streams (Android) hears segment 1
 * as soon as its first audio exists; a player that needs the whole file (iOS
 * AVPlayer) gets it once the slowest segment is done, which is sooner than one
 * synthesis of the whole sentence. PCM is joined, not MP3 frames: same sample
 * rate, no encoder padding, no gaps.
 */

export const SEGMENTED_AUDIO_PATH = "/api/audio/segments";
export const SEGMENT_LANGUAGES = ["en", "zh", "ja", "ko", "fr"] as const;
export type SegmentLanguage = (typeof SEGMENT_LANGUAGES)[number];

export const MAX_SEGMENTS = 3;
// Same budget as a deferred /api/audio/target URL (CJK is ~9 URL bytes per character).
export const MAX_SEGMENTED_TEXT_LENGTH = 300;
const URL_TTL_MS = 15 * 60_000;
const MAX_FUTURE_SKEW_MS = 60_000;
const MIN_SECRET_LENGTH = 32;
const NODE_PATTERN = /^[a-z0-9_-]{1,32}$/i;
const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

// Shortest clause spoken alone; shorter pieces join their neighbour.
const MIN_SEGMENT_CHARS: Readonly<Record<SegmentLanguage, number>> = { en: 12, fr: 12, ko: 6, zh: 4, ja: 4 };
const CLAUSE_PIECE = /[^,，、;；:：.。!！?？]+[,，、;；:：.。!！?？]*/gu;

type EnvSource = Readonly<Record<string, string | undefined>>;

export function isSegmentLanguage(value: unknown): value is SegmentLanguage {
  return typeof value === "string" && (SEGMENT_LANGUAGES as readonly string[]).includes(value);
}

function joinPieces(pieces: readonly string[], language: SegmentLanguage) {
  // Space-separated languages keep their spaces; zh/ja pieces join directly.
  return (language === "zh" || language === "ja" ? pieces.join("") : pieces.join(" ")).trim();
}

/** Groups segments into at most `count` groups of similar length, in order. */
function balance(pieces: readonly string[], count: number, language: SegmentLanguage) {
  const total = pieces.reduce((sum, piece) => sum + piece.length, 0);
  const target = total / count;
  const groups: string[][] = [[]];
  let length = 0;
  for (const piece of pieces) {
    const current = groups[groups.length - 1];
    if (current.length > 0 && length >= target && groups.length < count) {
      groups.push([piece]);
      length = piece.length;
    } else {
      current.push(piece);
      length += piece.length;
    }
  }
  return groups.map((group) => joinPieces(group, language));
}

/**
 * The translated sentence cut after clause punctuation (, 、 ; : . 。 ! ?), with
 * clauses shorter than a few words joined to their neighbour, at most `maxSegments`.
 * One segment means "nothing to gain": the caller keeps its usual speech path.
 */
export function splitSpeechSegments(text: string, language: SegmentLanguage, maxSegments = MAX_SEGMENTS): string[] {
  const sentence = text.normalize("NFC").replace(/\s+/g, " ").trim();
  if (!sentence) return [];
  const pieces = (sentence.match(CLAUSE_PIECE) ?? [sentence]).map((piece) => piece.trim()).filter(Boolean);
  const minChars = MIN_SEGMENT_CHARS[language];
  const merged: string[][] = [];
  let pending: string[] = [];
  for (const piece of pieces) {
    pending.push(piece);
    if (joinPieces(pending, language).length >= minChars) {
      merged.push(pending);
      pending = [];
    }
  }
  if (pending.length > 0) {
    if (merged.length > 0) merged[merged.length - 1].push(...pending);
    else merged.push(pending);
  }
  const segments = merged.map((group) => joinPieces(group, language));
  return segments.length <= maxSegments ? segments : balance(segments, maxSegments, language);
}

export type PcmFormat = Readonly<{ sampleRate: number; channels: number; bitsPerSample: number }>;

function concat(parts: readonly Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/**
 * Strips a WAV header from a byte stream: bytes before the `data` chunk are
 * buffered until it is found, everything after is PCM. Handles the 44-byte header
 * of a live stream (sizes unknown) and finished clips with extra chunks (LIST...).
 */
export function createWavHeaderStripper() {
  let buffered = new Uint8Array(0);
  let format: PcmFormat | undefined;
  let inData = false;
  let dataRemaining = Number.POSITIVE_INFINITY;

  function findData(): Uint8Array | null {
    if (buffered.byteLength < 12) return null;
    const view = new DataView(buffered.buffer, buffered.byteOffset, buffered.byteLength);
    const ascii = (offset: number) => String.fromCharCode(...buffered.subarray(offset, offset + 4));
    if (ascii(0) !== "RIFF" || ascii(8) !== "WAVE") throw new Error("segment_not_wav");
    let offset = 12;
    while (offset + 8 <= buffered.byteLength) {
      const id = ascii(offset);
      const size = view.getUint32(offset + 4, true);
      const body = offset + 8;
      if (id === "data") {
        if (!format) throw new Error("segment_missing_format");
        inData = true;
        // 0xFFFFFFFF: a live stream, read until it ends.
        dataRemaining = size === 0xffffffff ? Number.POSITIVE_INFINITY : size;
        return buffered.subarray(body);
      }
      if (body + size > buffered.byteLength) return null;
      if (id === "fmt ") {
        if (view.getUint16(body, true) !== 1) throw new Error("segment_not_pcm");
        format = {
          channels: view.getUint16(body + 2, true),
          sampleRate: view.getUint32(body + 4, true),
          bitsPerSample: view.getUint16(body + 14, true),
        };
      }
      offset = body + size + (size % 2);
    }
    return null;
  }

  return {
    /** PCM bytes of this chunk (empty while the header is incomplete). */
    push(chunk: Uint8Array): Uint8Array {
      let pcm: Uint8Array;
      if (inData) {
        pcm = chunk;
      } else {
        buffered = concat([buffered, chunk]);
        const found = findData();
        if (!found) return new Uint8Array(0);
        buffered = new Uint8Array(0);
        pcm = found;
      }
      if (pcm.byteLength > dataRemaining) pcm = pcm.subarray(0, dataRemaining);
      dataRemaining -= pcm.byteLength;
      return pcm;
    },
    format: () => format,
  };
}

/** The PCM and its format of a finished WAV clip. */
export function wavToPcm(audio: ArrayBuffer | Uint8Array): { pcm: Uint8Array; format: PcmFormat } {
  const stripper = createWavHeaderStripper();
  const pcm = stripper.push(audio instanceof Uint8Array ? audio : new Uint8Array(audio));
  const format = stripper.format();
  if (!format) throw new Error("segment_missing_format");
  return { pcm, format };
}

export type SegmentAudio = Readonly<{
  /** The segment's WAV while it is still being synthesized; null once it has settled. */
  live: () => ReadableStream<Uint8Array> | null;
  /** The whole WAV of the segment. */
  finished: Promise<ArrayBuffer>;
}>;

function samePcmFormat(a: PcmFormat, b: PcmFormat) {
  return a.sampleRate === b.sampleRate && a.channels === b.channels && a.bitsPerSample === b.bitsPerSample;
}

function assertMono16(format: PcmFormat) {
  if (format.channels !== 1 || format.bitsPerSample !== 16) throw new Error("segment_format_unsupported");
}

function silence(format: PcmFormat, gapMs: number) {
  const samples = Math.round((format.sampleRate * gapMs) / 1_000);
  return new Uint8Array(samples * format.channels * (format.bitsPerSample / 8));
}

/**
 * One WAV from segments, in order, with `gapMs` of silence between them.
 * - live(): streams. The header leaves with the first PCM bytes of segment 1;
 *   segment 2 is read once segment 1 has ended (its bytes wait in its broadcast).
 * - finished(): the whole file with its real sizes (Content-Length, byte ranges).
 * Every segment must have the same mono 16-bit format (one provider, one rate).
 */
export function joinSegmentWavs(segments: readonly SegmentAudio[], options: { gapMs: number }) {
  async function finished(): Promise<Uint8Array> {
    const clips = (await Promise.all(segments.map((segment) => segment.finished))).map(wavToPcm);
    const format = clips[0].format;
    assertMono16(format);
    if (clips.some((clip) => !samePcmFormat(clip.format, format))) throw new Error("segment_format_mismatch");
    const gap = silence(format, options.gapMs);
    const parts: Uint8Array[] = [];
    clips.forEach((clip, index) => {
      if (index > 0) parts.push(gap);
      parts.push(clip.pcm);
    });
    const data = concat(parts);
    return concat([wavHeader(format.sampleRate, data.byteLength), data]);
  }

  function live(): ReadableStream<Uint8Array> {
    let index = -1;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let stripper = createWavHeaderStripper();
    let format: PcmFormat | undefined;
    let headerSent = false;
    let pendingGap = false;

    function emit(controller: ReadableStreamDefaultController<Uint8Array>, pcm: Uint8Array) {
      const segmentFormat = stripper.format();
      if (!segmentFormat || pcm.byteLength === 0) return false;
      if (!format) {
        assertMono16(segmentFormat);
        format = segmentFormat;
      } else if (!samePcmFormat(segmentFormat, format)) {
        throw new Error("segment_format_mismatch");
      }
      const parts: Uint8Array[] = [];
      if (!headerSent) {
        parts.push(wavHeader(format.sampleRate));
        headerSent = true;
      }
      if (pendingGap) {
        parts.push(silence(format, options.gapMs));
        pendingGap = false;
      }
      parts.push(pcm);
      controller.enqueue(concat(parts));
      return true;
    }

    /** Opens the next segment: its live stream, or its finished clip as one chunk. */
    async function next(): Promise<boolean> {
      index += 1;
      if (index >= segments.length) return false;
      stripper = createWavHeaderStripper();
      pendingGap = index > 0;
      const stream = segments[index].live();
      if (stream) {
        reader = stream.getReader();
      } else {
        const whole = new Uint8Array(await segments[index].finished);
        reader = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(whole);
            controller.close();
          },
        }).getReader();
      }
      return true;
    }

    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        for (;;) {
          if (!reader && !(await next())) {
            controller.close();
            return;
          }
          const { done, value } = await reader!.read();
          if (done) {
            reader = undefined;
            continue;
          }
          if (emit(controller, stripper.push(value))) return;
        }
      },
      async cancel(reason) {
        await reader?.cancel(reason).catch(() => undefined);
      },
    });
  }

  return { live, finished };
}

// URL signing: the route synthesizes the text in the URL with a paid provider, so it
// only accepts URLs this backend issued (same scheme as targetAudioUrl.ts).

function signingKey(secret: string) {
  return createHmac("sha256", secret).update("homi-segmented-audio-url:v1").digest();
}

function signature(secret: string, language: string, expiresAt: number, jobId: string, segments: readonly string[]) {
  return createHmac("sha256", signingKey(secret))
    .update(JSON.stringify(["segments:v1", language, expiresAt, jobId, segments]))
    .digest("base64url");
}

function configuredSecret(env: EnvSource) {
  const secret = env.INSTALLATION_AUTH_SECRET?.trim() ?? "";
  return secret.length >= MIN_SECRET_LENGTH ? secret : undefined;
}

function validSegments(segments: readonly string[]) {
  const total = segments.reduce((sum, segment) => sum + segment.length, 0);
  return segments.length >= 2 && segments.length <= MAX_SEGMENTS &&
    segments.every((segment) => segment.length > 0 && segment.trim() === segment) &&
    total <= MAX_SEGMENTED_TEXT_LENGTH;
}

/** Signed relative URL, or undefined when signing is unavailable or the segments are invalid. */
export function createSegmentedAudioUrl(
  language: SegmentLanguage,
  segments: readonly string[],
  jobId: string,
  options: { env?: EnvSource; now?: number } = {},
): string | undefined {
  const env = options.env ?? process.env;
  const secret = configuredSecret(env);
  if (!secret || !validSegments(segments) || !JOB_ID_PATTERN.test(jobId)) return undefined;
  const expiresAt = (options.now ?? Date.now()) + URL_TTL_MS;
  const params = new URLSearchParams({
    lang: language,
    exp: String(expiresAt),
    job: jobId,
    sig: signature(secret, language, expiresAt, jobId, segments),
  });
  // Nginx routes ?node= back to the backend that started the synthesis.
  const node = env.AUDIO_STREAM_NODE?.trim();
  if (node && NODE_PATTERN.test(node)) params.set("node", node);
  for (const segment of segments) params.append("s", segment);
  return `${SEGMENTED_AUDIO_PATH}?${params.toString()}`;
}

export type SegmentedAudioRequest = { language: SegmentLanguage; jobId: string; segments: string[] };

/** The verified request, or undefined for a missing, expired or forged URL. */
export function verifySegmentedAudioUrl(
  params: URLSearchParams,
  options: { env?: EnvSource; now?: number } = {},
): SegmentedAudioRequest | undefined {
  const secret = configuredSecret(options.env ?? process.env);
  const language = params.get("lang");
  const jobId = params.get("job") ?? "";
  const segments = params.getAll("s");
  const expiresAt = Number(params.get("exp"));
  if (!secret || !isSegmentLanguage(language) || !JOB_ID_PATTERN.test(jobId) || !validSegments(segments)) return undefined;
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + URL_TTL_MS + MAX_FUTURE_SKEW_MS) return undefined;
  const expected = Buffer.from(signature(secret, language, expiresAt, jobId, segments));
  const received = Buffer.from(params.get("sig") ?? "");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return undefined;
  return { language, jobId, segments };
}
