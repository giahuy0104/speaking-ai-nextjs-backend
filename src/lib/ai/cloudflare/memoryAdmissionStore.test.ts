import assert from "node:assert/strict";
import { test } from "node:test";
import { AdmissionStoreError } from "./admissionStore";
import { MemoryAdmissionStore } from "./memoryAdmissionStore";
import type { AdmissionResult, Permit, QuotaRule } from "./types";

const rules: readonly QuotaRule[] = [
  { key: "account", maxConcurrent: 3 },
  { key: "task:asr", rpm: 60, burst: 2, maxConcurrent: 2 },
  { key: "model:asr", rpm: 120, burst: 1, maxConcurrent: 1 },
];
function permit(result: AdmissionResult): Permit {
  assert.equal(result.granted, true);
  if (!result.granted) throw new Error("expected permit");
  return result.permit;
}

test("all account/task/model rules apply atomically; completion retains consumed rate", async () => {
  let now = 1_000;
  const store = new MemoryAdmissionStore(() => now);
  const acquire = (id: string) => store.acquire({ accountIdentity: "a", rules, leaseId: id, ttlMs: 5_000 });
  const first = permit(await acquire("one"));
  assert.deepEqual(await acquire("two"), { granted: false, retryAfterMs: 5_000 });
  await store.complete(first, {});
  assert.deepEqual(await acquire("two"), { granted: false, retryAfterMs: 500 });
  now += 500;
  const second = permit(await acquire("two"));
  await store.complete(second, {});
  assert.deepEqual(await acquire("three"), { granted: false, retryAfterMs: 500 });
  now += 500;
  permit(await acquire("three"));
});

test("different models consume their shared task and different tasks share account concurrency", async () => {
  const store = new MemoryAdmissionStore(() => 10_000);
  const task = { key: "task:asr", rpm: 60, burst: 1, maxConcurrent: 2 };
  const account = { key: "account", maxConcurrent: 1 };
  const acquire = (id: string, extra: QuotaRule) => store.acquire({ accountIdentity: "a", leaseId: id, ttlMs: 100,
    rules: [account, extra] });
  const first = permit(await acquire("one", task));
  assert.equal((await acquire("two", { key: "task:text", rpm: 60, burst: 10, maxConcurrent: 2 })).granted, false);
  await store.complete(first, {});
  assert.equal((await acquire("two", task)).granted, false);
  permit(await acquire("three", { key: "task:text", rpm: 60, burst: 10, maxConcurrent: 2 }));
});

test("burst and sustained RPM stay independent across minute boundaries and backwards clock changes", async () => {
  let now = 59_900;
  const store = new MemoryAdmissionStore(() => now);
  const rate = [{ key: "account", rpm: 60, burst: 2, maxConcurrent: 10 }];
  const acquire = (id: string) => store.acquire({ accountIdentity: "a", rules: rate, leaseId: id, ttlMs: 10 });
  await store.complete(permit(await acquire("one")), {});
  await store.complete(permit(await acquire("two")), {});
  now = 60_000;
  assert.deepEqual(await acquire("three"), { granted: false, retryAfterMs: 900 });
  now = 59_000;
  assert.deepEqual(await acquire("three"), { granted: false, retryAfterMs: 900 });
  now = 60_900;
  permit(await acquire("three"));
});

test("expired leases recover concurrency, repeated completion is harmless and old completion cannot disable new work", async () => {
  let now = 100;
  const store = new MemoryAdmissionStore(() => now);
  const concurrent = [{ key: "account", maxConcurrent: 1 }];
  const acquire = () => store.acquire({ accountIdentity: "a", rules: concurrent, leaseId: "reused", ttlMs: 10 });
  const first = permit(await acquire());
  assert.deepEqual(permit(await acquire()), first);
  now = 110;
  const next = permit(await acquire());
  await store.complete(first, { disable: true, cooldownMs: 1000 });
  assert.deepEqual(await store.snapshot("a", concurrent), { active: 1, retryAfterMs: 10 });
  await store.complete(next, {});
  await store.complete(next, { disable: true });
  assert.deepEqual(await store.snapshot("a", concurrent), { active: 0, retryAfterMs: 0 });
});

