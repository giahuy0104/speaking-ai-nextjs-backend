import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { AdmissionStoreError } from "./admissionStore";
import { createRedisClient, type PoolRedisClient } from "./redisClient";
import { RedisAdmissionStore } from "./redisAdmissionStore";
import type { AdmissionResult, Permit } from "./types";
import { createPoolRuntime } from "./runtime";
import { ASR_MODEL, TEXT_MODEL, poolEnv } from "./poolTestFixtures";
import { quotaRules } from "./quotaPolicy";

const url = process.env.CLOUDFLARE_POOL_TEST_REDIS_URL;
function permit(result: AdmissionResult): Permit {
  assert.ok(result.granted);
  return result.permit;
}

function childEvent(child: ChildProcess, type: string) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => { clean(); reject(new Error("Redis integration worker timeout")); }, 15_000);
    const message = (data: unknown) => {
      if (data && typeof data === "object" && "type" in data) {
        if (data.type === "failed") { clean(); reject(new Error("Redis integration worker failed")); }
        if (data.type === type) { clean(); resolve(data as Record<string, unknown>); }
      }
    };
    const exit = () => { clean(); reject(new Error("Redis integration worker exited")); };
    function clean() { clearTimeout(timer); child.off("message", message); child.off("exit", exit); }
    child.on("message", message);
    child.on("exit", exit);
  });
}

async function clearNamespace(client: PoolRedisClient, namespace: string) {
  // Never FLUSHDB: delete only the fresh, explicitly isolated test namespace.
  let cursor = "0";
  do {
    const reply = await client.sendCommand(["SCAN", cursor, "MATCH", `${namespace}:*`, "COUNT", "100"]);
    if (!Array.isArray(reply) || typeof reply[0] !== "string" || !Array.isArray(reply[1])) break;
    cursor = reply[0];
    const keys = reply[1].filter((key): key is string => typeof key === "string" && key.startsWith(`${namespace}:`));
    if (keys.length) await client.sendCommand(["DEL", ...keys]);
  } while (cursor !== "0");
}

