import { createHmac, timingSafeEqual } from "node:crypto";

// Load tests on dev share the production database and Cloudinary account. Installations
// whose clientId starts with LOAD_TEST_SKIP_PERSISTENCE_CLIENT_PREFIX (k6 registers
// "web_k6_<hex>") skip the post-response writes: conversation history, adaptive
// learning and the user-audio upload. Unset on production.

const MIN_PREFIX_LENGTH = 6;

export function loadTestPersistencePrefix(): string | undefined {
  const prefix = process.env.LOAD_TEST_SKIP_PERSISTENCE_CLIENT_PREFIX?.trim();
  // A short prefix such as "web_" would silently drop real users' history.
  return prefix && prefix.length >= MIN_PREFIX_LENGTH ? prefix : undefined;
}

export function skipsPostResponsePersistence(clientId: string | undefined): boolean {
  const prefix = loadTestPersistencePrefix();
  return Boolean(prefix && clientId?.startsWith(prefix));
}

/**
 * LOAD_TEST_BYPASS_AUDIO_CACHE=true (dev only): load-test installations (same prefix
 * as above) use no cache at all, so every turn pays a real translation and a real
 * synthesis, and nothing is written back (the database is shared with production):
 * - en: no rules or text cache (read/write), no merging with a twin request, a fresh
 *   uncached /api/audio/stream (single-use token), preview always unmatched;
 * - zh/ja/ko/fr: a signed /api/audio/target URL with this turn's own job id: its own
 *   synthesis, never cached and never shared with another turn.
 */
export function bypassesAudioCache(clientId: string | undefined): boolean {
  return loadTestCacheBypassEnabled() && skipsPostResponsePersistence(clientId);
}

type EnvSource = Readonly<Record<string, string | undefined>>;

export function loadTestCacheBypassEnabled(env: EnvSource = process.env) {
  return env.LOAD_TEST_BYPASS_AUDIO_CACHE?.trim().toLowerCase() === "true";
}

// An uncached English stream URL is signed, so any request for it (a retry, a
// probe, another backend) still bypasses the cache, and nobody can forge one.
const UNCACHED_AUDIO_TTL_MS = 15 * 60_000;
const MIN_SECRET_LENGTH = 32;

function uncachedAudioSignature(secret: string, expiresAt: number, text: string) {
  const key = createHmac("sha256", secret).update("homi-load-test-uncached-audio:v1").digest();
  return createHmac("sha256", key).update(JSON.stringify(["en", expiresAt, text])).digest("base64url");
}

/** `nocache` parameter for an English stream URL; undefined when the bypass is off. */
export function signUncachedEnglishAudio(text: string, options: { env?: EnvSource; now?: number } = {}) {
  const env = options.env ?? process.env;
  const secret = env.INSTALLATION_AUTH_SECRET?.trim() ?? "";
  if (!loadTestCacheBypassEnabled(env) || secret.length < MIN_SECRET_LENGTH) return undefined;
  const expiresAt = (options.now ?? Date.now()) + UNCACHED_AUDIO_TTL_MS;
  return `${expiresAt}.${uncachedAudioSignature(secret, expiresAt, text.trim())}`;
}

/** True only while the bypass is on and the signature matches this text and has not expired. */
export function verifyUncachedEnglishAudio(
  value: string | null,
  text: string,
  options: { env?: EnvSource; now?: number } = {},
) {
  const env = options.env ?? process.env;
  const secret = env.INSTALLATION_AUTH_SECRET?.trim() ?? "";
  if (!value || !loadTestCacheBypassEnabled(env) || secret.length < MIN_SECRET_LENGTH) return false;
  const dot = value.indexOf(".");
  const expiresAt = Number(value.slice(0, dot));
  const now = options.now ?? Date.now();
  if (dot < 1 || !Number.isSafeInteger(expiresAt) || expiresAt <= now ||
      expiresAt > now + UNCACHED_AUDIO_TTL_MS + 60_000) return false;
  const expected = Buffer.from(uncachedAudioSignature(secret, expiresAt, text.trim()));
  const given = Buffer.from(value.slice(dot + 1));
  return given.length === expected.length && timingSafeEqual(given, expected);
}
