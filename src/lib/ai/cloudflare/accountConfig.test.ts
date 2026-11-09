import assert from "node:assert/strict";
import test from "node:test";
import { isPoolEnabled, parsePoolConfig, PoolConfigurationError, type PoolEnvironment } from "./accountConfig";

const asr = "@cf/openai/whisper-large-v3-turbo";
const text = "@cf/meta/llama-4-scout-17b-16e-instruct";
function account() {
  return {
    alias: "audio-a",
    accountId: "abcdef0123456789abcdef0123456789",
    apiTokenEnv: "POOL_A_TOKEN",
    enabled: true,
    capabilities: { asr: [asr], text: [text] },
    limits: {
      asr: { rpm: 600, burst: 10, maxConcurrent: 10 },
      text: { rpm: 240, burst: 4, maxConcurrent: 4 },
      accountMaxConcurrent: 14,
    },
  };
}
function env(registry: unknown = [account()]): PoolEnvironment {
  return {
    CLOUDFLARE_ACCOUNTS_JSON: JSON.stringify(registry),
    POOL_A_TOKEN: "secret-for-tests",
    CLOUDFLARE_POOL_STORE: "memory",
  };
}
function invalid(input: PoolEnvironment, reason?: string) {
  assert.throws(() => parsePoolConfig(input), (error: unknown) => {
    assert.ok(error instanceof PoolConfigurationError);
    if (reason) assert.equal(error.reason, reason);
    assert.equal(error.message, "Cloudflare pool configuration is invalid.");
    assert.ok(!JSON.stringify(error).includes("secret-for-tests"));
    return true;
  });
}

test("OFF does not parse registry, tokens or Redis settings", () => {
  assert.equal(isPoolEnabled({ CLOUDFLARE_ACCOUNTS_JSON: "invalid" }), false);
  assert.equal(isPoolEnabled({ CLOUDFLARE_AUDIO_TRANSLATION_POOL_ENABLED: "false", CLOUDFLARE_ACCOUNTS_JSON: "invalid" }), false);
  assert.equal(isPoolEnabled({ CLOUDFLARE_AUDIO_TRANSLATION_POOL_ENABLED: " TRUE " }), true);
  assert.throws(() => isPoolEnabled({ CLOUDFLARE_AUDIO_TRANSLATION_POOL_ENABLED: "yes" }), PoolConfigurationError);
});

test("builds immutable pool config without any legacy credentials", () => {
  const config = parsePoolConfig(env());
  assert.equal(config.accounts[0].apiToken, "secret-for-tests");
  assert.equal(config.accounts[0].identity.length, 64);
  assert.equal(config.maxAttemptsPerStage, 2);
  assert.equal(config.maxAttemptsPerRequest, 3);
  assert.equal(config.maxWaitMs, 0);
  assert.equal(config.maxInFlight, 20);
  assert.equal(config.redisUrl, undefined);
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.accounts));
  assert.ok(Object.isFrozen(config.accounts[0]));
  assert.ok(Object.isFrozen(config.accounts[0].limits));
  assert.ok(Object.isFrozen(config.accounts[0].capabilities.asr));
  const changedToken = { ...env(), POOL_A_TOKEN: "another-token" };
  assert.equal(config.configVersion, parsePoolConfig(changedToken).configVersion);
});

