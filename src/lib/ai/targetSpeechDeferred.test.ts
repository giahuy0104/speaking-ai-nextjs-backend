import assert from "node:assert/strict";
import { test } from "node:test";
import { createTargetAudioUrl, MAX_DEFERRED_TEXT_LENGTH, verifyTargetAudioUrl } from "./targetAudioUrl";
import { createTargetSpeechCoordinator } from "./targetSpeechCoordinator";

const env = { INSTALLATION_AUTH_SECRET: "s".repeat(40), AUDIO_STREAM_NODE: "3002" };
const now = 1_800_000_000_000;
const paramsOf = (url: string) => new URL(url, "https://api.test").searchParams;

test("a signed target audio URL verifies and carries the backend node", () => {
  const url = createTargetAudioUrl("ja", "今日はとても嬉しいです。", { env, now })!;
  assert.match(url, /^\/api\/audio\/target\?/);
  assert.equal(paramsOf(url).get("node"), "3002");
  assert.deepEqual(verifyTargetAudioUrl(paramsOf(url), { env, now: now + 1000 }), {
    language: "ja", text: "今日はとても嬉しいです。",
  });
});

test("tampered, expired, foreign-secret and malformed URLs are rejected", () => {
  const url = createTargetAudioUrl("zh", "今天我很开心。", { env, now })!;
  const tampered = (key: string, value: string) => {
    const params = paramsOf(url);
    params.set(key, value);
    return verifyTargetAudioUrl(params, { env, now });
  };
  assert.equal(tampered("text", "别的句子"), undefined);
  assert.equal(tampered("lang", "ja"), undefined);
  assert.equal(tampered("exp", String(now + 10 * 60_000)), undefined);
  assert.equal(tampered("sig", "short"), undefined);
  assert.equal(tampered("lang", "en"), undefined);
  assert.equal(verifyTargetAudioUrl(paramsOf(url), { env, now: now + 16 * 60_000 }), undefined);
  assert.equal(verifyTargetAudioUrl(paramsOf(url), { env: { ...env, INSTALLATION_AUTH_SECRET: "t".repeat(40) }, now }), undefined);
  assert.equal(verifyTargetAudioUrl(new URLSearchParams(), { env, now }), undefined);
});

test("no URL is issued without a strong secret or for text longer than the limit", () => {
  assert.equal(createTargetAudioUrl("ko", "안녕", { env: { INSTALLATION_AUTH_SECRET: "short" }, now }), undefined);
  assert.equal(createTargetAudioUrl("fr", "a".repeat(MAX_DEFERRED_TEXT_LENGTH + 1), { env, now }), undefined);
  assert.equal(createTargetAudioUrl("fr", "", { env, now }), undefined);
  assert.equal(paramsOf(createTargetAudioUrl("fr", "Bonjour.", { env: { ...env, AUDIO_STREAM_NODE: "bad node!" }, now })!).get("node"), null);
});

function coordinator(synthesize: (text: string) => Promise<ArrayBuffer>) {
  const saved: string[] = [];
  const timers: Array<() => void> = [];
  const instance = createTargetSpeechCoordinator({
    synthesize,
    save: async text => { saved.push(text); },
    setTimer: callback => { timers.push(callback); },
    maxEntries: 2,
  });
  return { instance, saved, timers };
}

test("requests for the same sentence share one synthesis and the clip is saved once", async () => {
  let calls = 0;
  const { instance, saved, timers } = coordinator(async () => { calls++; return new Uint8Array([1, 2]).buffer; });
  const first = instance.start("Bonjour.", "fr");
  assert.equal(instance.peek("Bonjour.", "fr"), first);
  assert.equal(instance.start("Bonjour.", "fr"), first);
  assert.equal(instance.peek("Bonjour.", "ja"), undefined);
  assert.equal((await first).byteLength, 2);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.deepEqual(saved, ["Bonjour."]);
  // Kept for a late request, then released by the retention timer.
  assert.ok(instance.peek("Bonjour.", "fr"));
  timers.forEach(release => release());
  assert.equal(instance.peek("Bonjour.", "fr"), undefined);
});

test("a failed synthesis is dropped at once so the next request retries", async () => {
  let calls = 0;
  const { instance, saved } = coordinator(async () => { calls++; throw new Error("provider down"); });
  await assert.rejects(instance.start("안녕.", "ko"), /provider down/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(instance.peek("안녕.", "ko"), undefined);
  await assert.rejects(instance.start("안녕.", "ko"), /provider down/);
  assert.equal(calls, 2);
  assert.deepEqual(saved, []);
});

test("the job map is bounded and evicts the oldest sentence first", () => {
  const { instance } = coordinator(() => new Promise<ArrayBuffer>(() => undefined));
  instance.start("one", "zh");
  instance.start("two", "zh");
  instance.start("three", "zh");
  assert.equal(instance.size(), 2);
  assert.equal(instance.peek("one", "zh"), undefined);
  assert.ok(instance.peek("three", "zh"));
});
