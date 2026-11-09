export type LoadStopReason = "duration" | "request_limit" | "memory_pressure" | "interrupted" | "burst_complete";
export type MemorySnapshot = { usedPercent: number; freeBytes: number };

/** Stop admission independently of HTTP cancellation, so active requests always drain. */
export async function runAudioLoadWorkers(options: {
  clients: number;
  mode: "burst" | "sustained";
  maxRequests: number;
  sendUntil: number;
  now: () => number;
  readMemory: () => MemorySnapshot;
  maxUsedMemoryPercent: number;
  minFreeMemoryBytes: number;
  send: (sequence: number) => Promise<void>;
  stopSignal?: AbortSignal;
  onStop?: (reason: LoadStopReason, memory: MemorySnapshot) => void;
}) {
  let admitted = 0;
  let stopReason: LoadStopReason | undefined;
  let memory = options.readMemory();
  let peakUsedMemoryPercent = memory.usedPercent;
  let minimumFreeBytes = memory.freeBytes;
  const stop = (reason: LoadStopReason) => {
    if (stopReason) return;
    stopReason = reason;
    options.onStop?.(reason, memory);
  };
  const onAbort = () => stop("interrupted");
  options.stopSignal?.addEventListener("abort", onAbort, { once: true });
  if (options.stopSignal?.aborted) onAbort();

  const next = () => {
    if (stopReason) return undefined;
    if (admitted >= options.maxRequests) { stop("request_limit"); return undefined; }
    if (options.mode === "sustained" && options.now() >= options.sendUntil) {
      stop("duration"); return undefined;
    }
    memory = options.readMemory();
    peakUsedMemoryPercent = Math.max(peakUsedMemoryPercent, memory.usedPercent);
    minimumFreeBytes = Math.min(minimumFreeBytes, memory.freeBytes);
    if (memory.usedPercent >= options.maxUsedMemoryPercent || memory.freeBytes < options.minFreeMemoryBytes) {
      stop("memory_pressure"); return undefined;
    }
    return admitted++;
  };

  try {
    const results = await Promise.allSettled(Array.from({ length: options.clients }, async () => {
      while (true) {
        const sequence = next();
        if (sequence === undefined) return;
        // The admission stopSignal is deliberately never passed to the request.
        await options.send(sequence);
        if (options.mode === "burst") return;
      }
    }));
    const failed = results.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  } finally {
    options.stopSignal?.removeEventListener("abort", onAbort);
  }
  return {
    admitted,
    stopReason: stopReason ?? "burst_complete",
    peakUsedMemoryPercent,
    minimumFreeMemoryMB: Math.round(minimumFreeBytes / 1024 / 1024),
  };
}
