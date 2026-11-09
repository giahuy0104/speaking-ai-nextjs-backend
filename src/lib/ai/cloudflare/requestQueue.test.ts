import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { RequestQueue } from "./requestQueue";
import { getFailureDiagnostics } from "./providerError";

test("a simultaneous burst is processed FIFO without exceeding process concurrency", async () => {
  const queue = new RequestQueue(2, 8);
  let active = 0; let peak = 0;
  const order: number[] = [];
  await Promise.all(Array.from({ length: 10 }, async (_, index) => {
    const slot = await queue.acquire(new AbortController().signal, 2000);
    order.push(index); peak = Math.max(peak, ++active);
    try { await delay(5); } finally { active--; slot.release(); slot.release(); }
  }));
  assert.equal(peak, 2);
  assert.equal(queue.depth, 0);
  assert.deepEqual(order, Array.from({ length: 10 }, (_, index) => index));
  queue.tryAcquire().release();
});

test("shutdown rejects queued work without waiting for its timer", async () => {
  const queue = new RequestQueue(1, 1);
  const active = queue.tryAcquire();
  const pending = queue.acquire(new AbortController().signal, 5000);
  queue.cancelPending();
  await assert.rejects(pending, error => {
    assert.deepEqual(getFailureDiagnostics(error), { failureSource: "backend", abortCause: "shutdown" });
    return true;
  });
  assert.equal(queue.depth, 0);
  active.release();
});

test("overflow and cancelled queued requests release their queue places", async () => {
  const queue = new RequestQueue(1, 1);
  const first = queue.tryAcquire();
  const controller = new AbortController();
  const waiting = queue.acquire(controller.signal, 1000);
  await assert.rejects(queue.acquire(new AbortController().signal, 1000), { reason: "queue_full", status: 429 });
  controller.abort();
  await assert.rejects(waiting, { reason: "cancelled", status: 499 });
  assert.equal(queue.depth, 0);
  const next = queue.acquire(new AbortController().signal, 1000);
  first.release();
  (await next).release();
  queue.tryAcquire().release();
});

test("queue wait and total request deadline expire independently and clean up", async () => {
  const queue = new RequestQueue(1, 2);
  const first = queue.tryAcquire();
  await assert.rejects(queue.acquire(new AbortController().signal, 15), { reason: "queue_timeout", status: 429 });
  const controller = new AbortController();
  const timeout = queue.acquire(controller.signal, 1000);
  controller.abort(new DOMException("expired", "TimeoutError"));
  await assert.rejects(timeout, { reason: "timeout", status: 504 });
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(queue.acquire(aborted.signal, 1000), { reason: "cancelled" });
  assert.equal(queue.depth, 0);
  first.release();
  queue.tryAcquire().release();
});
