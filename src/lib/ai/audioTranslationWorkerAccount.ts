import { AppError } from "../appError";
import { isPoolFailure, isTransientPoolFailure } from "./cloudflare/providerError";

type WorkerEnvironment = Record<string, string | undefined>;
type PoolAccountSummary = { alias: string; enabled: boolean };

/**
 * AUDIO_TRANSLATION_JOB_WORKER_ACCOUNT pins one worker process to one pool
 * account (by alias). Unset keeps the default: the worker shares every account.
 * A pinned worker must not start against an account it can never use.
 */
export function resolveWorkerAccountAlias(env: WorkerEnvironment, accounts: readonly PoolAccountSummary[]): string | undefined {
  const alias = env.AUDIO_TRANSLATION_JOB_WORKER_ACCOUNT?.trim();
  if (!alias) return undefined;
  if (!accounts.some(account => account.alias === alias && account.enabled)) throw new Error("job_worker_account_unavailable");
  return alias;
}

type PinnedJobFailure = {
  accountAlias: string | undefined;
  error: unknown;
  /** CLOUDFLARE_POOL_RETRY_TRANSIENT: whether a transient fault may be attempted once more at all. */
  retryTransientFaults: boolean;
  providerAttemptsUsed: number;
  providerAttemptsMax: number;
};

/**
 * A shared worker retries a rejected or transiently failed provider call on
 * another account inside the dispatcher. A pinned worker has no other account,
 * so the same failures send the job back to the queue for any worker to continue.
 * Admission rejections (capacity, queue timeout) are requeued by the worker's own rule.
 */
export function shouldRequeuePinnedJob(failure: PinnedJobFailure): boolean {
  if (!failure.accountAlias) return false;
  if (failure.providerAttemptsUsed >= failure.providerAttemptsMax) return false;
  // A 429 is a confirmed rejection: the provider ran nothing.
  if (failureReason(failure.error) === "rate_limited") return true;
  return failure.retryTransientFaults && isTransientPoolFailure(failure.error);
}

/** The text stage projects pool failures to AppError before the worker sees them; the reason survives in details. */
function failureReason(error: unknown): unknown {
  if (isPoolFailure(error)) return error.reason;
  if (error instanceof AppError) return (error.details as { reason?: unknown } | undefined)?.reason;
  return undefined;
}