test("rejects malformed or unbounded config with fixed error reasons", () => {
  invalid({ ...env(), CLOUDFLARE_ACCOUNTS_JSON: "not-json secret-for-tests" }, "invalid_registry");
  invalid(env([]), "invalid_registry");
  invalid(env(Array.from({ length: 33 }, () => account())), "invalid_registry");
  invalid(env({}), "invalid_registry");
  invalid({ ...env(), CLOUDFLARE_ACCOUNTS_JSON: " ".repeat(131_073) }, "invalid_registry");
  invalid({ ...env(), POOL_A_TOKEN: "" }, "missing_or_invalid_token");
  invalid({ ...env(), POOL_A_TOKEN: "token\r\ninjection" }, "missing_or_invalid_token");
  invalid(env([{ ...account(), apiToken: "must-use-env-reference" }]), "unknown_config_field");
  invalid(env([{ ...account(), apiTokenEnv: "bad-reference" }]), "invalid_token_reference");
  invalid(env([{ ...account(), apiTokenEnv: "CLOUDFLARE_WORKERS_AI_API_TOKEN" }]), "legacy_token_in_pool");
  invalid(env([{ ...account(), accountId: "invalid-account" }]), "invalid_account_id");
  invalid(env([{ ...account(), alias: "unsafe.alias" }]), "invalid_alias");
  invalid(env([{ ...account(), enabled: "true" }]), "invalid_enabled");
});

test("account identity survives alias and token changes; duplicates include disabled and uppercase IDs", () => {
  const original = parsePoolConfig(env()).accounts[0];
  const changed = parsePoolConfig(env([{ ...account(), alias: "renamed", accountId: account().accountId.toUpperCase() }])).accounts[0];
  assert.equal(changed.identity, original.identity);
  invalid(env([account(), { ...account(), alias: "audio-b", accountId: account().accountId.toUpperCase(), enabled: false }]), "duplicate_account_id");
  invalid(env([account(), { ...account(), accountId: "11111111111111111111111111111111" }]), "duplicate_alias");
  invalid({ ...env(), CLOUDFLARE_ACCOUNT_ID: ` ${account().accountId.toUpperCase()} ` }, "legacy_account_in_pool");
  invalid({ ...env([account(), { ...account(), accountId: "11111111111111111111111111111111", alias: "disabled", enabled: false }]), CLOUDFLARE_ACCOUNT_ID: "11111111111111111111111111111111" }, "legacy_account_in_pool");
});

test("legacy account sharing is explicit and limited to local development or tests", () => {
  const shared = {
    ...env(), NODE_ENV: "development", CLOUDFLARE_ACCOUNT_ID: account().accountId,
    CLOUDFLARE_POOL_ALLOW_LEGACY_ACCOUNT_LOCAL_TEST: "true",
  };
  assert.equal(parsePoolConfig(shared).accounts[0].accountId, account().accountId);
  invalid({ ...shared, CLOUDFLARE_POOL_ALLOW_LEGACY_ACCOUNT_LOCAL_TEST: "false" }, "legacy_account_in_pool");
  invalid({ ...shared, CLOUDFLARE_POOL_ALLOW_LEGACY_ACCOUNT_LOCAL_TEST: "yes" }, "invalid_local_shared_account_flag");
  invalid({ ...shared, NODE_ENV: "production" }, "local_shared_account_requires_development");
  invalid({ ...shared, NODE_ENV: "staging" }, "local_shared_account_requires_development");
  invalid({ ...shared, CLOUDFLARE_POOL_STORE: "redis", CLOUDFLARE_POOL_REDIS_URL: "redis://remote.example:6379" }, "local_shared_account_requires_loopback_store");
  const redis = parsePoolConfig({ ...shared, NODE_ENV: undefined, CLOUDFLARE_POOL_STORE: "redis", CLOUDFLARE_POOL_REDIS_URL: "redis://127.0.0.1:6379" });
  assert.equal(redis.accounts.length, 1);
  invalid({ ...shared, CLOUDFLARE_ACCOUNTS_JSON: JSON.stringify([account(), { ...account(), alias: "same-account" }]) }, "duplicate_account_id");
});

