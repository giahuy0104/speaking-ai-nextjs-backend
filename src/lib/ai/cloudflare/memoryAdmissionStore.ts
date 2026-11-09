import { AdmissionStoreError, MAX_COOLDOWN_MS, validateAcquire, validateCompletion, validateRules } from "./admissionStore";
import type { AccountSnapshot, AdmissionAcquireInput, AdmissionOutcome, AdmissionResult, AdmissionStore, Permit, QuotaRule } from "./types";

type RuleState = {
  tokens: number;
  updatedAt: number;
  cooldownUntil: number;
  awaitingProbe: boolean;
  probeLease?: string;
  active: Map<string, number>;
};
type AccountState = {
  rules: Map<string, RuleState>;
  leases: Map<string, Permit>;
  disabledUntil: number;
  awaitingProbe: boolean;
  probeLease?: string;
  retainUntil: number;
  touchedAt: number;
};

/** A single-process development store. It cannot enforce limits across instances. */
export class MemoryAdmissionStore implements AdmissionStore {
  private readonly accounts = new Map<string, AccountState>();
  private latestTime = 0;

  constructor(private readonly clock: () => number = Date.now) {}

  private now() {
    this.latestTime = Math.max(this.latestTime, Math.floor(this.clock()));
    return this.latestTime;
  }

  private account(identity: string, now: number) {
    let state = this.accounts.get(identity);
    if (!state) {
      // Configuration caps account count; also bound accidental use of this store.
      for (const [key, candidate] of this.accounts) {
        if (candidate.retainUntil < now && [...candidate.leases.values()].every((permit) => permit.expiresAt <= now)) this.accounts.delete(key);
      }
      if (this.accounts.size >= 128) throw new AdmissionStoreError();
      state = { rules: new Map(), leases: new Map(), disabledUntil: 0, awaitingProbe: false, touchedAt: now, retainUntil: now + 600_000 };
      this.accounts.set(identity, state);
    }
    state.touchedAt = now;
    for (const [id, permit] of state.leases) {
      if (permit.expiresAt <= now) state.leases.delete(id);
    }
    if (state.probeLease && !state.leases.has(state.probeLease)) state.probeLease = undefined;
    for (const rule of state.rules.values()) {
      for (const [id, expiresAt] of rule.active) if (expiresAt <= now) rule.active.delete(id);
      if (rule.probeLease && !rule.active.has(rule.probeLease)) rule.probeLease = undefined;
    }
    return state;
  }

  private rule(account: AccountState, rule: QuotaRule, now: number) {
    let state = account.rules.get(rule.key);
    if (!state) {
      if (account.rules.size >= 128) throw new AdmissionStoreError();
      state = { tokens: rule.burst ?? 0, updatedAt: now, cooldownUntil: 0, awaitingProbe: false, active: new Map() };
      account.rules.set(rule.key, state);
    }
    if (rule.rpm !== undefined) {
      state.tokens = Math.min(rule.burst!, state.tokens + Math.max(0, now - state.updatedAt) * rule.rpm / 60_000);
      state.updatedAt = now;
    }
    account.retainUntil = Math.max(account.retainUntil, now + 600_000,
      now + (rule.rpm === undefined ? 0 : Math.ceil(rule.burst! * 60_000 / rule.rpm)));
    return state;
  }

  private retryAfter(rule: QuotaRule, state: RuleState, now: number) {
    let retry = Math.max(0, state.cooldownUntil - now);
    if (state.awaitingProbe && state.probeLease) {
      retry = Math.max(retry, (state.active.get(state.probeLease) ?? now) - now);
    }
    if (state.active.size >= rule.maxConcurrent) {
      retry = Math.max(retry, Math.min(...state.active.values()) - now);
    }
    if (rule.rpm !== undefined && state.tokens < 1) {
      retry = Math.max(retry, Math.ceil((1 - state.tokens) * 60_000 / rule.rpm));
    }
    return Math.ceil(retry);
  }

