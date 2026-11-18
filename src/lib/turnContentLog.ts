/**
 * LOG_TURN_CONTENT=true (dev only): success and error logs of a conversation
 * turn also carry what was processed — the recognized sentence, its translation
 * and the audio URL — so a failing step can be read with its input.
 *
 * Children's speech is personal data and dev shares production's database, so
 * this stays off by default and never logs audio bytes, tokens or URL
 * signatures; sentences are cut to MAX_LOGGED_TEXT_CHARS and client ids masked.
 */

type EnvSource = Readonly<Record<string, string | undefined>>;

export const MAX_LOGGED_TEXT_CHARS = 200;
const CLIENT_ID_VISIBLE_CHARS = 6;
const SECRET_PARAMS = /([?&](?:sig|missToken|nocache)=)[^&]*/g;

export function turnContentLoggingEnabled(env: EnvSource = process.env) {
  return env.LOG_TURN_CONTENT?.trim().toLowerCase() === "true";
}

/** An audio URL with its signature and tokens replaced by `***`. */
export function maskAudioUrl(url: string | null | undefined) {
  return url ? url.replace(SECRET_PARAMS, "$1***") : undefined;
}

function cut(text: string) {
  const characters = Array.from(text.trim());
  return characters.length > MAX_LOGGED_TEXT_CHARS
    ? `${characters.slice(0, MAX_LOGGED_TEXT_CHARS).join("")}…`
    : characters.join("");
}

/**
 * Fields to spread into a log event; empty unless LOG_TURN_CONTENT=true.
 * `audioUrl` is masked, `clientId` keeps only its last characters, any other
 * string is treated as a sentence and cut.
 */
export function turnContent(
  fields: Record<string, string | null | undefined>,
  env: EnvSource = process.env,
): Record<string, string> {
  if (!turnContentLoggingEnabled(env)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!value || !value.trim()) continue;
    if (key === "audioUrl") out[key] = maskAudioUrl(value)!;
    else if (key === "clientId") out[key] = `…${value.slice(-CLIENT_ID_VISIBLE_CHARS)}`;
    else out[key] = cut(value);
  }
  return out;
}
