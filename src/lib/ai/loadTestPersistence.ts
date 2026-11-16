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
