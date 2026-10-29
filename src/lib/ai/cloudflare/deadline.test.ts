import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { assertExecutionActive, attemptSignal, createDeadline, remainingMs, withSignal } from "./deadline";
import { combineAbortSignals, getAbortDiagnostics, tagAbortSignal, timeoutSignal } from "./abortDiagnostics";
import { getFailureDiagnostics } from "./providerError";

test("remaining budget is tied to one absolute deadline", () => {
  const deadline = createDeadline(1000, undefined, 500);
  assert.equal(deadline.deadlineAt, 1500);
  assert.equal(remainingMs(deadline, 700), 800);
  assert.equal(remainingMs(deadline, 1600), 0);
  assert.throws(() => assertExecutionActive(deadline, 1500), { reason: "timeout", status: 504 });
});

test("client cancellation wins before callback and body timeout bounds completion", async () => {
  const client = new AbortController(); client.abort();
  const deadline = createDeadline(1000, client.signal);
  let called = false;
  await assert.rejects(withSignal(deadline.signal, async () => { called = true; }), { reason: "cancelled" });
  assert.equal(called, false);
  await assert.rejects(withSignal(AbortSignal.timeout(5), async () => { await delay(30); return "late body"; }), { reason: "timeout" });
});

test("client abort provenance survives nested signals without retaining the abort message", async () => {
  const client = new AbortController();
  const deadline = createDeadline(1000, client.signal);
  const nested = combineAbortSignals([deadline.signal, timeoutSignal(1000, "attempt_timeout")]);
  client.abort(new Error("private request URL and token"));
  await assert.rejects(withSignal(nested, async () => "unused"), error => {
    assert.deepEqual(getFailureDiagnostics(error), { failureSource: "client", abortCause: "client_disconnect" });
    assert.doesNotMatch(JSON.stringify(error), /private|token/);
    return true;
  });
});

test("request deadlines and provider attempt timeouts have distinct backend causes", async () => {
  const request = createDeadline(5);
  await assert.rejects(withSignal(request.signal, () => delay(30)), error => {
    assert.deepEqual(getFailureDiagnostics(error), { failureSource: "backend", abortCause: "request_deadline" });
    return true;
  });
  const signal = attemptSignal(createDeadline(1000), 5);
  await assert.rejects(withSignal(signal, () => delay(30)), error => {
    assert.deepEqual(getFailureDiagnostics(error), { failureSource: "backend", abortCause: "attempt_timeout" });
    return true;
  });
});

test("the first abort remains the cause when another source aborts later", () => {
  const backend = new AbortController();
  tagAbortSignal(backend.signal, { failureSource: "backend", abortCause: "shutdown" });
  const client = new AbortController();
  const combined = combineAbortSignals([createDeadline(1000, client.signal).signal, backend.signal]);
  backend.abort(); client.abort();
  assert.deepEqual(getAbortDiagnostics(combined), { failureSource: "backend", abortCause: "shutdown" });
});
