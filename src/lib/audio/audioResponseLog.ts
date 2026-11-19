/**
 * One `audio_response_sent` line per audio response, so the logs say exactly what
 * a client received: the real Content-Type (audio/x-caf, audio/wav or audio/mpeg),
 * the X-Audio-Source, the format it asked for (?format=caf) and its platform.
 * Written when the headers are ready; a live stream keeps flowing after that.
 */

export type AudioRoute = "stream" | "target" | "cache" | "segments";
export type ClientPlatform = "ios" | "android" | "unknown";

const MAX_USER_AGENT_LENGTH = 160;

/** AVPlayer sends AppleCoreMedia/CFNetwork; ExoPlayer and Android HTTP stacks name Android. */
export function clientPlatform(userAgent: string | null): ClientPlatform {
  if (!userAgent) return "unknown";
  if (/AppleCoreMedia|CFNetwork|iPhone|iPad|iOS/i.test(userAgent)) return "ios";
  if (/Android|ExoPlayer|okhttp|Dalvik/i.test(userAgent)) return "android";
  return "unknown";
}

export function audioResponseLogFields(
  route: AudioRoute,
  request: Request,
  response: Response,
  headersMs: number,
): Record<string, unknown> {
  const userAgent = request.headers.get("user-agent");
  const location = response.headers.get("location");
  const contentLength = response.headers.get("content-length");
  return {
    requestId: response.headers.get("x-request-id"),
    route,
    status: response.status,
    contentType: response.headers.get("content-type"),
    audioSource: response.headers.get("x-audio-source"),
    // Known for finished files and clips; null for a live stream (length unknown yet).
    byteLength: contentLength === null ? null : Number(contentLength),
    requestedFormat: new URL(request.url).searchParams.get("format"),
    platform: clientPlatform(userAgent),
    userAgent: userAgent ? userAgent.slice(0, MAX_USER_AGENT_LENGTH) : null,
    headersMs,
    ...(location ? { redirectTo: location } : {}),
  };
}

/** Wraps a route handler: same response, plus one `log` call describing it. */
export function withAudioResponseLog<Args extends unknown[]>(
  route: AudioRoute,
  handler: (request: Request, ...rest: Args) => Promise<Response>,
  log: (fields: Record<string, unknown>) => void,
): (request: Request, ...rest: Args) => Promise<Response> {
  return async (request, ...rest) => {
    const startedAt = performance.now();
    const response = await handler(request, ...rest);
    log(audioResponseLogFields(route, request, response, Math.round(performance.now() - startedAt)));
    return response;
  };
}
