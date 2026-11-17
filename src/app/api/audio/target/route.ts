import { AppError, toErrorResponse } from "@/lib/errors";
import { getRequestId, logEvent, withRequestId } from "@/lib/observability";
import { getReusableAudioUrl } from "@/lib/storage/audio";
import { verifyTargetAudioUrl } from "@/lib/ai/targetAudioUrl";
import { subscribeTargetSpeech, targetSpeech, targetSpeechDescriptor, targetSpeechMode } from "@/lib/ai/targetSpeech";
import { isWav } from "@/lib/audio/wav";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Speech for a zh/ja/ko/fr translation that was returned before its audio existed.
 * Only signed URLs issued by the conversation pipeline are served (see targetAudioUrl.ts).
 * Order: join the synthesis this backend already started, else the durable cache,
 * else synthesize now. With AUDIO_TARGET_TTS_STREAM a long sentence is uncompressed WAV
 * carrying DeepInfra's PCM as it arrives (no Content-Length); a short sentence, or any
 * sentence without streaming, is the finished MP3 (see targetSpeechMode.ts).
 */
export async function GET(request: Request) {
  const requestId = getRequestId(request);
  const startedAt = performance.now();
  const verified = verifyTargetAudioUrl(new URL(request.url).searchParams);
  if (!verified) {
    return withRequestId(toErrorResponse(
      new AppError("FORBIDDEN", "Đường dẫn âm thanh không hợp lệ hoặc đã hết hạn.", 403), requestId), requestId);
  }
  const { language, text } = verified;

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
  const live = subscribeTargetSpeech(text, language);
  if (live) {
    const latencyMs = Math.round(performance.now() - startedAt);
    job.then(
      audio => logEvent("info", "target_speech_served", {
        requestId, language, joined, streamed: true, byteLength: audio.byteLength, latencyMs,
        totalMs: Math.round(performance.now() - startedAt),
      }),
      error => logEvent("warn", "target_speech_failed", { requestId, language, joined, streamed: true, latencyMs, error }),
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
    logEvent("info", "target_speech_served", {
      requestId, language, joined, streamed: false, mode: targetSpeechMode(language, text), byteLength: audio.byteLength,
      latencyMs: Math.round(performance.now() - startedAt),
    });
    return withRequestId(new Response(audio, {
      status: 200,
      headers: {
        // A settled streamed clip is WAV; the finished-clip path is MP3.
        "Content-Type": isWav(audio) ? "audio/wav" : "audio/mpeg",
        "Content-Length": String(audio.byteLength),
        // The signed URL is unique per sentence and expiry; the app may keep it.
        "Cache-Control": "private, max-age=900",
        "X-Audio-Source": joined ? "joined" : "synthesized",
      },
    }), requestId);
  } catch (error) {
    logEvent("warn", "target_speech_failed", {
      requestId, language, joined, latencyMs: Math.round(performance.now() - startedAt), error,
    });
    const responseError = error instanceof AppError
      ? error
      : new AppError("TTS_FAILED", "Chưa tạo được giọng đọc bản dịch.", 502);
    return withRequestId(toErrorResponse(responseError, requestId), requestId);
  }
}
