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
 * as above) never reuse cached zh/ja/ko/fr speech, so every request pays for a real
 * synthesis, and the clip is not written back (the database is shared with production).
 */
export function bypassesAudioCache(clientId: string | undefined): boolean {
  return process.env.LOAD_TEST_BYPASS_AUDIO_CACHE?.trim().toLowerCase() === "true" &&
    skipsPostResponsePersistence(clientId);
}
