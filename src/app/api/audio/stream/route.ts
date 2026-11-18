import { after } from "next/server";
import { verifyUncachedEnglishAudio } from "@/lib/ai/loadTestPersistence";
import { AppError, toErrorResponse } from "@/lib/errors";
import { requestEnglishSpeechAudio } from "@/lib/ai/englishSpeech";
import {
  claimEnglishAudioCacheFill,
  consumeAudioStreamToken,
  getEnglishAudioCacheUrl,
  getTtsProfile,
  startEnglishAudioStream,
  subscribeEnglishAudioStream,
  waitForEnglishAudioStream,
} from "@/lib/ai/tts";
import {
  getRequestId,
  logEvent,
  withRequestId,
} from "@/lib/observability";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  const requestId = getRequestId(request);
  const startedAt = performance.now();
  const url = new URL(request.url);
  const text = url.searchParams.get("text")?.trim() ?? "";
  const { knownCacheMiss } = consumeAudioStreamToken(url.searchParams.get("missToken"), text);
  // The signature, not the single-use token, decides: a retry, probe or another
  // backend must not fall back to the shared cache for a load-test turn.
  const bypassCache = verifyUncachedEnglishAudio(url.searchParams.get("nocache"), text);

  if (!text || text.length > 500) {
    return Response.json(
      {
        error: {
          code: "BAD_REQUEST",
          message: "Nội dung phát âm không hợp lệ.",
          requestId,
        },
      },
      { status: 400 },
    );
  }

  if (bypassCache) return withRequestId(await uncachedSpeech(text, requestId, startedAt), requestId);

  const cacheStartedAt = performance.now();
  const cachedUrl = knownCacheMiss
    ? null
    : await getEnglishAudioCacheUrl(text);
  const cacheLookupMs = Math.round(performance.now() - cacheStartedAt);

  if (cachedUrl) {
    return withRequestId(new Response(null, {
      status: 307,
      headers: {
        Location: cachedUrl,
        "Cache-Control": "no-store",
        "X-Audio-Source": "cache",
      },
    }), requestId);
  }

  const profile = getTtsProfile(text);
  const cacheFillClaim = claimEnglishAudioCacheFill(text);

  if (!cacheFillClaim.owner) {
    let activeStream = subscribeEnglishAudioStream(text);
    const bootstrap = activeStream ? null : waitForEnglishAudioStream(text);
    if (!activeStream && bootstrap) {
      try {
        await bootstrap;
        activeStream = subscribeEnglishAudioStream(text);
      } catch (error) {
        logEvent("warn", "tts_eager_stream_bootstrap_failed", {
          requestId,
          error,
        });
      }
    }
    if (activeStream) {
      logEvent("info", "tts_active_stream_joined", {
        requestId,
        latencyMs: Math.round(performance.now() - startedAt),
        eagerBootstrapJoined: Boolean(bootstrap),
      });
      return withRequestId(unbuffered(activeStream), requestId);
    }
    try {
      const result = await cacheFillClaim.completion;
      logEvent("info", "tts_cache_fill_joined", {
        requestId,
        audioUrl: result.audioUrl,
        latencyMs: Math.round(performance.now() - startedAt),
      });
      return withRequestId(new Response(null, {
        status: 307,
        headers: {
          Location: result.audioUrl,
          "Cache-Control": "no-store",
          "X-Audio-Source": "cache",
        },
      }), requestId);
    } catch (error) {
      logEvent("error", "tts_cache_fill_join_failed", { requestId, error });
      const responseError =
        error instanceof AppError
          ? error
          : new AppError("TTS_FAILED", "Không thể tạo âm thanh.", 502);
      return withRequestId(toErrorResponse(responseError, requestId), requestId);
    }
  }

  let upstream: Response;
  let audioSource: "cloudflare_tts";
  let speechProfile = profile;
  const upstreamStartedAt = performance.now();

  try {
    const speech = await requestEnglishSpeechAudio(text);
    upstream = speech.response;
    audioSource = speech.source;
    speechProfile = speech.profile;
  } catch (error) {
    cacheFillClaim.fail(error);
    logEvent("error", "tts_stream_request_failed", {
      requestId,
      error,
    });
    const responseError =
      error instanceof AppError
        ? error
        : new AppError("TTS_FAILED", "Không thể truyền luồng âm thanh.", 502);
    return withRequestId(toErrorResponse(responseError, requestId), requestId);
  }

  const cacheFillStartedAt = performance.now();
  const cacheFill = cacheFillClaim.cacheResponse(
    {
      response: upstream,
      source: audioSource,
      profile: speechProfile,
    },
    true,
  );
  logEvent("info", "tts_cache_fill_started", {
    requestId,
    provider: speechProfile.provider,
    model: speechProfile.model,
    voice: speechProfile.voice,
    independentFromClient: true,
  });
  after(async () => {
    try {
      const result = await cacheFill;
      logEvent("info", "tts_cache_fill_completed", {
        requestId,
        provider: speechProfile.provider,
        model: speechProfile.model,
        voice: speechProfile.voice,
        audioUrl: result.audioUrl,
        byteLength: result.byteLength,
        independentFromClient: true,
        latencyMs: Math.round(performance.now() - cacheFillStartedAt),
      });
    } catch (error) {
      logEvent("error", "tts_cache_fill_failed", {
        requestId,
        provider: speechProfile.provider,
        model: speechProfile.model,
        voice: speechProfile.voice,
        independentFromClient: true,
        error,
      });
    }
  });

  const upstreamHeadersMs = Math.round(performance.now() - upstreamStartedAt);
  const streamResponse = startEnglishAudioStream(text, {
    response: upstream,
    source: audioSource,
    profile: speechProfile,
  }, {
    onFirstChunk: () => {
      logEvent("info", "tts_stream_first_chunk", {
        requestId,
        provider: speechProfile.provider,
        model: speechProfile.model,
        voice: speechProfile.voice,
        cacheLookupMs,
        upstreamHeadersMs,
        firstChunkMs: Math.round(performance.now() - startedAt),
      });
    },
  });
  streamResponse.headers.set(
    "Server-Timing",
    `cache;dur=${cacheLookupMs}, tts-headers;dur=${upstreamHeadersMs}`,
  );
  return withRequestId(unbuffered(streamResponse), requestId);
}

