/**
 * In-process cap on concurrent calls to a rate-limited provider. Callers over the
 * cap wait in order for a free slot, up to `maxWaitMs`, instead of being sent on
 * and refused (HTTP 429). The cap is per backend process: with N backends sharing
 * one provider account, the account sees up to N x maxConcurrent calls.
 */

export type ReleaseSlot = () => void;

export type ConcurrencyLimiter = Readonly<{
  /** Resolves with a release function once a slot is free. */
  acquire(signal?: AbortSignal): Promise<ReleaseSlot>;
  stats(): { active: number; waiting: number };
}>;

export class ConcurrencyLimitTimeoutError extends Error {
  constructor(readonly waitedMs: number) {
    super(`No free slot after ${waitedMs} ms`);
    this.name = "ConcurrencyLimitTimeoutError";
  }
}

type Waiter = {
  grant: (release: ReleaseSlot) => void;
  fail: (error: unknown) => void;
};

export function createConcurrencyLimiter(options: { maxConcurrent: number; maxWaitMs: number }): ConcurrencyLimiter {
  const { maxConcurrent, maxWaitMs } = options;
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new RangeError("maxConcurrent must be a positive integer");
  }
  let active = 0;
  const queue: Waiter[] = [];

  const newRelease = (): ReleaseSlot => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = queue.shift();
      // The slot passes straight to the next waiter: `active` stays the same.
      if (next) next.grant(newRelease());
      else active--;
    };
  };

  return {
    acquire(signal) {
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (active < maxConcurrent) {
        active++;
        return Promise.resolve(newRelease());
      }
      return new Promise<ReleaseSlot>((resolve, reject) => {
        const startedAt = Date.now();
        const leave = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          const index = queue.indexOf(waiter);
          if (index >= 0) queue.splice(index, 1);
        };
        const onAbort = () => {
          leave();
          reject(signal?.reason);
        };
        const waiter: Waiter = {
          grant: release => {
            leave();
            resolve(release);
          },
          fail: error => {
            leave();
            reject(error);
          },
        };
        const timer = setTimeout(() => waiter.fail(new ConcurrencyLimitTimeoutError(Date.now() - startedAt)), maxWaitMs);
        signal?.addEventListener("abort", onAbort, { once: true });
        queue.push(waiter);
      });
    },
    stats: () => ({ active, waiting: queue.length }),
  };
}