test("validates capability coverage and accepts dedicated task accounts", () => {
  invalid(env([{ ...account(), capabilities: { asr: [], text: [] } }]), "no_configured_model_capability");
  invalid(env([{ ...account(), capabilities: { asr: [asr], text: [] } }]), "missing_model_capability");
  invalid(env([{ ...account(), capabilities: { asr: ["invalid"], text: [text] } }]), "invalid_capabilities");
  invalid(env([{ ...account(), capabilities: { asr: [asr, asr], text: [text] } }]), "duplicate_model");
  invalid({ ...env(), CLOUDFLARE_TEXT_MODEL: "@cf/another/model" }, "missing_model_capability");
  invalid({ ...env(), CLOUDFLARE_WORKERS_AI_MODEL: "bad" }, "invalid_model");
  const config = parsePoolConfig(env([
    { ...account(), capabilities: { asr: [asr], text: [] } },
    { ...account(), alias: "text-only", accountId: "11111111111111111111111111111111", capabilities: { asr: [], text: [text] } },
    { ...account(), alias: "disabled", accountId: "22222222222222222222222222222222", enabled: false, apiTokenEnv: "MISSING_TOKEN" },
  ]));
  assert.equal(config.accounts.length, 3);
  assert.equal(config.accounts[2].apiToken, "");
});

test("production legacy sharing validates every legacy model and explicit TTS quotas", () => {
  const sharedAccount = { ...account(), capabilities: { ...account().capabilities,
    text: [text, "@cf/qwen/qwen3-30b-a3b-fp8"], tts: ["@cf/deepgram/aura-1", "xai/grok-tts"] },
    limits: { ...account().limits, tts: { rpm: 60, burst: 2, maxConcurrent: 2 } } };
  const shared = { ...env([sharedAccount]), NODE_ENV: "production", CLOUDFLARE_AUDIO_TRANSLATION_POOL_ENABLED: "true",
    CLOUDFLARE_POOL_SHARE_LEGACY_ACCOUNT: "true", CLOUDFLARE_ACCOUNT_ID: account().accountId,
    CLOUDFLARE_POOL_STORE: "redis", CLOUDFLARE_POOL_REDIS_URL: "redis://shared-quota:6379" };
  const config = parsePoolConfig(shared);
  assert.equal(config.legacyAccountIdentity, config.accounts[0].identity);
  assert.equal(config.routeLegacyAccount, false);
  assert.equal(parsePoolConfig({ ...shared, CLOUDFLARE_POOL_ROUTE_LEGACY_ACCOUNT: "true" }).routeLegacyAccount, true);
  assert.deepEqual(config.accounts[0].capabilities.tts, ["@cf/deepgram/aura-1", "xai/grok-tts"]);
  invalid({ ...shared, CLOUDFLARE_AUDIO_TRANSLATION_POOL_ENABLED: "false" }, "shared_account_requires_pool");
  invalid({ ...shared, CLOUDFLARE_POOL_SHARE_LEGACY_ACCOUNT: "yes" }, "invalid_shared_account_flag");
  invalid({ ...shared, CLOUDFLARE_POOL_SHARE_LEGACY_ACCOUNT: "false", CLOUDFLARE_POOL_ROUTE_LEGACY_ACCOUNT: "true" }, "legacy_routing_requires_shared_quota");
  invalid({ ...shared, CLOUDFLARE_POOL_ALLOW_LEGACY_ACCOUNT_LOCAL_TEST: "true" }, "conflicting_shared_account_flags");
  invalid({ ...shared, CLOUDFLARE_ACCOUNT_ID: "f".repeat(32) }, "missing_shared_legacy_account");
  invalid({ ...shared, CLOUDFLARE_ACCOUNTS_JSON: JSON.stringify([account()]) }, "missing_legacy_model_capability");
  invalid({ ...shared, CLOUDFLARE_ACCOUNTS_JSON: JSON.stringify([{ ...sharedAccount, limits: account().limits }]) }, "missing_tts_quota_or_capability");
});

