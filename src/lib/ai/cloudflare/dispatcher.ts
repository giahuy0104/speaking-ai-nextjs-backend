import { randomInt, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { assertExecutionActive, attemptSignal, remainingMs, withSignal } from "./deadline";
import { getFailureDiagnostics, PoolError, ProviderFault } from "./providerError";
import { operationTask, quotaRules } from "./quotaPolicy";
import { emitTelemetry, type TelemetrySink } from "./telemetry";
import type { AdmissionOutcome, AdmissionStore, CloudflareAccount, CloudflareDispatcher, PoolConfig } from "./types";

type AdmissionLane = { tickets: symbol[]; wakeups: Set<() => void> };

export class AccountDispatcher implements CloudflareDispatcher {
  private cursor: number;
  private waiting = 0;
  private textWaiting = 0;
  private readonly waitBudgets = new WeakMap<object, { usedMs: number }>();
  private readonly lanes = new Map<string, AdmissionLane>();
  constructor(private readonly config: PoolConfig, private readonly store: AdmissionStore,
    private readonly sink?: TelemetrySink, private readonly clock = Date.now) {
    this.cursor = randomInt(Math.max(1, config.accounts.length));
  }

  private wakeAdmissions() {
    for (const lane of this.lanes.values()) {
      for (const wake of lane.wakeups) wake();
    }
  }

  private async waitForAdmissionChange(lane: AdmissionLane | undefined, ms: number, signal: AbortSignal) {
    const changed = new AbortController();
    const wake = () => changed.abort();
    lane?.wakeups.add(wake);
    try {
      await delay(ms, undefined, { signal: AbortSignal.any([signal, changed.signal]) });
    } catch (error) {
      // A local release wakes admission immediately. Remote releases are still
      // discovered by bounded polling against the shared, atomic Redis store.
      if (!changed.signal.aborted || signal.aborted) throw error;
    } finally { lane?.wakeups.delete(wake); }
  }

  private async acquire(input: Parameters<CloudflareDispatcher["execute"]>[0],
    accounts: readonly CloudflareAccount[], base: Record<string, string>, lastFault?: ProviderFault) {
    const { context, operation, model } = input;
    const budget = context.admissionWait ?? this.waitBudgets.get(context.attempts) ?? { usedMs: 0 };
    this.waitBudgets.set(context.attempts, budget);
    let waitStarted: number | undefined;
    let waitSignal = context.signal;
    let rounds = 0;
    const fail = (reason: "capacity" | "queue_full" | "queue_timeout", retryAfterMs = 1_000): never => {
      emitTelemetry(this.sink, "cloudflare_pool_unavailable", { ...base, safeReason: reason });
      throw lastFault ?? new PoolError(reason, 429, retryAfterMs);
    };
    // Register before the first Redis await: a newcomer must not race ahead of
    // an older stage that is sleeping or still checking account availability.
    // Lanes only order acquisitions, not inference; ASR and text stay independent.
    const laneKey = `${operationTask(operation)}:${model}`;
    let lane: AdmissionLane | undefined;
    const ticket = Symbol();
    if (accounts.length && this.config.maxWaitMs && this.config.maxQueued) {
      lane = this.lanes.get(laneKey);
      if (!lane) { lane = { tickets: [], wakeups: new Set() }; this.lanes.set(laneKey, lane); }
      lane.tickets.push(ticket);
    }
    try {
      for (;;) {
        assertExecutionActive(context, this.clock());
        if (remainingMs(context, this.clock()) < this.config.minAttemptMs) throw new PoolError("timeout", 504);
        const waitedMs = waitStarted === undefined ? 0 : this.clock() - waitStarted;
        if (waitStarted !== undefined && budget.usedMs + waitedMs >= this.config.maxWaitMs) fail("queue_timeout");
        let retryAfterMs = Infinity;
        const textBacklogFull = operationTask(operation) === "asr" && (this.config.textBacklogThreshold ?? 0) > 0 &&
          this.textWaiting >= this.config.textBacklogThreshold!;
        if ((!lane || lane.tickets[0] === ticket) && !textBacklogFull) {
          let candidates;
          try {
            candidates = await withSignal(waitSignal, () => Promise.all(accounts.map(async account => {
              const rules = quotaRules(account, operation, model);
              const snapshot = await this.store.snapshot(account.identity, rules);
              return { account, rules, snapshot };
            })));
          } catch (error) { throw error instanceof PoolError ? error : new PoolError("store_unavailable"); }
          candidates.sort((a, b) => a.snapshot.active / a.account.limits.accountMaxConcurrent
            - b.snapshot.active / b.account.limits.accountMaxConcurrent);
          for (const candidate of candidates) {
            assertExecutionActive(context, this.clock());
            try {
              const admission = await withSignal(waitSignal, () => this.store.acquire({
                accountIdentity: candidate.account.identity, rules: candidate.rules,
                leaseId: randomUUID(), ttlMs: Math.max(1, remainingMs(context, this.clock())) + 5_000,
              }));
              if (admission.granted) return {
                account: candidate.account, permit: admission.permit,
                waitedMs: waitStarted === undefined ? 0 : this.clock() - waitStarted,
              };
              retryAfterMs = Math.min(retryAfterMs, admission.retryAfterMs);
            } catch (error) { throw error instanceof PoolError ? error : new PoolError("store_unavailable"); }
          }
        }
        if (!accounts.length || !this.config.maxWaitMs) fail("capacity", Number.isFinite(retryAfterMs) ? retryAfterMs : 1_000);
        if (waitStarted === undefined) {
          if (budget.usedMs >= this.config.maxWaitMs) fail("queue_timeout");
          if (this.waiting >= this.config.maxQueued) fail("queue_full");
          waitStarted = this.clock();
          this.waiting++;
          if (operationTask(operation) === "text") this.textWaiting++;
          waitSignal = AbortSignal.any([context.signal, AbortSignal.timeout(Math.max(1, this.config.maxWaitMs - budget.usedMs))]);
          emitTelemetry(this.sink, "cloudflare_pool_queued", { ...base, queueDepth: this.waiting });
        }
        const remainingWait = this.config.maxWaitMs - budget.usedMs - (this.clock() - waitStarted);
        if (remainingWait <= 0) fail("queue_timeout");
        // A concurrency retryAfter may be a lease TTL, not the actual finish time.
        // Poll at a bounded, jittered rate so another process releasing a permit
        // is noticed without a Redis subscription or an unbounded retry storm.
        const pollMs = Math.min(250, 50 * 2 ** Math.min(rounds++, 2)) + randomInt(26);
        await this.waitForAdmissionChange(lane, Math.max(1, Math.min(pollMs,
          Number.isFinite(retryAfterMs) ? Math.max(25, retryAfterMs) : pollMs,
          remainingWait, remainingMs(context, this.clock()))), waitSignal);
      }
    } catch (error) {
      if (waitSignal.aborted && !context.signal.aborted && remainingMs(context, this.clock()) > 0) fail("queue_timeout");
      assertExecutionActive(context, this.clock());
      throw error;
    } finally {
      if (waitStarted !== undefined) {
        this.waiting--;
        if (operationTask(operation) === "text") this.textWaiting--;
        budget.usedMs += Math.max(0, this.clock() - waitStarted);
        this.wakeAdmissions();
      }
      if (lane) {
        lane.tickets.splice(lane.tickets.indexOf(ticket), 1);
        for (const wake of lane.wakeups) wake();
        if (!lane.tickets.length) this.lanes.delete(laneKey);
      }
    }
  }

  async execute<T>(input: Parameters<CloudflareDispatcher["execute"]>[0],
    callback: (input: { account: CloudflareAccount; signal: AbortSignal }) => Promise<T>): Promise<T> {
    const { context, operation, model } = input;
    const task = operationTask(operation);
    const base = { requestId: context.requestId, workload: context.workload, stage: operation,
      model, configVersion: this.config.configVersion,
      ...(context.parentRequestId ? { parentRequestId: context.parentRequestId } : {}) };
    const eligible = this.config.accounts.filter(a => a.enabled && a.capabilities[task]?.includes(model) &&
      (!input.accountIdentity || a.identity === input.accountIdentity) &&
      (a.identity !== this.config.legacyAccountIdentity || this.config.routeLegacyAccount || input.accountIdentity === a.identity));
    if (!eligible.length && input.accountIdentity) throw new PoolError("configuration");
    const offset = this.cursor++ % Math.max(1, eligible.length);
    const rotated = [...eligible.slice(offset), ...eligible.slice(0, offset)];
    const attempted = new Set<string>();
    let lastFault: ProviderFault | undefined;
    for (let stageAttempt = 0; stageAttempt < this.config.maxAttemptsPerStage; stageAttempt++) {
      assertExecutionActive(context, this.clock());
      if (context.attempts.used >= context.attempts.max) throw lastFault ?? new PoolError("attempt_budget");
      if (remainingMs(context, this.clock()) < this.config.minAttemptMs) throw lastFault ?? new PoolError("timeout", 504);
      const { account, permit, waitedMs } = await this.acquire(input,
        rotated.filter(account => !attempted.has(account.identity)), base, lastFault);
      attempted.add(account.identity);
      const startedAt = this.clock();
      let outcome: AdmissionOutcome = {};
      let retry = false;
      try {
        assertExecutionActive(context, this.clock());
        if (remainingMs(context, this.clock()) < this.config.minAttemptMs) throw lastFault ?? new PoolError("timeout", 504);
        if (context.attempts.used >= context.attempts.max) throw lastFault ?? new PoolError("attempt_budget");
        context.attempts.used++;
        const signal = attemptSignal(context, input.timeoutMs, this.clock());
        emitTelemetry(this.sink, "cloudflare_pool_admission", { ...base, accountAlias: account.alias,
          attempt: context.attempts.used, remainingBudgetMs: remainingMs(context, this.clock()), admissionWaitMs: waitedMs });
        const result = await withSignal(signal, () => callback({ account, signal }));
        assertExecutionActive(context, this.clock());
        emitTelemetry(this.sink, "cloudflare_pool_attempt_completed", { ...base, accountAlias: account.alias,
          attempt: context.attempts.used, providerElapsedMs: this.clock() - startedAt, status: "success" });
        return result;
      } catch (error) {
        // A failed half-open probe must not reopen the account to a burst.
        // A cancelled probe is eligible for another single probe immediately.
        if (permit.probe && (error instanceof PoolError || error instanceof ProviderFault &&
          (error.reason === "network_error" || error.reason === "timeout" || error.reason === "cancelled" || (error.status ?? 0) >= 500))) {
          outcome = { cooldownMs: error.reason === "cancelled" ? 1 : 1_000, scopeKeys: ["account"] };
        }
        if (error instanceof ProviderFault) {
          lastFault = error;
          // A legacy-only model may be forbidden even when the account's ASR/text
          // credentials work. Do not disable every workload on that model's 403.
          if (error.reason === "credentials" && !(context.workload.startsWith("legacy-") && error.status === 403)) {
            outcome = { disable: true, scopeKeys: ["account"] };
          }
          if (error.reason === "rate_limited") {
            outcome = { cooldownMs: Math.max(100, error.retryAfterMs ?? 1_000), scopeKeys: ["account"] };
            retry = stageAttempt + 1 < this.config.maxAttemptsPerStage && context.attempts.used < context.attempts.max;
          }
        }
        const diagnostics = getFailureDiagnostics(error);
        emitTelemetry(this.sink, "cloudflare_pool_attempt_completed", { ...base, accountAlias: account.alias,
          attempt: context.attempts.used, providerElapsedMs: this.clock() - startedAt,
          safeReason: error instanceof ProviderFault || error instanceof PoolError ? error.reason : "callback_error",
          status: error instanceof ProviderFault ? error.status : undefined,
          failureSource: diagnostics.failureSource, abortCause: diagnostics.abortCause,
          upstreamStatus: diagnostics.upstreamStatus,
          upstreamCodes: error instanceof ProviderFault ? error.codes.slice(0, 8).join(",") : undefined });
        if (!retry) throw error;
      } finally {
        try {
          await withSignal(AbortSignal.timeout(1_000), () => this.store.complete(permit, outcome));
          if (outcome.cooldownMs || outcome.disable) emitTelemetry(this.sink, "cloudflare_pool_cooldown",
            { ...base, accountAlias: account.alias, safeReason: outcome.disable ? "credentials" : "rate_limited" });
        } catch {
          // An uncertain completion never triggers another inference. The lease
          // expires automatically and a successful answer stays successful.
          retry = false;
          emitTelemetry(this.sink, "cloudflare_pool_cleanup_failed", { ...base, accountAlias: account.alias, safeReason: "store_unavailable" });
        }
        this.wakeAdmissions();
      }
      if (!retry) throw lastFault ?? new PoolError("store_unavailable");
    }
    throw lastFault ?? new PoolError("capacity", 429);
  }
}
