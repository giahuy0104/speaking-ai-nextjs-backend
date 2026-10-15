import { after } from "next/server";
import { AppError, toErrorResponse } from "@/lib/errors";
import { getRequestId, logEvent, withRequestId } from "@/lib/observability";
import type { TargetSpeechLanguage } from "@/lib/ai/aiProvider";
import {
  createTargetAudio,
  getTargetAudioCacheUrl,
  saveTargetAudio,
} from "@/lib/ai/targetTts";

export const runtime = "nodejs";
export const maxDuration = 60;

function isTargetLanguage(value: string): value is TargetSpeechLanguage {
  return value === "zh" || value === "ja" || value === "ko" || value === "fr";
}

export async function GET(request: Request) {
  const requestId = getRequestId(request);
  const startedAt = performance.now();
  const url = new URL(request.url);
  const text = url.searchParams.get("text")?.trim() ?? "";
  const language = url.searchParams.get("lang") ?? "";

  if (!text || text.length > 240 || !isTargetLanguage(language)) {
    return withRequestId(
      toErrorResponse(
        new AppError("BAD_REQUEST", "Câu hoặc ngôn ngữ phát âm không hợp lệ.", 400),
        requestId,
      ),
      requestId,
    );
  }

  try {
    const cachedUrl = await getTargetAudioCacheUrl(text, language);
    if (cachedUrl) {
      return withRequestId(
        new Response(null, {
          status: 307,
          headers: {
            Location: cachedUrl,
            "Cache-Control": "no-store",
            "X-Audio-Source": "cache",
          },
        }),
        requestId,
      );
    }

    const audio = await createTargetAudio(text, language);
    after(async () => {
      try {
        await saveTargetAudio(text, language, audio);
      } catch (error) {
        logEvent("error", "target_tts_cache_write_failed", {
          requestId,
          language,
          error,
        });
      }
    });
    logEvent("info", "target_tts_audio_ready", {
      requestId,
      language,
      byteLength: audio.byteLength,
      latencyMs: Math.round(performance.now() - startedAt),
    });
    return withRequestId(
      new Response(audio, {
        headers: {
          "Content-Type": "audio/mpeg",
          "Content-Length": String(audio.byteLength),
          "Cache-Control": "no-store",
          "X-Audio-Source": "cloudflare_tts",
        },
      }),
      requestId,
    );
  } catch (error) {
    logEvent("error", "target_tts_request_failed", {
      requestId,
      language,
      error,
    });
    return withRequestId(
      toErrorResponse(
        error instanceof AppError
          ? error
          : new AppError("TTS_FAILED", "Không thể tạo giọng đọc bản dịch.", 502),
        requestId,
      ),
      requestId,
    );
  }
}
