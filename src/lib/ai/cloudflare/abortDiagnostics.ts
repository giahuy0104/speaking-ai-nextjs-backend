export type FailureSource = "client" | "backend" | "cloudflare" | "network" | "unknown";
export type AbortCause = "client_disconnect" | "request_deadline" | "attempt_timeout" |
  "no_subscribers" | "shutdown" | "unknown";
export type AbortDiagnostics = { failureSource: FailureSource; abortCause: AbortCause };

// Keep provenance out of AbortSignal.reason: it may contain arbitrary client or
// exception text. Weak references need no listeners or request-lifetime cleanup.
const sources = new WeakMap<AbortSignal, () => AbortDiagnostics>();

export function tagAbortSignal(signal: AbortSignal, diagnostics: AbortDiagnostics) {
  sources.set(signal, () => diagnostics);
  return signal;
}

export function clientAbortSignal(signal: AbortSignal) {
  if (!sources.has(signal)) tagAbortSignal(signal, { failureSource: "client", abortCause: "client_disconnect" });
  return signal;
}

export function timeoutSignal(ms: number, abortCause: "request_deadline" | "attempt_timeout") {
  return tagAbortSignal(AbortSignal.timeout(Math.max(1, Math.floor(ms))), { failureSource: "backend", abortCause });
}

export function combineAbortSignals(signals: AbortSignal[]) {
  const combined = AbortSignal.any(signals);
  sources.set(combined, () => {
    const winner = signals.find(signal => signal.aborted && Object.is(signal.reason, combined.reason));
    return winner ? getAbortDiagnostics(winner) : { failureSource: "unknown", abortCause: "unknown" };
  });
  return combined;
}

export function getAbortDiagnostics(signal: AbortSignal): AbortDiagnostics {
  return signal.aborted ? sources.get(signal)?.() ?? { failureSource: "unknown", abortCause: "unknown" }
    : { failureSource: "unknown", abortCause: "unknown" };
}
