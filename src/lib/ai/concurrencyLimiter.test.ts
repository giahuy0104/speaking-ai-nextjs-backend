import assert from "node:assert/strict";
import { test } from "node:test";
import { ConcurrencyLimitTimeoutError, createConcurrencyLimiter } from "./concurrencyLimiter";

const tick = () => new Promise(resolve => setImmediate(resolve));

test("runs at most maxConcurrent holders and admits waiters in order", async () => {
  const limiter = createConcurrencyLimiter({ maxConcurrent: 2, maxWaitMs: 1000 });
  const first = await limiter.acquire();
  const second = await limiter.acquire();
  const order: string[] = [];
  const third = limiter.acquire().then(release => { order.push("third"); return release; });
  const fourth = limiter.acquire().then(release => { order.push("fourth"); return release; });
  await tick();
  assert.deepEqual(limiter.stats(), { active: 2, waiting: 2 });
  assert.deepEqual(order, []);

  first();
  const releaseThird = await third;
  assert.deepEqual(order, ["third"]);
  second();
  const releaseFourth = await fourth;
  assert.deepEqual(order, ["third", "fourth"]);
  assert.deepEqual(limiter.stats(), { active: 2, waiting: 0 });

  releaseThird();
  releaseFourth();
  assert.deepEqual(limiter.stats(), { active: 0, waiting: 0 });
});

test("a release called twice frees only one slot", async () => {
  const limiter = createConcurrencyLimiter({ maxConcurrent: 1, maxWaitMs: 1000 });
  const release = await limiter.acquire();
  release();
  release();
  const again = await limiter.acquire();
  const waiting = limiter.acquire();
  await tick();
  assert.deepEqual(limiter.stats(), { active: 1, waiting: 1 });
  again();
  (await waiting)();
  assert.deepEqual(limiter.stats(), { active: 0, waiting: 0 });
});

test("a waiter that cannot get a slot in time is rejected and leaves the queue", async () => {
  const limiter = createConcurrencyLimiter({ maxConcurrent: 1, maxWaitMs: 30 });
  const holder = await limiter.acquire();
  const started = Date.now();
  await assert.rejects(limiter.acquire(), (error: unknown) =>
    error instanceof ConcurrencyLimitTimeoutError && error.waitedMs >= 25);
  assert.ok(Date.now() - started < 500);
  assert.deepEqual(limiter.stats(), { active: 1, waiting: 0 });
  holder();
  (await limiter.acquire())();
});

test("an aborted waiter leaves the queue without taking a slot", async () => {
  const limiter = createConcurrencyLimiter({ maxConcurrent: 1, maxWaitMs: 1000 });
  const holder = await limiter.acquire();
  const controller = new AbortController();
  const waiting = limiter.acquire(controller.signal);
  await tick();
  controller.abort(new Error("client gone"));
  await assert.rejects(waiting, /client gone/);
  assert.deepEqual(limiter.stats(), { active: 1, waiting: 0 });
  holder();
  assert.deepEqual(limiter.stats(), { active: 0, waiting: 0 });
});

test("an already aborted signal is rejected at once", async () => {
  const limiter = createConcurrencyLimiter({ maxConcurrent: 1, maxWaitMs: 1000 });
  await assert.rejects(limiter.acquire(AbortSignal.abort(new Error("gone"))), /gone/);
  assert.deepEqual(limiter.stats(), { active: 0, waiting: 0 });
});

test("rejects a non-positive limit", () => {
  assert.throws(() => createConcurrencyLimiter({ maxConcurrent: 0, maxWaitMs: 10 }));
});
