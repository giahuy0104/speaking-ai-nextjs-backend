import { after } from "next/server";
import { audioCacheDisabled, verifyUncachedEnglishAudio } from "@/lib/ai/loadTestPersistence";
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
import { turnContent } from "@/lib/turnContentLog";
import { loggedAudioRoute } from "@/lib/audio/audioResponseLogger";
import { isBoundedRangeRequest, rangedAudioResponse } from "@/lib/audio/rangedAudio";
import { finishedUncachedEnglishSpeech } from "@/lib/ai/uncachedEnglishSpeech";
import type { ProviderTtsSource } from "@/types/conversation";

export const runtime = "nodejs";
export const maxDuration = 60;

// Logs the Content-Type actually sent (audio/x-caf, audio/wav or audio/mpeg).
export const GET = loggedAudioRoute("stream", handleGet);

async function handleGet(request: Request) {
  const requestId = getRequestId(request);
  const startedAt = performance.now();
  const url = new URL(request.url);
  const text = url.searchParams.get("text")?.trim() ?? "";
  const { knownCacheMiss } = consumeAudioStreamToken(url.searchParams.get("missToken"), text);
  // The signature, not the single-use token, decides: a retry, probe or another
  // backend must not fall back to the shared cache for a load-test turn.
  const noCache = url.searchParams.get("nocache");
  // AUDIO_CACHE_DISABLED covers every URL, signed or not (offline intents, old builds).
  const bypassCache = audioCacheDisabled() || verifyUncachedEnglishAudio(noCache, text);
  // Unsigned (this route carries no signature at all): the iOS app adds it to every
  // network audio source.
  const wantsCaf = url.searchParams.get("format") === "caf";
  // iOS (AVPlayer) cannot play a live stream of unknown length: it probes with
  // `Range: bytes=0-1` and fails with -11850 unless it gets a 206 with the total
  // size. The iOS app (?format=caf) and any bounded range request therefore wait
  // for the finished file: redirected to /api/audio/cache, or (uncached) served
  // here with byte ranges.
  const needsFinishedAudio = wantsCaf || isBoundedRangeRequest(request.headers.get("range"));

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

  if (bypassCache) {
    const finished = needsFinishedAudio
      ? { key: `${noCache ?? "unsigned"}\n${text}`, range: request.headers.get("range") }
      : null;
    return withRequestId(await uncachedSpeech(text, requestId, startedAt, finished), requestId);
  }

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
    const activeStream = needsFinishedAudio ? null : await joinActiveStream(text, requestId);
    if (activeStream) {
      logEvent("info", "tts_active_stream_joined", {
        requestId,
        latencyMs: Math.round(performance.now() - startedAt),
        eagerBootstrapJoined: activeStream.eagerBootstrapJoined,
      });
      return withRequestId(unbuffered(activeStream.response), requestId);
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
  let audioSource: ProviderTtsSource;
  let speechProfile = profile;
  const upstreamStartedAt = performance.now();

  try {
    const speech = await requestEnglishSpeechAudio(text);
    upstream = speech.response;
    audioSource = speech.source;
    speechProfile = speech.profile;
  } catch (error) {
    cacheFillClaim.fail(error);
    logEvent("error", "tts_stream_request_failed", { ...turnContent({ englishText: text }),
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
      logEvent("info", "tts_stream_first_chunk", { ...turnContent({ englishText: text }),
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
  if (needsFinishedAudio) {
    // The shared broadcast keeps reading the provider for other listeners and the
    // cache; only this request's own subscriber is dropped.
    void streamResponse.body?.cancel().catch(() => undefined);
    try {
      const result = await cacheFill;
      logEvent("info", "tts_finished_audio_redirect", {
        requestId,
        audioUrl: result.audioUrl,
        latencyMs: Math.round(performance.now() - startedAt),
      });
      return withRequestId(cacheRedirect(result.audioUrl), requestId);
    } catch (error) {
      const responseError =
        error instanceof AppError
          ? error
          : new AppError("TTS_FAILED", "Không thể tạo âm thanh.", 502);
      return withRequestId(toErrorResponse(responseError, requestId), requestId);
    }
  }
  streamResponse.headers.set(
    "Server-Timing",
    `cache;dur=${cacheLookupMs}, tts-headers;dur=${upstreamHeadersMs}`,
  );
  return withRequestId(unbuffered(streamResponse), requestId);
}

/** Joins the stream another request (or the eager start) already opened, if any. */
async function joinActiveStream(text: string, requestId: string) {
  const current = subscribeEnglishAudioStream(text);
  if (current) return { response: current, eagerBootstrapJoined: false };
  const bootstrap = waitForEnglishAudioStream(text);
  if (!bootstrap) return null;
  try {
    await bootstrap;
  } catch (error) {
    logEvent("warn", "tts_eager_stream_bootstrap_failed", { requestId, error });
    return null;
  }
  const joined = subscribeEnglishAudioStream(text);
  return joined ? { response: joined, eagerBootstrapJoined: true } : null;
}

function cacheRedirect(audioUrl: string) {
  return new Response(null, {
    status: 307,
    headers: { Location: audioUrl, "Cache-Control": "no-store", "X-Audio-Source": "cache" },
  });
}

/**
 * Uncached speech (load tests with LOAD_TEST_BYPASS_AUDIO_CACHE, or everyone with
 * AUDIO_CACHE_DISABLED): fresh speech streamed straight from the provider. No cache
 * read or write, and no joining or sharing a stream with any other turn, so every
 * turn pays a real synthesis. iOS (and any bounded range request) gets the finished
 * file with Content-Length and byte ranges instead (see uncachedEnglishSpeech.ts).
 */
async function uncachedSpeech(
  text: string, requestId: string, startedAt: number, finished: { key: string; range: string | null } | null,
) {
  try {
    if (finished) return await finishedUncachedSpeech(text, requestId, startedAt, finished.key, finished.range);
    const speech = await requestEnglishSpeechAudio(text);
    logEvent("info", "tts_uncached_stream_started", { ...turnContent({ englishText: text }),
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
    logEvent("error", "tts_stream_request_failed", { ...turnContent({ englishText: text }), requestId, uncached: true, error });
    const responseError = error instanceof AppError
      ? error
      : new AppError("TTS_FAILED", "Không thể truyền luồng âm thanh.", 502);
    return toErrorResponse(responseError, requestId);
  }
}

async function finishedUncachedSpeech(text: string, requestId: string, startedAt: number, key: string, range: string | null) {
  const speech = await finishedUncachedEnglishSpeech(key, text);
  logEvent("info", "tts_uncached_finished_served", { ...turnContent({ englishText: text }),
    requestId, byteLength: speech.audio.byteLength, range, latencyMs: Math.round(performance.now() - startedAt),
  });
  return rangedAudioResponse(new Uint8Array(speech.audio), range, {
    "Content-Type": speech.contentType,
    "Cache-Control": "no-store",
    "X-Audio-Source": speech.source,
    "X-Audio-Cache": "bypass",
  });
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
