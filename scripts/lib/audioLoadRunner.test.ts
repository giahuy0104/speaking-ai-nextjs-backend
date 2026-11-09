import assert from "node:assert/strict";
import test from "node:test";
import { runAudioLoadWorkers } from "./audioLoadRunner";

const healthy = () => ({ usedPercent: 80, freeBytes: 3 * 1024 ** 3 });
const defaults = {
  clients: 2,
  mode: "sustained" as const,
  maxRequests: 10,
  sendUntil: 100,
  now: () => 0,
  readMemory: healthy,
  maxUsedMemoryPercent: 90,
  minFreeMemoryBytes: 1024 ** 3,
};

test("memory pressure stops new work and waits for the active HTTP request", async () => {
  let reads = 0;
  let completed = false;
  let settled = false;
  let release!: () => void;
  const active = new Promise<void>(resolve => { release = resolve; });
  const result = runAudioLoadWorkers({
    ...defaults,
    readMemory: () => ++reads < 3 ? healthy() : { usedPercent: 98.18, freeBytes: 300 * 1024 ** 2 },
    send: async () => { await active; completed = true; },
  }).then(report => { settled = true; return report; });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(completed, false);
  release();
  const report = await result;
  assert.equal(completed, true);
  assert.equal(report.admitted, 1);
  assert.equal(report.stopReason, "memory_pressure");
});

test("request cap cannot be exceeded by concurrent virtual users", async () => {
  const sent: number[] = [];
  const report = await runAudioLoadWorkers({ ...defaults, clients: 20, maxRequests: 3,
    send: async sequence => { sent.push(sequence); } });
  assert.deepEqual(sent, [0, 1, 2]);
  assert.equal(report.admitted, 3);
  assert.equal(report.stopReason, "request_limit");
});

test("send window closes after the active request completes", async () => {
  let now = 0;
  const report = await runAudioLoadWorkers({ ...defaults, clients: 1, now: () => now,
    send: async () => { now = 101; } });
  assert.equal(report.admitted, 1);
  assert.equal(report.stopReason, "duration");
});

test("interrupt stops admission while allowing an in-flight request to finish", async () => {
  const controller = new AbortController();
  let completed = 0;
  const report = await runAudioLoadWorkers({ ...defaults, stopSignal: controller.signal,
    send: async () => { controller.abort(); await Promise.resolve(); completed++; } });
  assert.equal(completed, 1);
  assert.equal(report.admitted, 1);
  assert.equal(report.stopReason, "interrupted");
});

test("a burst sends exactly one request for each of 20 virtual users", async () => {
  const sent: number[] = [];
  const report = await runAudioLoadWorkers({ ...defaults, clients: 20, mode: "burst", maxRequests: 20,
    send: async sequence => { sent.push(sequence); } });
  assert.equal(new Set(sent).size, 20);
  assert.equal(report.admitted, 20);
  assert.equal(report.stopReason, "burst_complete");
});
