import { logEvent } from "@/lib/observability";
import { withAudioResponseLog, type AudioRoute } from "./audioResponseLog";

/** Route wrapper that writes one `audio_response_sent` info line per audio response. */
export function loggedAudioRoute<Args extends unknown[]>(
  route: AudioRoute,
  handler: (request: Request, ...rest: Args) => Promise<Response>,
) {
  return withAudioResponseLog(route, handler, fields => logEvent("info", "audio_response_sent", fields));
}
