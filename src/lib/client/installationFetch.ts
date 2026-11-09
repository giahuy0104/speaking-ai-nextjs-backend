"use client";

type Identity = { clientId: string; installationSecret: string };
type Session = { accessToken: string; expiresAt: number };
type StorageLike = Pick<Storage, "getItem" | "setItem">;
type ClientOptions = {
  fetchImpl: typeof fetch;
  origin: string;
  storage?: StorageLike;
  cryptoImpl?: Pick<Crypto, "getRandomValues" | "randomUUID">;
  now?: () => number;
  allowLegacy?: boolean;
};

const identityKey = "speaking-ai-web-installation-v1";
const ownedEndpoint = /^\/api\/(?:conversation|audio-sessions|cache\/warmup|history|devices\/register|listening\/(?:recognize-choice|evaluate-attempt)|conversations\/[^/]+\/user-audio)$/;

/** Device identity is persisted; access tokens remain in memory, never localStorage. */
export function createBrowserInstallationClient(options: ClientOptions) {
  const now = options.now ?? Date.now;
  let identity: Identity | undefined;
  let session: Session | undefined;
  let pending: Promise<Session> | undefined;

  function getIdentity(): Identity {
    if (identity) return identity;
    try {
      const stored = JSON.parse(options.storage?.getItem(identityKey) || "null") as Identity | null;
      if (stored && /^web_[A-Za-z0-9._:-]{8,180}$/.test(stored.clientId) && /^[A-Za-z0-9_-]{32,180}$/.test(stored.installationSecret)) {
        identity = stored;
        return identity;
      }
    } catch { /* Restricted browser storage falls back to this page's identity. */ }
    const crypto = options.cryptoImpl ?? globalThis.crypto;
    identity = {
      clientId: `web_${crypto.randomUUID()}`,
      installationSecret: Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join(""),
    };
    try { options.storage?.setItem(identityKey, JSON.stringify(identity)); } catch { /* Memory-only identity is still authenticated. */ }
    return identity;
  }

  async function register(): Promise<Session> {
    // Same-secret registration renews access without rotating the shared device
    // session. Rotating a refresh token in one tab would invalidate other tabs.
    const response = await options.fetchImpl(new URL("/api/installations/register", options.origin), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...getIdentity(), platform: "web" }),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      if (options.allowLegacy && response.status === 503 && payload?.error?.code === "AUTH_CONFIGURATION_ERROR") {
        return { accessToken: "", expiresAt: now() + 60_000 };
      }
      throw new Error(typeof payload?.error?.message === "string" ? payload.error.message : "Không thể xác thực trình duyệt.");
    }
    const expiresAt = Date.parse(payload?.accessTokenExpiresAt);
    if (typeof payload?.accessToken !== "string" || !payload.accessToken || !Number.isFinite(expiresAt) || expiresAt <= now()) {
      throw new Error("Máy chủ trả về phiên xác thực không hợp lệ.");
    }
    return { accessToken: payload.accessToken, expiresAt };
  }

  async function getSession() {
    if (session && session.expiresAt > now() + 30_000) return session;
    pending ??= register();
    try { session = await pending; return session; }
    finally { pending = undefined; }
  }

  async function ownedRequest(request: Request, current: Session) {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    if (current.accessToken) headers.set("Authorization", `Bearer ${current.accessToken}`);
    let body: BodyInit | null | undefined;
    if (url.pathname === "/api/history" && ["GET", "HEAD", "DELETE"].includes(request.method)) {
      if (!url.searchParams.has("clientId")) url.searchParams.set("clientId", getIdentity().clientId);
    } else if (request.body && headers.get("content-type")?.includes("application/json")) {
      const payload: unknown = await request.clone().json();
      if (payload && typeof payload === "object" && !Array.isArray(payload) && !("clientId" in payload)) {
        body = JSON.stringify({ ...payload, clientId: getIdentity().clientId });
      }
    } else if (request.body && headers.get("content-type")?.includes("multipart/form-data")) {
      const form = await request.clone().formData();
      if (!form.has("clientId")) {
        form.set("clientId", getIdentity().clientId);
        body = form;
        headers.delete("content-type");
      }
    }
    const target = url.href === request.url ? request : new Request(url, request);
    return new Request(target, body === undefined ? { headers } : { headers, body });
  }

  const authenticatedFetch: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(String(input), options.origin);
    const request = new Request(input instanceof Request ? input : url, init);
    // Cookie-protected admin APIs keep their existing semantics. An explicit
    // Authorization header belongs to the caller (for example a scoped upload).
    if (url.origin !== new URL(options.origin).origin || !ownedEndpoint.test(url.pathname) || request.headers.has("authorization")) {
      return options.fetchImpl(request);
    }
    request.signal.throwIfAborted();
    const current = await getSession();
    request.signal.throwIfAborted();
    const response = await options.fetchImpl(await ownedRequest(request.clone(), current));
    if (response.status !== 401 || !current.accessToken) return response;
    if (session === current) session = undefined;
    // Never replay a provider mutation. Only safe reads may recover transparently.
    if (request.method !== "GET" && request.method !== "HEAD") return response;
    const renewed = await getSession();
    return options.fetchImpl(await ownedRequest(request, renewed));
  };
  return { fetch: authenticatedFetch, getClientId: () => getIdentity().clientId };
}

let browserClient: ReturnType<typeof createBrowserInstallationClient> | undefined;
export const browserInstallationFetch: typeof fetch = (input, init) => {
  if (!browserClient) {
    let storage: StorageLike | undefined;
    try { storage = window.localStorage; } catch { /* Some private browsers disable storage. */ }
    browserClient = createBrowserInstallationClient({ fetchImpl: fetch, origin: window.location.origin, storage,
      allowLegacy: process.env.NODE_ENV !== "production" });
  }
  return browserClient.fetch(input, init);
};