/**
 * Load tests (k6 installations with LOAD_TEST_BYPASS_AUDIO_CACHE): fresh speech
 * streamed straight from the provider. No cache read or write, and no joining or
 * sharing a stream with any other listener, so every turn pays a real synthesis.
 */
async function uncachedSpeech(text: string, requestId: string, startedAt: number) {
  try {
    const speech = await requestEnglishSpeechAudio(text);
    logEvent("info", "tts_uncached_stream_started", {
      requestId,
      provider: speech.profile.provider,
      model: speech.profile.model,
      voice: speech.profile.voice,
      headersMs: Math.round(performance.now() - startedAt),
    });
    return unbuffered(new Response(speech.response.body, {
      status: 200,
      headers: {
        "Content-Type": speech.response.headers.get("content-type") ?? "audio/mpeg",
        "Cache-Control": "no-store",
        "X-Audio-Source": speech.source,
        "X-Audio-Cache": "bypass",
      },
    }));
  } catch (error) {
    logEvent("error", "tts_stream_request_failed", { requestId, uncached: true, error });
    const responseError = error instanceof AppError
      ? error
      : new AppError("TTS_FAILED", "Không thể truyền luồng âm thanh.", 502);
    return toErrorResponse(responseError, requestId);
  }
}

/**
 * Audio bytes must reach the player as soon as the provider emits them. Nginx
 * (both the host TLS proxy and the load balancer) honours this header and
 * disables response buffering for this response only.
 */
function unbuffered(response: Response) {
  response.headers.set("X-Accel-Buffering", "no");
  return response;
}
