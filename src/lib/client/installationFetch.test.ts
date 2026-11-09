import assert from "node:assert/strict";
import { test } from "node:test";
import { createBrowserInstallationClient } from "./installationFetch";

const origin = "https://app.example.test";
function memoryStorage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); } };
}
function asRequest(input: RequestInfo | URL, init?: RequestInit) {
  return new Request(input instanceof Request ? input : new URL(String(input), origin), init);
}
function tokenResponse(token = "access-token", expiresAt = Date.now() + 3600_000) {
  return Response.json({ accessToken: token, refreshToken: "refresh-secret", accessTokenExpiresAt: new Date(expiresAt).toISOString() });
}

test("concurrent browser requests share authentication and scope history/body to their device", async () => {
  const storage = memoryStorage();
  const requests: Request[] = [];
  let registrations = 0;
  const client = createBrowserInstallationClient({ origin, storage, fetchImpl: async (input, init) => {
    const request = asRequest(input, init); requests.push(request.clone());
    if (new URL(request.url).pathname === "/api/installations/register") { registrations++; return tokenResponse(); }
    assert.equal(request.headers.get("Authorization"), "Bearer access-token");
    return Response.json({ ok: true });
  } });
  await Promise.all([
    client.fetch("/api/history", { cache: "no-store" }),
    client.fetch("/api/cache/warmup", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context: "home" }), keepalive: true }),
  ]);
  assert.equal(registrations, 1);
  const history = requests.find(request => new URL(request.url).pathname === "/api/history")!;
  assert.equal(new URL(history.url).searchParams.get("clientId"), client.getClientId());
  assert.equal(history.cache, "no-store");
  const warmup = requests.find(request => new URL(request.url).pathname === "/api/cache/warmup")!;
  assert.deepEqual(await warmup.json(), { context: "home", clientId: client.getClientId() });
  assert.equal(warmup.keepalive, true);
  const stored = [...storage.values.values()].join("");
  assert.equal(stored.includes("access-token"), false);
  assert.equal(stored.includes("refresh-secret"), false);
});

test("multipart conversation keeps bytes and receives its installation owner", async () => {
  let received: FormData | undefined;
  const client = createBrowserInstallationClient({ origin, storage: memoryStorage(), fetchImpl: async (input, init) => {
    const request = asRequest(input, init);
    if (new URL(request.url).pathname.endsWith("/register")) return tokenResponse();
    received = await request.formData();
    return Response.json({ ok: true });
  } });
  const body = new FormData(); body.set("audio", new File(["recorded-bytes"], "speech.webm"));
  await client.fetch("/api/conversation", { method: "POST", body });
  assert.equal(received?.get("clientId"), client.getClientId());
  assert.equal(await (received?.get("audio") as File).text(), "recorded-bytes");
  assert.equal(body.has("clientId"), false);
});

test("explicit scoped upload Authorization passes through without installation registration", async () => {
  let requests = 0;
  const client = createBrowserInstallationClient({ origin, fetchImpl: async (input, init) => {
    requests++;
    const request = asRequest(input, init);
    assert.equal(request.headers.get("Authorization"), "Bearer scoped.payload");
    return Response.json({ ok: true });
  } });
  await client.fetch("/api/audio-sessions/audio_v2-test/finalize", {
    method: "POST", headers: { Authorization: "Bearer scoped.payload" }, body: "{}",
  });
  assert.equal(requests, 1);
});

test("credentials are not attached to external origins or admin cookie APIs", async () => {
  const client = createBrowserInstallationClient({ origin, fetchImpl: async (input, init) => {
    const request = asRequest(input, init);
    assert.equal(request.headers.has("Authorization"), false);
    assert.equal(new URL(request.url).pathname.endsWith("/register"), false);
    return Response.json({ ok: true });
  } });
  await client.fetch("https://other.example.test/api/conversation", { method: "POST", body: "{}" });
  await client.fetch("/api/admin/overview");
  await client.fetch("/api/reports");
});