test("Redis admission integration (dedicated test Redis only)", { skip: !url }, async (t) => {
  assert.equal(process.env.CLOUDFLARE_POOL_TEST_REDIS_CONFIRM_ISOLATED, "true",
    "Set CLOUDFLARE_POOL_TEST_REDIS_CONFIRM_ISOLATED=true only for a dedicated disposable Redis");
  const namespace = `cf-pool-test-${randomUUID()}`;
  const client = await createRedisClient(url!);
  const store = new RedisAdmissionStore(client, namespace);
  const workers: ChildProcess[] = [];
  try {
    await t.test("two independent processes cannot oversubscribe quota", async () => {
      const identity = `process-${randomUUID()}`;
      const ready: Promise<unknown>[] = [];
      for (let index = 0; index < 2; index++) {
        const child = fork(fileURLToPath(new URL("./redisAdmissionStore.integration-worker.ts", import.meta.url)), [], {
          execArgv: ["--import", "tsx"], silent: true,
          env: { ...process.env, CF_POOL_WORKER_REDIS_URL: url!, CF_POOL_WORKER_NAMESPACE: namespace, CF_POOL_WORKER_IDENTITY: identity },
        });
        workers.push(child);
        ready.push(childEvent(child, "ready"));
      }
      await Promise.all(ready);
      const results = workers.map((child) => childEvent(child, "result"));
      for (const child of workers) child.send("go");
      const counts = await Promise.all(results);
      assert.equal(counts.reduce((total, result) => total + Number(result.admitted), 0), 5);
      assert.equal((await store.snapshot(identity, [{ key: "account", maxConcurrent: 5 }])).active, 5);
      const exited = workers.map((child) => new Promise<void>((resolve) => child.once("exit", () => resolve())));
      for (const child of workers) child.send("release");
      await Promise.all(exited);
      assert.equal((await store.snapshot(identity, [{ key: "account", maxConcurrent: 5 }])).active, 0);
    });

    await t.test("token budget survives completion and rules apply together", async () => {
      const accountIdentity = `rate-${randomUUID()}`;
      const rules = [{ key: "account", maxConcurrent: 10 }, { key: "task:asr", rpm: 60, burst: 2, maxConcurrent: 10 }];
      const acquire = () => store.acquire({ accountIdentity, rules, leaseId: randomUUID(), ttlMs: 1000 });
      await store.complete(permit(await acquire()), {});
      await store.complete(permit(await acquire()), {});
      const rejected = await acquire();
      assert.equal(rejected.granted, false);
      if (!rejected.granted) assert.ok(rejected.retryAfterMs > 0 && rejected.retryAfterMs <= 1000);
    });

    await t.test("two runtimes absorb a simultaneous burst while Redis preserves both account quotas", async () => {
      const env = poolEnv();
      const registry = JSON.parse(env.CLOUDFLARE_ACCOUNTS_JSON!);
      for (const account of registry) account.limits = {
        asr: { rpm: 60000, burst: 100, maxConcurrent: 2 },
        text: { rpm: 60000, burst: 100, maxConcurrent: 1 }, accountMaxConcurrent: 3,
      };
      env.CLOUDFLARE_ACCOUNTS_JSON = JSON.stringify(registry);
      env.CLOUDFLARE_POOL_MAX_WAIT_MS = "3000";
      env.CLOUDFLARE_POOL_MAX_QUEUED = "32";
      env.CLOUDFLARE_POOL_MAX_IN_FLIGHT = "4";
      env.CLOUDFLARE_POOL_MIN_ATTEMPT_MS = "1";
      const queued: unknown[] = [];
      const runtimes = [0, 1].map(() => createPoolRuntime({ env, storeFactory: () => store,
        telemetry: (event, fields) => { if (event === "cloudflare_pool_queued") queued.push(fields); } }));
      const active = new Map<string, number>(); const peaks = new Map<string, number>();
      let asrCalls = 0; let textCalls = 0;
      await Promise.all(Array.from({ length: 24 }, async (_, index) => {
        const handle = (await runtimes[index % 2].acquireAudioTranslationExecution({ requestId: `redis-burst-${index}` }))!;
        const context = handle.execution;
        try {
          for (const [operation, model] of [["audio_translation_asr", ASR_MODEL], ["audio_translation_text", TEXT_MODEL]] as const) {
            await context.dispatcher.execute({ context, operation, model }, async ({ account }) => {
              if (operation === "audio_translation_asr") asrCalls++; else textCalls++;
              const key = `${account.alias}:${operation}`;
              const count = (active.get(key) ?? 0) + 1;
              active.set(key, count); peaks.set(key, Math.max(peaks.get(key) ?? 0, count));
              await delay(operation === "audio_translation_asr" ? 5 : 20);
              active.set(key, active.get(key)! - 1);
            });
          }
          assert.equal(context.attempts.used, 2);
        } finally { handle.release(); }
      }));
      assert.equal(asrCalls, 24); assert.equal(textCalls, 24); assert.ok(queued.length > 0);
      assert.equal(peaks.size, 4);
      for (const [key, peak] of peaks) assert.ok(peak <= (key.endsWith("asr") ? 2 : 1), `${key}: ${peak}`);
      // Both runtimes share this test store; the suite owns and closes it below.
    });

    await t.test("separate backend connections share legacy TTS and pooled ASR account concurrency", async () => {
      const env: NodeJS.ProcessEnv = { ...poolEnv(), CLOUDFLARE_POOL_SHARE_LEGACY_ACCOUNT: "true", CLOUDFLARE_POOL_ROUTE_LEGACY_ACCOUNT: "true",
        CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), CLOUDFLARE_POOL_MAX_WAIT_MS: "1000" };
      const registry = JSON.parse(env.CLOUDFLARE_ACCOUNTS_JSON!);
      registry[0].capabilities.text.push("@cf/qwen/qwen3-30b-a3b-fp8");
      registry[0].capabilities.tts = ["@cf/deepgram/aura-1", "xai/grok-tts"];
      registry[0].limits.tts = { rpm: 600, burst: 10, maxConcurrent: 2 };
      registry[0].limits.accountMaxConcurrent = 1;
      env.CLOUDFLARE_ACCOUNTS_JSON = JSON.stringify(registry);
      const stores = await Promise.all([0, 1].map(async () => new RedisAdmissionStore(await createRedisClient(url!), `${namespace}:legacy`)));
      const runtimes = stores.map(store => createPoolRuntime({ env, storeFactory: () => store }));
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let began!: () => void;
      const started = new Promise<void>(resolve => { began = resolve; });
      const legacy = (await runtimes[0].acquireLegacyExecution({ requestId: "legacy-tts", task: "tts", timeoutMs: 2000 }))!;
      const pooled = runtimes[1].createAudioTranslationExecution({ requestId: "pooled-asr" })!;
      const speech = legacy.execution.dispatcher.execute({ context: legacy.execution, operation: "legacy_tts", model: "@cf/deepgram/aura-1",
        accountIdentity: legacy.accountIdentity }, async () => { began(); await gate; });
      let asrCalls = 0;
      try {
        await started;
        const asr = pooled.execution.dispatcher.execute({ context: pooled.execution, operation: "audio_translation_asr", model: ASR_MODEL,
          accountIdentity: legacy.accountIdentity }, async ({ account }) => { asrCalls++; return account; });
        await delay(20); assert.equal(asrCalls, 0);
        release(); await speech;
        const account = await asr;
        assert.equal(account.alias, "audio-a"); assert.equal(asrCalls, 1);
        assert.equal((await stores[1].snapshot(account.identity, quotaRules(account, "legacy_asr", ASR_MODEL))).active, 0);
      } finally {
        release(); await speech;
        legacy.release(); pooled.release(); await Promise.all(runtimes.map(runtime => runtime.close()));
      }
    });

    await t.test("expired lease and repeated/stale completion cannot disable its successor", async () => {
      const accountIdentity = `ttl-${randomUUID()}`;
      const rules = [{ key: "account", maxConcurrent: 1 }];
      const acquire = () => store.acquire({ accountIdentity, rules, leaseId: "reused", ttlMs: 60 });
      const expired = permit(await acquire());
      await delay(90);
      const current = permit(await acquire());
      await store.complete(expired, { disable: true, cooldownMs: 1000 });
      assert.equal((await store.snapshot(accountIdentity, rules)).active, 1);
      await store.complete(current, {});
      await store.complete(current, { disable: true });
      permit(await acquire());
    });

    await t.test("cooldown is atomic and exactly one half-open probe can run", async () => {
      const accountIdentity = `probe-${randomUUID()}`;
      const rules = [{ key: "account", maxConcurrent: 10 }, { key: "task:asr", maxConcurrent: 10 }];
      const acquire = () => store.acquire({ accountIdentity, rules, leaseId: randomUUID(), ttlMs: 1000 });
      await store.complete(permit(await acquire()), { cooldownMs: 50, scopeKeys: ["task:asr"] });
      assert.equal((await acquire()).granted, false);
      await delay(80);
      const attempts = await Promise.all(Array.from({ length: 20 }, acquire));
      const admitted = attempts.filter((result) => result.granted);
      assert.equal(admitted.length, 1);
      const probe = permit(admitted[0]);
      assert.equal(probe.probe, true);
      await store.complete(probe, {});
      assert.equal(permit(await acquire()).probe, false);
    });

    await t.test("global credential cooldown is bounded and recovers through a single probe", async () => {
      const accountIdentity = `disabled-${randomUUID()}`;
      const rules = [{ key: "account", maxConcurrent: 10 }, { key: "task:asr", maxConcurrent: 10 }];
      const acquire = () => store.acquire({ accountIdentity, rules, leaseId: randomUUID(), ttlMs: 1000 });
      await store.complete(permit(await acquire()), { disable: true });
      const rejected = await acquire();
      assert.equal(rejected.granted, false);
      if (!rejected.granted) assert.ok(rejected.retryAfterMs <= 86_400_000 && rejected.retryAfterMs > 86_399_000);
      // Advance only this test account's cooldown metadata; application code uses Redis TIME.
      await client.sendCommand(["HSET", `${namespace}:{${accountIdentity}}:meta`, "cooldown", "0"]);
      const attempts = await Promise.all(Array.from({ length: 10 }, acquire));
      const admitted = attempts.filter((result) => result.granted);
      assert.equal(admitted.length, 1);
      const probe = permit(admitted[0]);
      assert.equal(probe.probe, true);
      await store.complete(probe, {});
      assert.equal(permit(await acquire()).probe, false);
    });

    await t.test("NOSCRIPT recovery after script-cache eviction", {
      skip: process.env.CLOUDFLARE_POOL_TEST_REDIS_ALLOW_SCRIPT_FLUSH !== "true",
    }, async () => {
      // This explicit opt-in is safe only on the disposable server acknowledged above.
      await client.sendCommand(["SCRIPT", "FLUSH"]);
      permit(await store.acquire({ accountIdentity: `noscript-${randomUUID()}`, rules: [{ key: "account", maxConcurrent: 1 }],
        leaseId: randomUUID(), ttlMs: 1000 }));
    });

    await t.test("real command timeout closes its uncertain connection and never falls back", async () => {
      const timedClient = await createRedisClient(url!, { commandTimeoutMs: 50 });
      const timedStore = new RedisAdmissionStore(timedClient, namespace);
      try {
        // Pause only the disposable test server acknowledged by the test's explicit guard.
        await client.sendCommand(["CLIENT", "PAUSE", "500", "ALL"]);
        const startedAt = Date.now();
        await assert.rejects(timedStore.acquire({ accountIdentity: `timeout-${randomUUID()}`,
          rules: [{ key: "account", maxConcurrent: 1 }], leaseId: randomUUID(), ttlMs: 1000 }), AdmissionStoreError);
        assert.ok(Date.now() - startedAt < 400);
        await assert.rejects(timedClient.sendCommand(["PING"]), AdmissionStoreError);
      } finally {
        await timedStore.close();
        await delay(550);
      }
    });

    await t.test("a disconnected Redis client fails admission closed", async () => {
      const stoppedClient = await createRedisClient(url!);
      await stoppedClient.close();
      const stoppedStore = new RedisAdmissionStore(stoppedClient, namespace);
      await assert.rejects(stoppedStore.acquire({ accountIdentity: `offline-${randomUUID()}`,
        rules: [{ key: "account", maxConcurrent: 1 }], leaseId: randomUUID(), ttlMs: 1000 }), AdmissionStoreError);
    });
  } finally {
    for (const child of workers) if (child.exitCode === null) child.kill();
    await clearNamespace(client, namespace).finally(() => store.close());
  }
});
