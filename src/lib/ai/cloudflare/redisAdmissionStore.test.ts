import assert from "node:assert/strict";
import { test } from "node:test";
import { AdmissionStoreError } from "./admissionStore";
import { RedisAdmissionStore } from "./redisAdmissionStore";
import { PoolRedisNoScriptError, createRedisClient, type PoolRedisClient } from "./redisClient";

const input = { accountIdentity: "a", rules: [{ key: "account", maxConcurrent: 2 }], leaseId: "lease", ttlMs: 1000 };
function client(sendCommand: PoolRedisClient["sendCommand"]): PoolRedisClient { return { sendCommand, async close() {} }; }

test("NOSCRIPT retries only the missing script, and all script keys use the same stable account hash tag", async () => {
  const calls: readonly string[][] = [];
  const commands: string[][] = calls as string[][];
  const store = new RedisAdmissionStore(client(async (args) => {
    commands.push([...args]);
    if (commands.length === 1) throw new PoolRedisNoScriptError();
    return [1, 1000, 0];
  }), "test");
  const result = await store.acquire(input);
  assert.equal(result.granted, true);
  assert.equal(commands[0][0], "EVALSHA");
  assert.equal(commands[1][0], "EVAL");
  const numberOfKeys = Number(commands[1][2]);
  const keys = commands[1].slice(3, 3 + numberOfKeys);
  assert.ok(keys.every((key) => key.includes("{a}")));
  assert.equal(keys.length, 4);
});

test("uncertain command failures fail closed without retry or raw Redis details", async () => {
  let count = 0;
  const store = new RedisAdmissionStore(client(async () => {
    count++;
    throw new Error("socket closed redis://user:super-secret@host:6379");
  }), "test");
  await assert.rejects(store.acquire(input), (error: unknown) => {
    assert.ok(error instanceof AdmissionStoreError);
    assert.equal(error.message.includes("secret"), false);
    return true;
  });
  assert.equal(count, 1);
});

test("malformed Redis replies and invalid namespaces cannot yield a permit", async () => {
  assert.throws(() => new RedisAdmissionStore(client(async () => null), "bad{slot}"), AdmissionStoreError);
  for (const reply of [null, [1, -1, 0], [1, 100, 2], [0], [2, 100, 0], [0, "bad"]]) {
    await assert.rejects(new RedisAdmissionStore(client(async () => reply), "test").acquire(input), AdmissionStoreError);
  }
});

test("complete supplies lease version and allowed scope only; no account credentials enter Redis", async () => {
  const commands: string[][] = [];
  const store = new RedisAdmissionStore(client(async (args) => {
    commands.push([...args]);
    return commands.length === 1 ? [1, 5000, 1] : 1;
  }), "test");
  const result = await store.acquire(input);
  assert.ok(result.granted);
  await store.complete(result.permit, { cooldownMs: 100, scopeKeys: ["account"] });
  assert.ok(commands[1].includes("5000"));
  assert.equal(commands[1].join(" ").includes("apiToken"), false);
  await assert.rejects(store.complete(result.permit, { scopeKeys: ["unrelated"] }), AdmissionStoreError);
  assert.equal(commands.length, 2);
});

test("snapshot passes explicit account and rule keys; close releases the client", async () => {
  let closed = false;
  const store = new RedisAdmissionStore({ async sendCommand() { return [3, 25]; }, async close() { closed = true; } }, "test");
  assert.deepEqual(await store.snapshot("a", input.rules), { active: 3, retryAfterMs: 25 });
  await store.close();
  assert.equal(closed, true);
});

test("Redis connection failure and command timeout are bounded and sanitized", async () => {
  await assert.rejects(createRedisClient("bad-secret-url"), AdmissionStoreError);
  // Measure the connection timeout independently from first-time module loading.
  await import("redis");
  const startedAt = Date.now();
  await assert.rejects(createRedisClient("redis://127.0.0.1:1", { connectTimeoutMs: 100, commandTimeoutMs: 100 }), AdmissionStoreError);
  assert.ok(Date.now() - startedAt < 3000);
});
