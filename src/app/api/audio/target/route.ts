import { AppError, toErrorResponse } from "@/lib/errors";
import { getRequestId, logEvent, withRequestId } from "@/lib/observability";
import { getReusableAudioUrl } from "@/lib/storage/audio";
import { verifyTargetAudioUrl } from "@/lib/ai/targetAudioUrl";
import {
  startUncachedTargetSpeech,
  subscribeTargetSpeech,
  subscribeUncachedTargetSpeech,
  targetSpeech,
  targetSpeechDescriptor,
  targetSpeechMode,
} from "@/lib/ai/targetSpeech";
import type { TargetAudioLanguage } from "@/lib/ai/targetAudioUrl";
import { isWav } from "@/lib/audio/wav";
import { loggedAudioRoute } from "@/lib/audio/audioResponseLogger";
import { isBoundedRangeRequest, rangedAudioResponse } from "@/lib/audio/rangedAudio";
import { loadTestCacheBypassEnabled } from "@/lib/ai/loadTestPersistence";
import { turnContent } from "@/lib/turnContentLog";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Speech for a zh/ja/ko/fr translation that was returned before its audio existed.
 * Only signed URLs issued by the conversation pipeline are served (see targetAudioUrl.ts).
 * Order: join the synthesis this backend already started, else the durable cache,
 * else synthesize now. With AUDIO_TARGET_TTS_STREAM a long sentence is uncompressed WAV
 * carrying DeepInfra's/Google's PCM as it arrives (no Content-Length); a short sentence,
 * or any sentence without streaming, is the finished MP3 (see targetSpeechMode.ts).
 * iOS (`?format=caf`, or any bounded Range request) never gets the live stream: it
 * waits for the finished audio and gets it with Content-Length and byte ranges.
 */
async function handleGet(request: Request) {
  const requestId = getRequestId(request);
  const startedAt = performance.now();
  const url = new URL(request.url);
  const verified = verifyTargetAudioUrl(url.searchParams);
  if (!verified) {
    return withRequestId(toErrorResponse(
      new AppError("FORBIDDEN", "Đường dẫn âm thanh không hợp lệ hoặc đã hết hạn.", 403), requestId), requestId);
  }
  // Unsigned: the signature only covers lang/text/exp/job, so adding this never
  // invalidates a URL. The iOS app sends it on every network audio source.
  const wantsCaf = url.searchParams.get("format") === "caf";
  // iOS (AVPlayer) cannot play a live stream of unknown length, CAF included: it
  // probes with `Range: bytes=0-1` and fails with -11850 unless it gets a 206 with
  // the total size. So the iOS app (?format=caf) and any bounded range request get
  // the finished audio with Content-Length and byte ranges, once synthesis is done.
  const rangeHeader = request.headers.get("range");
  const needsFinishedAudio = wantsCaf || isBoundedRangeRequest(rangeHeader);
  const { language, text } = verified;
  if (verified.jobId) {
    // Load-test URLs only work while the dev bypass is on: no uncached paid TTS elsewhere.
    if (!loadTestCacheBypassEnabled()) {
      return withRequestId(toErrorResponse(
        new AppError("FORBIDDEN", "Đường dẫn âm thanh không hợp lệ hoặc đã hết hạn.", 403), requestId), requestId);
    }
    return withRequestId(await uncachedSpeech(verified.jobId, language, text, requestId, startedAt, rangeHeader, needsFinishedAudio), requestId);
  }

  let job = targetSpeech.peek(text, language);
  const joined = Boolean(job);
  if (!job) {
    const cachedUrl = await getReusableAudioUrl(targetSpeechDescriptor(language, text)).catch(() => null);
    if (cachedUrl) {
      return withRequestId(new Response(null, {
        status: 307,
        headers: { Location: cachedUrl, "Cache-Control": "no-store", "X-Audio-Source": "cache" },
      }), requestId);
    }
    job = targetSpeech.start(text, language);
  }

  // AUDIO_TARGET_TTS_STREAM: play the WAV while it is still being generated.
  const live = needsFinishedAudio ? null : subscribeTargetSpeech(text, language);
  if (live) {
    const latencyMs = Math.round(performance.now() - startedAt);
    job.then(
      audio => logEvent("info", "target_speech_served", { ...turnContent({ translatedText: text }),
        requestId, language, joined, streamed: true, byteLength: audio.byteLength, latencyMs,
        totalMs: Math.round(performance.now() - startedAt),
      }),
      error => logEvent("warn", "target_speech_failed", { ...turnContent({ translatedText: text }), requestId, language, joined, streamed: true, latencyMs, error }),
    );
    return withRequestId(new Response(live, {
      status: 200,
      headers: {
        "Content-Type": "audio/wav",
        "Cache-Control": "private, max-age=900",
        "X-Accel-Buffering": "no",
        "X-Audio-Source": "stream",
      },
    }), requestId);
  }

  try {
    const audio = await job;
    logEvent("info", "target_speech_served", { ...turnContent({ translatedText: text }),
      requestId, language, joined, streamed: false, mode: targetSpeechMode(language, text), byteLength: audio.byteLength,
      finishedForPlayer: needsFinishedAudio, range: rangeHeader,
      latencyMs: Math.round(performance.now() - startedAt),
    });
    return withRequestId(rangedAudioResponse(new Uint8Array(audio), rangeHeader, {
      // A settled streamed clip is WAV; the finished-clip path is MP3.
      "Content-Type": isWav(audio) ? "audio/wav" : "audio/mpeg",
      // The signed URL is unique per sentence and expiry; the app may keep it.
      "Cache-Control": "private, max-age=900",
      "X-Audio-Source": joined ? "joined" : "synthesized",
    }), requestId);
  } catch (error) {
    logEvent("warn", "target_speech_failed", { ...turnContent({ translatedText: text }),
      requestId, language, joined, latencyMs: Math.round(performance.now() - startedAt), error,
    });
    const responseError = error instanceof AppError
      ? error
      : new AppError("TTS_FAILED", "Chưa tạo được giọng đọc bản dịch.", 502);
    return withRequestId(toErrorResponse(responseError, requestId), requestId);
  }
}

