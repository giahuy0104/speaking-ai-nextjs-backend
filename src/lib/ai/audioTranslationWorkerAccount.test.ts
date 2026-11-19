import assert from "node:assert/strict";
import test from "node:test";
import { resolveWorkerAccountAlias, shouldRequeuePinnedJob } from "./audioTranslationWorkerAccount";
import { PoolError, ProviderFault, publicPoolError } from "./cloudflare/providerError";

const accounts = [{ alias: "audio-a", enabled: true }, { alias: "audio-b", enabled: false }];

test("a worker without an account setting shares every account", () => {
  assert.equal(resolveWorkerAccountAlias({}, accounts), undefined);
  assert.equal(resolveWorkerAccountAlias({ AUDIO_TRANSLATION_JOB_WORKER_ACCOUNT: "  " }, accounts), undefined);
});

test("a worker pinned to an enabled account uses that alias", () => {
  assert.equal(resolveWorkerAccountAlias({ AUDIO_TRANSLATION_JOB_WORKER_ACCOUNT: " audio-a " }, accounts), "audio-a");
});

test("a worker pinned to an unknown or disabled account refuses to start", () => {
  assert.throws(() => resolveWorkerAccountAlias({ AUDIO_TRANSLATION_JOB_WORKER_ACCOUNT: "audio-z" }, accounts), /job_worker_account_unavailable/);
  assert.throws(() => resolveWorkerAccountAlias({ AUDIO_TRANSLATION_JOB_WORKER_ACCOUNT: "audio-b" }, accounts), /job_worker_account_unavailable/);
});

const pinnedAttempt = { accountAlias: "audio-a", retryTransientFaults: true, providerAttemptsUsed: 1, providerAttemptsMax: 3 };

test("a pinned worker hands a rate-limited or transient provider failure back to the queue", () => {
  for (const error of [new ProviderFault("rate_limited", 429), new ProviderFault("network_error"),
    new ProviderFault("provider_error", 503), new ProviderFault("provider_error", 500)]) {
    assert.equal(shouldRequeuePinnedJob({ ...pinnedAttempt, error }), true);
  }
});

test("input, credential and admission failures are never requeued by this rule", () => {
  for (const error of [new ProviderFault("provider_error", 400), new ProviderFault("credentials", 401),
    new ProviderFault("invalid_response"), new PoolError("queue_timeout", 429), new PoolError("configuration"), new Error("unexpected")]) {
    assert.equal(shouldRequeuePinnedJob({ ...pinnedAttempt, error }), false);
  }
});

test("a shared worker keeps the dispatcher's own cross-account retry and is never requeued", () => {
  assert.equal(shouldRequeuePinnedJob({ ...pinnedAttempt, accountAlias: undefined, error: new ProviderFault("provider_error", 503) }), false);
});

test("requeue stops when the request's provider attempt budget is spent", () => {
  const error = new ProviderFault("provider_error", 503);
  assert.equal(shouldRequeuePinnedJob({ ...pinnedAttempt, providerAttemptsUsed: 2, error }), true);
  assert.equal(shouldRequeuePinnedJob({ ...pinnedAttempt, providerAttemptsUsed: 3, error }), false);
});

test("with transient retry disabled only a confirmed 429 rejection is requeued", () => {
  const off = { ...pinnedAttempt, retryTransientFaults: false };
  assert.equal(shouldRequeuePinnedJob({ ...off, error: new ProviderFault("provider_error", 503) }), false);
  assert.equal(shouldRequeuePinnedJob({ ...off, error: new ProviderFault("rate_limited", 429) }), true);
});

test("failures already projected to app errors by the text stage are classified the same way", () => {
  for (const fault of [new ProviderFault("rate_limited", 429), new ProviderFault("provider_error", 503), new ProviderFault("network_error")]) {
    assert.equal(shouldRequeuePinnedJob({ ...pinnedAttempt, error: publicPoolError(fault, "text_translation") }), true);
  }
  for (const fault of [new ProviderFault("provider_error", 400), new ProviderFault("credentials", 401), new PoolError("queue_timeout", 429)]) {
    assert.equal(shouldRequeuePinnedJob({ ...pinnedAttempt, error: publicPoolError(fault, "text_translation") }), false);
  }
});