test("expired browser access is renewed by idempotent registration with the same identity", async () => {
  let clock = Date.now(); let registrations = 0; const identities: unknown[] = [];
  const storage = memoryStorage();
  const client = createBrowserInstallationClient({ origin, storage, now: () => clock, fetchImpl: async (input, init) => {
    const request = asRequest(input, init);
    if (new URL(request.url).pathname.endsWith("/register")) {
      registrations++; identities.push(await request.json());
      return tokenResponse(`access-${registrations}`, clock + 60_000);
    }
    return Response.json({ ok: true });
  } });
  await client.fetch("/api/history"); clock += 40_000; await client.fetch("/api/history");
  assert.equal(registrations, 2);
  assert.deepEqual(identities[0], identities[1]);
  const secondTab = createBrowserInstallationClient({ origin, storage, fetchImpl: async () => tokenResponse() });
  assert.equal(secondTab.getClientId(), client.getClientId());
});

test("unauthorized mutations are not replayed; the next request reauthenticates", async () => {
  let registrations = 0; let mutations = 0;
  const client = createBrowserInstallationClient({ origin, storage: memoryStorage(), fetchImpl: async (input, init) => {
    const request = asRequest(input, init);
    if (new URL(request.url).pathname.endsWith("/register")) { registrations++; return tokenResponse(); }
    if (request.method === "POST") { mutations++; return Response.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 }); }
    return Response.json({ ok: true });
  } });
  const response = await client.fetch("/api/conversation", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(response.status, 401); assert.equal(mutations, 1); assert.equal(registrations, 1);
  await client.fetch("/api/history"); assert.equal(registrations, 2);
});

test("safe reads recover once after a revoked access token", async () => {
  let registrations = 0; let reads = 0;
  const client = createBrowserInstallationClient({ origin, storage: memoryStorage(), fetchImpl: async (input, init) => {
    const request = asRequest(input, init);
    if (new URL(request.url).pathname.endsWith("/register")) { registrations++; return tokenResponse(); }
    reads++; return Response.json({}, { status: reads === 1 ? 401 : 200 });
  } });
  assert.equal((await client.fetch("/api/history")).status, 200);
  assert.equal(reads, 2); assert.equal(registrations, 2);
});

test("legacy mode is explicit and only recovers missing server authentication configuration", async () => {
  for (const allowLegacy of [false, true]) {
    let requests = 0;
    const client = createBrowserInstallationClient({ origin, storage: memoryStorage(), allowLegacy, fetchImpl: async (input, init) => {
      requests++; const request = asRequest(input, init);
      if (new URL(request.url).pathname.endsWith("/register")) {
        return Response.json({ error: { code: "AUTH_CONFIGURATION_ERROR" } }, { status: 503 });
      }
      assert.equal(request.headers.has("Authorization"), false);
      assert.equal(new URL(request.url).searchParams.get("clientId"), client.getClientId());
      return Response.json({ ok: true });
    } });
    if (allowLegacy) { assert.equal((await client.fetch("/api/history")).ok, true); assert.equal(requests, 2); }
    else { await assert.rejects(client.fetch("/api/history")); assert.equal(requests, 1); }
  }
});

test("an already aborted request does not register or send a provider request", async () => {
  let requests = 0;
  const client = createBrowserInstallationClient({ origin, fetchImpl: async () => { requests++; return tokenResponse(); } });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client.fetch("/api/conversation", { method: "POST", signal: controller.signal,
    headers: { "Content-Type": "application/json" }, body: "{}" }), error => error instanceof Error && error.name === "AbortError");
  assert.equal(requests, 0);
});

test("a supplied owner is preserved for server-side ownership validation", async () => {
  const requests: Request[] = [];
  const client = createBrowserInstallationClient({ origin, storage: memoryStorage(), fetchImpl: async (input, init) => {
    const request = asRequest(input, init);
    if (new URL(request.url).pathname.endsWith("/register")) return tokenResponse();
    requests.push(request.clone()); return Response.json({ ok: true });
  } });
  await client.fetch("/api/history?clientId=web_existing-owner");
  await client.fetch("/api/history", { method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: "web_existing-owner", conversationId: "conversation-1" }), keepalive: true });
  assert.equal(new URL(requests[0].url).searchParams.get("clientId"), "web_existing-owner");
  assert.equal((await requests[1].json()).clientId, "web_existing-owner");
  assert.equal(requests[1].keepalive, true);
});
