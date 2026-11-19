/**
 * Fan-out of one speech clip that is still being generated. Every subscriber
 * gets the clip from its first byte, then live chunks as they arrive, so a
 * request that joins late plays the same audio as the first one. The producer
 * never depends on a listener: a listener that goes away does not stop it, and
 * `completed` resolves with the whole clip for the durable cache.
 */

export type SpeechBroadcast = Readonly<{
  push(chunk: Uint8Array): void;
  finish(): void;
  fail(error: unknown): void;
  /** True once any byte was pushed: a fallback can no longer replace the clip. */
  started(): boolean;
  /** True until finish() or fail(). */
  live(): boolean;
  subscribe(): ReadableStream<Uint8Array>;
  /**
   * Resolves at the first byte; rejects with the error when the clip fails before
   * any byte. A response can wait on it, so a refusal still becomes an HTTP error
   * instead of a 200 that breaks off with no audio.
   */
  audible: Promise<void>;
  completed: Promise<ArrayBuffer>;
}>;

type State = { kind: "live" } | { kind: "done" } | { kind: "failed"; error: unknown };

export function createSpeechBroadcast(maxBytes: number): SpeechBroadcast {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let state: State = { kind: "live" };
  let wake: Array<() => void> = [];
  let resolveCompleted!: (audio: ArrayBuffer) => void;
  let rejectCompleted!: (error: unknown) => void;
  const completed = new Promise<ArrayBuffer>((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  // Listeners report the error themselves; this keeps an unobserved rejection quiet.
  completed.catch(() => undefined);
  let resolveAudible!: () => void;
  let rejectAudible!: (error: unknown) => void;
  const audible = new Promise<void>((resolve, reject) => {
    resolveAudible = resolve;
    rejectAudible = reject;
  });
  audible.catch(() => undefined);

  const notify = () => {
    const waiting = wake;
    wake = [];
    for (const resume of waiting) resume();
  };

  const settle = (next: State) => {
    if (state.kind !== "live") return;
    state = next;
    if (next.kind === "done") resolveCompleted(concat(chunks, total));
    else if (next.kind === "failed") {
      rejectCompleted(next.error);
      // No effect once a byte was pushed: `audible` already resolved.
      rejectAudible(next.error);
    }
    notify();
  };

  return {
    push(chunk) {
      if (state.kind !== "live" || chunk.byteLength === 0) return;
      if (total + chunk.byteLength > maxBytes) {
        settle({ kind: "failed", error: new Error("speech_too_large") });
        return;
      }
      chunks.push(chunk);
      total += chunk.byteLength;
      resolveAudible();
      notify();
    },
    finish() {
      if (total === 0) settle({ kind: "failed", error: new Error("speech_empty") });
      else settle({ kind: "done" });
    },
    fail(error) {
      settle({ kind: "failed", error });
    },
    started: () => total > 0,
    live: () => state.kind === "live",
    subscribe() {
      let index = 0;
      let cancelled = false;
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          for (;;) {
            if (cancelled) return;
            if (index < chunks.length) {
              controller.enqueue(chunks[index++]);
              return;
            }
            if (state.kind === "done") {
              controller.close();
              return;
            }
            if (state.kind === "failed") {
              controller.error(state.error);
              return;
            }
            await new Promise<void>(resume => wake.push(resume));
          }
        },
        cancel() {
          cancelled = true;
        },
      });
    },
    audible,
    completed,
  };
}

function concat(chunks: readonly Uint8Array[], total: number): ArrayBuffer {
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined.buffer;
}
