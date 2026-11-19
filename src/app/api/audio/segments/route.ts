import { AppError, toErrorResponse } from "@/lib/errors";
import { getRequestId, logEvent, withRequestId } from "@/lib/observability";
import { segmentedSpeechJob, segmentedSpeechTestEnabled } from "@/lib/ai/segmentedSpeech";
import { verifySegmentedAudioUrl } from "@/lib/ai/segmentedSpeechCore";
import { loggedAudioRoute } from "@/lib/audio/audioResponseLogger";
import { isBoundedRangeRequest, rangedAudioResponse } from "@/lib/audio/rangedAudio";
import { turnContent } from "@/lib/turnContentLog";

export const runtime = "nodejs";
export const maxDuration = 60;

const forbidden = (requestId: string) => withRequestId(toErrorResponse(
  new AppError("FORBIDDEN", "Đường dẫn âm thanh không hợp lệ hoặc đã hết hạn.", 403), requestId), requestId);

/**
 * Speech of a translation in segments (AUDIO_SEGMENTED_SPEECH_TEST, dev only), one
 * WAV. Signed URLs only (segmentedSpeechCore.ts). Same player rules as
 * /api/audio/target: a streaming player gets the live WAV (segment 1 plays while
 * the others are still being made); iOS (`?format=caf` or a bounded Range probe)
 * gets the finished file with Content-Length and byte ranges.
 */
async function handleGet(request: Request) {
  const requestId = getRequestId(request);
  const startedAt = performance.now();
  const url = new URL(request.url);
  const verified = segmentedSpeechTestEnabled() ? verifySegmentedAudioUrl(url.searchParams) : undefined;
  if (!verified) return forbidden(requestId);

  const rangeHeader = request.headers.get("range");
  const needsFinishedAudio = url.searchParams.get("format") === "caf" || isBoundedRangeRequest(rangeHeader);
  const { job, joined } = segmentedSpeechJob(verified.jobId, verified.language, verified.segments, requestId);
  const fields = {
    requestId, jobId: job.jobId, language: job.language, joined, segmentCount: job.segments.length,
    ...turnContent({ translatedText: job.segments.join(" | ") }),
  };

  try {
    if (!needsFinishedAudio) {
      // Waits for segment 1's first byte, so a refusal is an HTTP error, not a broken 200.
      await job.firstAudible;
      logEvent("info", "segmented_speech_served", {
        ...fields, streamed: true, firstByteMs: Math.round(performance.now() - startedAt),
      });
      return withRequestId(new Response(job.joined.live(), {
        status: 200,
        headers: {
          "Content-Type": "audio/wav",
          "Cache-Control": "private, max-age=300",
          "X-Accel-Buffering": "no",
          "X-Audio-Source": "segments",
        },
      }), requestId);
    }
    const audio = await job.joined.finished();
    logEvent("info", "segmented_speech_served", {
      ...fields, streamed: false, byteLength: audio.byteLength, range: rangeHeader,
      finishedMs: Math.round(performance.now() - startedAt),
    });
    return withRequestId(rangedAudioResponse(audio, rangeHeader, {
      "Content-Type": "audio/wav",
      "Cache-Control": "private, max-age=300",
      "X-Audio-Source": "segments",
    }), requestId);
  } catch (error) {
    logEvent("warn", "segmented_speech_failed", { ...fields, latencyMs: Math.round(performance.now() - startedAt), error });
    const responseError = error instanceof AppError
      ? error
      : new AppError("TTS_FAILED", "Chưa tạo được giọng đọc bản dịch.", 502);
    return withRequestId(toErrorResponse(responseError, requestId), requestId);
  }
}

export const GET = loggedAudioRoute("segments", handleGet);
