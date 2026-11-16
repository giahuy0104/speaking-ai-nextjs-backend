import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed URLs for deferred zh/ja/ko/fr speech (GET /api/audio/target).
 *
 * The route synthesizes the text in the URL with a paid provider, so it only
 * accepts URLs this backend issued: an HMAC over language, expiry and text,
 * keyed from INSTALLATION_AUTH_SECRET. Without the signature anyone could turn
 * the endpoint into free text-to-speech billed to us.
 */

export const TARGET_AUDIO_PATH = "/api/audio/target";
export const TARGET_AUDIO_LANGUAGES = ["zh", "ja", "ko", "fr"] as const;
export type TargetAudioLanguage = (typeof TARGET_AUDIO_LANGUAGES)[number];

// CJK text is ~9 URL-encoded bytes per character; 300 keeps the URL far below
// Nginx's 8 KB header buffers. Longer translations keep the synchronous path.
export const MAX_DEFERRED_TEXT_LENGTH = 300;
const URL_TTL_MS = 15 * 60_000;
// Tolerates clock skew between backends without accepting far-future expiries.
const MAX_FUTURE_SKEW_MS = 60_000;
const MIN_SECRET_LENGTH = 32;
const NODE_PATTERN = /^[a-z0-9_-]{1,32}$/i;

type EnvSource = Readonly<Record<string, string | undefined>>;

function signingKey(secret: string) {
  // A derived key: the signature never reveals anything usable for installation tokens.
  return createHmac("sha256", secret).update("homi-target-audio-url:v1").digest();
}

function signature(secret: string, language: string, expiresAt: number, text: string) {
  return createHmac("sha256", signingKey(secret))
    .update(`${language}\n${expiresAt}\n${text}`)
    .digest("base64url");
}

function configuredSecret(env: EnvSource) {
  const secret = env.INSTALLATION_AUTH_SECRET?.trim() ?? "";
  return secret.length >= MIN_SECRET_LENGTH ? secret : undefined;
}

export function isTargetAudioLanguage(value: unknown): value is TargetAudioLanguage {
  return typeof value === "string" && (TARGET_AUDIO_LANGUAGES as readonly string[]).includes(value);
}

/** Signed relative URL, or undefined when signing is unavailable or the text is too long. */
export function createTargetAudioUrl(
  language: TargetAudioLanguage,
  text: string,
  options: { env?: EnvSource; now?: number } = {},
): string | undefined {
  const env = options.env ?? process.env;
  const secret = configuredSecret(env);
  if (!secret || !text || text.length > MAX_DEFERRED_TEXT_LENGTH) return undefined;
  const expiresAt = (options.now ?? Date.now()) + URL_TTL_MS;
  const params = new URLSearchParams({
    lang: language,
    exp: String(expiresAt),
    sig: signature(secret, language, expiresAt, text),
  });
  // Same pinning as /api/audio/stream: Nginx routes ?node= back to the backend
  // that already started synthesis, so the request joins it instead of paying twice.
  const node = env.AUDIO_STREAM_NODE?.trim();
  if (node && NODE_PATTERN.test(node)) params.set("node", node);
  params.set("text", text);
  return `${TARGET_AUDIO_PATH}?${params.toString()}`;
}

export type TargetAudioRequest = { language: TargetAudioLanguage; text: string };

/** The verified language and text, or undefined for a missing, expired or forged URL. */
export function verifyTargetAudioUrl(
  params: URLSearchParams,
  options: { env?: EnvSource; now?: number } = {},
): TargetAudioRequest | undefined {
  const secret = configuredSecret(options.env ?? process.env);
  const language = params.get("lang");
  const text = params.get("text") ?? "";
  const expiresAt = Number(params.get("exp"));
  const given = params.get("sig") ?? "";
  if (!secret || !isTargetAudioLanguage(language)) return undefined;
  if (!text || text.length > MAX_DEFERRED_TEXT_LENGTH || !Number.isSafeInteger(expiresAt)) return undefined;
  const now = options.now ?? Date.now();
  if (expiresAt <= now || expiresAt > now + URL_TTL_MS + MAX_FUTURE_SKEW_MS) return undefined;
  const expected = Buffer.from(signature(secret, language, expiresAt, text));
  const received = Buffer.from(given);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return undefined;
  return { language, text };
}
