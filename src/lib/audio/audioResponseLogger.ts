import { withAudioResponseLog, type AudioRoute } from "./audioResponseLog";

/**
 * Route wrapper that writes one `audio_response_sent` info line per audio response,
 * in the same JSON shape as logEvent. It writes the line itself instead of importing
 * "@/lib/observability" (server-only), so route modules stay importable from node tests
 * such as src/lib/storage/audio.test.ts.
 */
export function loggedAudioRoute<Args extends unknown[]>(
  route: AudioRoute,
  handler: (request: Request, ...rest: Args) => Promise<Response>,
) {
  return withAudioResponseLog(route, handler, fields => {
    console.info(JSON.stringify({ timestamp: new Date().toISOString(), level: "info", event: "audio_response_sent", ...fields }));
  });
}