test("scoped cooldown blocks ASR only and allows exactly one recovery probe", async () => {
  let now = 100;
  const store = new MemoryAdmissionStore(() => now);
  const asr = [{ key: "account", maxConcurrent: 10 }, { key: "task:asr", maxConcurrent: 5 }];
  const text = [{ key: "account", maxConcurrent: 10 }, { key: "task:text", maxConcurrent: 5 }];
  const acquire = (id: string, selected = asr) => store.acquire({ accountIdentity: "a", rules: selected, leaseId: id, ttlMs: 50 });
  await store.complete(permit(await acquire("first")), { cooldownMs: 10, scopeKeys: ["task:asr"] });
  assert.deepEqual(await acquire("rejected"), { granted: false, retryAfterMs: 10 });
  const textPermit = permit(await acquire("text", text));
  assert.equal(textPermit.probe, false);
  now = 110;
  const probe = permit(await acquire("probe"));
  assert.equal(probe.probe, true);
  assert.deepEqual(await acquire("duplicate-probe"), { granted: false, retryAfterMs: 50 });
  await store.complete(probe, {});
  const healthy = permit(await acquire("healthy"));
  assert.equal(healthy.probe, false);
});

test("probe process death permits one new probe after TTL; stale completion cannot clear a new cooldown", async () => {
  let now = 100;
  const store = new MemoryAdmissionStore(() => now);
  const concurrent = [{ key: "account", maxConcurrent: 5 }];
  const acquire = (id: string) => store.acquire({ accountIdentity: "a", rules: concurrent, leaseId: id, ttlMs: 10 });
  await store.complete(permit(await acquire("first")), { cooldownMs: 10 });
  now = 110;
  const probe = permit(await acquire("probe"));
  now = 120;
  const nextProbe = permit(await acquire("next-probe"));
  assert.equal(nextProbe.probe, true);
  await store.complete(probe, {});
  assert.equal((await acquire("blocked")).granted, false);
  await store.complete(nextProbe, { cooldownMs: 100 });
  await store.complete(nextProbe, {});
  assert.deepEqual(await acquire("blocked"), { granted: false, retryAfterMs: 100 });
});

test("disable is account-wide and bounded validation never leaks input", async () => {
  const store = new MemoryAdmissionStore(() => 100);
  const first = permit(await store.acquire({ accountIdentity: "a", rules, leaseId: "one", ttlMs: 100 }));
  await store.complete(first, { disable: true });
  assert.deepEqual(await store.acquire({ accountIdentity: "a", rules: [{ key: "task:text", maxConcurrent: 10 }], leaseId: "two", ttlMs: 100 }),
    { granted: false, retryAfterMs: 86_400_000 });
  await assert.rejects(store.acquire({ accountIdentity: "secret{bad}", rules, leaseId: "bad", ttlMs: 100 }), AdmissionStoreError);
  await assert.rejects(store.acquire({ accountIdentity: "a", rules: [rules[0], rules[0]], leaseId: "bad", ttlMs: 100 }), AdmissionStoreError);
  await assert.rejects(store.complete(first, { scopeKeys: ["unknown"] }), AdmissionStoreError);
});

test("credential disable recovers through one probe after a bounded day-long cooldown", async () => {
  let now = 100;
  const store = new MemoryAdmissionStore(() => now);
  const concurrent = [{ key: "account", maxConcurrent: 5 }];
  const acquire = (id: string) => store.acquire({ accountIdentity: "a", rules: concurrent, leaseId: id, ttlMs: 1000 });
  await store.complete(permit(await acquire("first")), { disable: true });
  now += 86_400_000;
  const probe = permit(await acquire("probe"));
  assert.equal(probe.probe, true);
  assert.equal((await acquire("blocked")).granted, false);
  await store.complete(probe, { cooldownMs: 100 });
  assert.equal((await acquire("blocked")).granted, false);
  now += 100;
  const healthy = permit(await acquire("healthy"));
  assert.equal(healthy.probe, true);
  await store.complete(healthy, {});
  assert.equal(permit(await acquire("ordinary")).probe, false);
});