test("validates task, model and account quota limits and safe bounds", () => {
  for (const rpm of [0, -1, 1.5, 1_000_001]) {
    invalid(env([{ ...account(), limits: { ...account().limits, asr: { ...account().limits.asr, rpm } } }]), "invalid_quota");
  }
  invalid(env([{ ...account(), limits: { ...account().limits, accountMaxConcurrent: 10_001 } }]), "invalid_quota");
  invalid(env([{ ...account(), limits: { ...account().limits, text: { ...account().limits.text, burst: 10_001 } } }]), "invalid_quota");
  invalid(env([{ ...account(), limits: { ...account().limits, models: { "@cf/another/model": account().limits.asr } } }]), "unsupported_model_quota");
  const config = parsePoolConfig(env([{ ...account(), limits: { ...account().limits, models: { [asr]: account().limits.asr } } }]));
  assert.ok(Object.isFrozen(config.accounts[0].limits.models));
  assert.ok(Object.isFrozen(config.accounts[0].limits.models?.[asr]));
});

test("requires Redis in production and validates lazy Redis configuration", () => {
  invalid({ ...env(), NODE_ENV: "production" }, "memory_store_in_production");
  invalid({ ...env(), CLOUDFLARE_POOL_STORE: "other" }, "invalid_store");
  invalid({ ...env(), CLOUDFLARE_POOL_STORE: "redis" }, "missing_redis_url");
  invalid({ ...env(), CLOUDFLARE_POOL_STORE: "redis", CLOUDFLARE_POOL_REDIS_URL: "https://secret-for-tests.invalid" }, "invalid_redis_url");
  const config = parsePoolConfig({ ...env(), NODE_ENV: "production", CLOUDFLARE_POOL_STORE: "redis", CLOUDFLARE_POOL_REDIS_URL: "rediss://test-user:secret-for-tests@localhost:6379/1" });
  assert.equal(config.store, "redis");
  assert.equal(config.redisUrl, "rediss://test-user:secret-for-tests@localhost:6379/1");
});

test("caps retries and bounded burst queue settings and validates operational metadata", () => {
  invalid({ ...env(), CLOUDFLARE_POOL_MAX_ATTEMPTS_PER_STAGE: "3" }, "invalid_numeric_setting");
  invalid({ ...env(), CLOUDFLARE_POOL_MAX_ATTEMPTS_PER_REQUEST: "4" }, "invalid_numeric_setting");
  invalid({ ...env(), CLOUDFLARE_POOL_MAX_WAIT_MS: "10001" }, "invalid_numeric_setting");
  invalid({ ...env(), CLOUDFLARE_POOL_MAX_WAIT_MS: "-1" }, "invalid_numeric_setting");
  invalid({ ...env(), CLOUDFLARE_POOL_MAX_QUEUED: "1001" }, "invalid_numeric_setting");
  invalid({ ...env(), CLOUDFLARE_POOL_MAX_BUFFERED_BYTES: "0" }, "invalid_numeric_setting");
  const waiting = parsePoolConfig({ ...env(), CLOUDFLARE_POOL_MAX_WAIT_MS: "5000", CLOUDFLARE_POOL_MAX_QUEUED: "40" });
  assert.equal(waiting.maxWaitMs, 5000);
  assert.equal(waiting.maxQueued, 40);
  assert.equal(waiting.maxBufferedBytes, 32 * 1024 * 1024);
  assert.equal(parsePoolConfig({ ...env(), CLOUDFLARE_POOL_MAX_QUEUED: "0" }).maxQueued, 0);
  invalid({ ...env(), CLOUDFLARE_POOL_MAX_IN_FLIGHT: "0" }, "invalid_numeric_setting");
  invalid({ ...env(), CLOUDFLARE_POOL_MIN_ATTEMPT_MS: "Infinity" }, "invalid_numeric_setting");
  invalid({ ...env(), CLOUDFLARE_POOL_NAMESPACE: "unsafe{slot}" }, "invalid_namespace");
  invalid({ ...env(), CLOUDFLARE_POOL_CONFIG_VERSION: "unsafe version secret-for-tests" }, "invalid_config_version");
  assert.equal(parsePoolConfig({ ...env(), CLOUDFLARE_POOL_CONFIG_VERSION: "release-1" }).configVersion, "release-1");
});