  async acquire(input: AdmissionAcquireInput): Promise<AdmissionResult> {
    validateAcquire(input);
    const now = this.now();
    const account = this.account(input.accountIdentity, now);
    const existing = account.leases.get(input.leaseId);
    if (existing) {
      if (JSON.stringify(existing.ruleKeys) !== JSON.stringify(input.rules.map((rule) => rule.key))) {
        throw new AdmissionStoreError("invalid_store_input");
      }
      return { granted: true, permit: existing };
    }
    const accountRetry = Math.max(0, account.disabledUntil - now,
      account.awaitingProbe && account.probeLease ? (account.leases.get(account.probeLease)?.expiresAt ?? now) - now : 0);
    if (accountRetry > 0) return { granted: false, retryAfterMs: accountRetry };
    const states = input.rules.map((rule) => this.rule(account, rule, now));
    const retryAfterMs = Math.max(...input.rules.map((rule, index) => this.retryAfter(rule, states[index], now)));
    if (retryAfterMs > 0) return { granted: false, retryAfterMs };
    const expiresAt = now + input.ttlMs;
    const probe = account.awaitingProbe || states.some((state) => state.awaitingProbe);
    const permit: Permit = Object.freeze({ id: input.leaseId, accountIdentity: input.accountIdentity,
      ruleKeys: Object.freeze(input.rules.map((rule) => rule.key)), expiresAt, probe });
    for (let index = 0; index < states.length; index++) {
      const state = states[index];
      if (input.rules[index].rpm !== undefined) state.tokens = Math.max(0, state.tokens - 1);
      state.active.set(input.leaseId, expiresAt);
      if (state.awaitingProbe) state.probeLease = input.leaseId;
    }
    account.leases.set(input.leaseId, permit);
    if (account.awaitingProbe) account.probeLease = input.leaseId;
    account.retainUntil = Math.max(account.retainUntil, expiresAt + 600_000);
    return { granted: true, permit };
  }

  async complete(permit: Permit, outcome: AdmissionOutcome): Promise<void> {
    validateCompletion(permit, outcome);
    const now = this.now();
    const account = this.accounts.get(permit.accountIdentity);
    const existing = account?.leases.get(permit.id);
    if (!account || !existing || existing.expiresAt !== permit.expiresAt || existing.expiresAt <= now ||
      JSON.stringify(existing.ruleKeys) !== JSON.stringify(permit.ruleKeys)) return;
    if (outcome.disable) {
      account.disabledUntil = Math.max(account.disabledUntil, now + MAX_COOLDOWN_MS);
      account.awaitingProbe = true;
      account.probeLease = undefined;
    } else if (account.probeLease === permit.id) {
      account.disabledUntil = outcome.cooldownMs ? now + outcome.cooldownMs : 0;
      account.awaitingProbe = Boolean(outcome.cooldownMs);
      account.probeLease = undefined;
    }
    account.retainUntil = Math.max(account.retainUntil, account.disabledUntil + 600_000,
      now + (outcome.cooldownMs ?? 0) + 600_000);
    const scopes = outcome.scopeKeys ?? permit.ruleKeys;
    for (const key of existing.ruleKeys) {
      const state = account.rules.get(key)!;
      if (outcome.cooldownMs && scopes.includes(key)) {
        state.cooldownUntil = Math.max(state.cooldownUntil, now + outcome.cooldownMs);
        state.awaitingProbe = true;
        state.probeLease = undefined;
      } else if (state.probeLease === permit.id) {
        state.awaitingProbe = false;
        state.probeLease = undefined;
      }
      state.active.delete(permit.id);
    }
    account.leases.delete(permit.id);
  }

  async snapshot(accountIdentity: string, rules: readonly QuotaRule[]): Promise<AccountSnapshot> {
    validateRules(accountIdentity, rules);
    const now = this.now();
    const account = this.account(accountIdentity, now);
    const states = rules.map((rule) => this.rule(account, rule, now));
    return { active: Math.max(...states.map((state) => state.active.size)),
      retryAfterMs: Math.max(0, account.disabledUntil - now,
        account.awaitingProbe && account.probeLease ? (account.leases.get(account.probeLease)?.expiresAt ?? now) - now : 0,
        ...rules.map((rule, index) => this.retryAfter(rule, states[index], now))) };
  }

  async close() { this.accounts.clear(); }
}