// Logs the Content-Type actually sent (audio/x-caf, audio/wav or audio/mpeg).
export const GET = loggedAudioRoute("target", handleGet);

/**
 * Load tests (a signed `job` id): this turn's own synthesis, started by the
 * conversation pipeline. Never served from or written to the cache, never shared.
 */
async function uncachedSpeech(
  jobId: string, language: TargetAudioLanguage, text: string, requestId: string, startedAt: number,
  rangeHeader: string | null, needsFinishedAudio: boolean,
) {
  const job = startUncachedTargetSpeech(jobId, text, language);
  const live = needsFinishedAudio ? null : subscribeUncachedTargetSpeech(jobId);
  const headers = { "Cache-Control": "no-store", "X-Audio-Cache": "bypass" };
  if (live) {
    logEvent("info", "target_speech_served", { ...turnContent({ translatedText: text }), requestId, language, uncached: true, streamed: true, latencyMs: Math.round(performance.now() - startedAt) });
    return new Response(live, {
      status: 200,
      headers: { ...headers, "Content-Type": "audio/wav", "X-Accel-Buffering": "no", "X-Audio-Source": "stream" },
    });
  }
  try {
    const audio = await job;
    logEvent("info", "target_speech_served", { ...turnContent({ translatedText: text }), requestId, language, uncached: true, streamed: false, byteLength: audio.byteLength, latencyMs: Math.round(performance.now() - startedAt) });
    return rangedAudioResponse(new Uint8Array(audio), rangeHeader, {
      ...headers, "Content-Type": isWav(audio) ? "audio/wav" : "audio/mpeg", "X-Audio-Source": "synthesized",
    });
  } catch (error) {
    logEvent("warn", "target_speech_failed", { ...turnContent({ translatedText: text }), requestId, language, uncached: true, error });
    return toErrorResponse(error instanceof AppError ? error : new AppError("TTS_FAILED", "Chưa tạo được giọng đọc bản dịch.", 502), requestId);
  }
}
