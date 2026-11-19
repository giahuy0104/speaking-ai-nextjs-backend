import assert from "node:assert/strict";
import { test } from "node:test";
import { audioResponseLogFields, clientPlatform, withAudioResponseLog } from "./audioResponseLog";

function request(url: string, userAgent?: string) {
  return new Request(url, { headers: userAgent ? { "user-agent": userAgent } : {} });
}

test("clientPlatform detects iOS from AVPlayer and CFNetwork user agents", () => {
  assert.equal(clientPlatform("AppleCoreMedia/1.0.0.22A3354 (iPhone; U; CPU OS 18_0 like Mac OS X; vi_vn)"), "ios");
  assert.equal(clientPlatform("Runner/1 CFNetwork/1568.100.1 Darwin/24.0.0"), "ios");
});

test("clientPlatform detects Android from an ExoPlayer user agent", () => {
  assert.equal(clientPlatform("ExoPlayerLib/2.19.1 (Linux; Android 14) ExoPlayerLib/2.19.1"), "android");
});

test("clientPlatform returns unknown without a recognisable user agent", () => {
  assert.equal(clientPlatform(null), "unknown");
  assert.equal(clientPlatform("curl/8.5.0"), "unknown");
});

test("audioResponseLogFields reports the content type sent and the format asked for", () => {
  const response = new Response("x", {
    status: 200,
    headers: { "Content-Type": "audio/x-caf", "X-Audio-Source": "stream", "X-Request-Id": "abc" },
  });
  const fields = audioResponseLogFields(
    "target",
    request("https://api.test/api/audio/target?lang=zh&format=caf", "AppleCoreMedia/1.0 (iPhone)"),
    response,
    12,
  );
  assert.deepEqual(fields, {
    requestId: "abc",
    route: "target",
    status: 200,
    contentType: "audio/x-caf",
    audioSource: "stream",
    byteLength: null,
    requestedFormat: "caf",
    platform: "ios",
    userAgent: "AppleCoreMedia/1.0 (iPhone)",
    headersMs: 12,
  });
});

test("audioResponseLogFields records a cache redirect and a missing format as null", () => {
  const response = new Response(null, {
    status: 307,
    headers: { Location: "/api/audio/cache/a.mp3", "X-Audio-Source": "cache" },
  });
  const fields = audioResponseLogFields("stream", request("https://api.test/api/audio/stream?text=hi"), response, 3);
  assert.equal(fields.status, 307);
  assert.equal(fields.contentType, null);
  assert.equal(fields.audioSource, "cache");
  assert.equal(fields.requestedFormat, null);
  assert.equal(fields.redirectTo, "/api/audio/cache/a.mp3");
});

test("audioResponseLogFields truncates a very long user agent", () => {
  const fields = audioResponseLogFields("stream", request("https://api.test/x", "a".repeat(500)), new Response(null), 0);
  assert.equal(String(fields.userAgent).length, 160);
});

test("withAudioResponseLog logs once and returns the handler's response untouched", async () => {
  const logged: Record<string, unknown>[] = [];
  const original = new Response("x", { headers: { "Content-Type": "audio/mpeg", "Content-Length": "20937" } });
  const handler = withAudioResponseLog("cache", async () => original, fields => { logged.push(fields); });

  const response = await handler(request("https://api.test/api/audio/cache/a.mp3"));

  assert.equal(response, original);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].route, "cache");
  assert.equal(logged[0].contentType, "audio/mpeg");
  assert.equal(logged[0].byteLength, 20937);
});
