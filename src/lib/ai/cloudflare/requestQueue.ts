import { PoolError } from "./providerError";
import { abortError } from "./deadline";

type Slot = { release: () => void; waitedMs: number };
type Waiting = { grant: () => void; fail: (error: PoolError) => void };

/** Bounded FIFO for one process. Global provider permits still belong to Redis. */
export class RequestQueue {
  private active = 0;
  private readonly pending: Waiting[] = [];

  constructor(private readonly concurrency: number, private readonly capacity: number,
    private readonly clock = Date.now) {}

  get depth() { return this.pending.length; }

  cancelPending() {
    for (const entry of [...this.pending]) entry.fail(new PoolError("cancelled", 499, undefined,
      { failureSource: "backend", abortCause: "shutdown" }));
  }

  private slot(waitedMs: number): Slot {
    this.active++;
    let released = false;
    return { waitedMs, release: () => {
      if (released) return;
      released = true;
      this.active--;
      while (this.active < this.concurrency && this.pending.length) this.pending[0].grant();
    } };
  }

  tryAcquire(): Slot {
    if (this.active >= this.concurrency || this.pending.length) throw new PoolError("capacity", 429, 1_000);
    return this.slot(0);
  }

  acquire(signal: AbortSignal, maxWaitMs: number, onQueued?: (depth: number) => void): Promise<Slot> {
    if (signal.aborted) return Promise.reject(this.abortError(signal));
    if (this.active < this.concurrency && !this.pending.length) return Promise.resolve(this.slot(0));
    if (!maxWaitMs) return Promise.reject(new PoolError("capacity", 429, 1_000));
    if (this.pending.length >= this.capacity) return Promise.reject(new PoolError("queue_full", 429, 1_000));
    const started = this.clock();
    return new Promise((resolve, reject) => {
      let done = false;
      const remove = () => {
        const index = this.pending.indexOf(entry);
        if (index >= 0) this.pending.splice(index, 1);
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      };
      const entry: Waiting = {
        fail: error => { if (!done) { done = true; remove(); reject(error); } },
        grant: () => {
          if (done) return;
          if (signal.aborted) { entry.fail(this.abortError(signal)); return; }
          if (this.clock() - started >= maxWaitMs) { entry.fail(new PoolError("queue_timeout", 429, 1_000)); return; }
          done = true; remove(); resolve(this.slot(this.clock() - started));
        },
      };
      const abort = () => entry.fail(this.abortError(signal));
      const timer = setTimeout(() => entry.fail(new PoolError("queue_timeout", 429, 1_000)), maxWaitMs);
      this.pending.push(entry);
      signal.addEventListener("abort", abort, { once: true });
      // Cover aborts that raced the initial check and listener registration.
      if (signal.aborted) abort();
      if (!done) { try { onQueued?.(this.pending.length); } catch { /* Metrics cannot retain a queue slot. */ } }
    });
  }

  private abortError(signal: AbortSignal) {
    return abortError(signal);
  }
}
