import { PoolError } from "./providerError";
import type { CloudflareExecutionContext } from "./types";
import { clientAbortSignal, combineAbortSignals, getAbortDiagnostics, timeoutSignal } from "./abortDiagnostics";

export function abortError(signal: AbortSignal) {
  const timeout = signal.reason?.name === "TimeoutError";
  return new PoolError(timeout ? "timeout" : "cancelled", timeout ? 504 : 499, undefined, getAbortDiagnostics(signal));
}

export function remainingMs(context: Pick<CloudflareExecutionContext, "deadlineAt">, now = Date.now()) {
  return Math.max(0, context.deadlineAt - now);
}

export function assertExecutionActive(context: Pick<CloudflareExecutionContext, "signal" | "deadlineAt">, now = Date.now()) {
  if (context.signal.aborted) {
    throw abortError(context.signal);
  }
  if (!remainingMs(context, now)) throw new PoolError("timeout", 504, undefined,
    { failureSource: "backend", abortCause: "request_deadline" });
}

export function createDeadline(timeoutMs: number, clientSignal?: AbortSignal, now = Date.now()) {
  const deadlineSignal = timeoutSignal(timeoutMs, "request_deadline");
  return {
    deadlineAt: now + timeoutMs,
    signal: clientSignal ? combineAbortSignals([clientAbortSignal(clientSignal), deadlineSignal]) : deadlineSignal,
  };
}

export function attemptSignal(context: Pick<CloudflareExecutionContext, "signal" | "deadlineAt">, timeoutMs?: number, now = Date.now()) {
  assertExecutionActive(context, now);
  return combineAbortSignals([context.signal,
    timeoutSignal(Math.min(remainingMs(context, now), timeoutMs ?? Infinity), "attempt_timeout")]);
}

// Covers response body consumption as well as headers, even if an injected
// callback fails to observe its AbortSignal. Late rejection is still observed.
export function withSignal<T>(signal: AbortSignal, callback: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError(signal));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw abortError(signal);
      return callback();
    }).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
