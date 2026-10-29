import type { AdmissionAcquireInput, AdmissionOutcome, Permit, QuotaRule } from "./types";

export class AdmissionStoreError extends Error {
  constructor(readonly reason: "store_unavailable" | "invalid_store_input" = "store_unavailable") {
    super("Cloudflare admission store unavailable");
    this.name = "AdmissionStoreError";
  }
}

export const MAX_STORE_RULES = 64;
export const MAX_LEASE_TTL_MS = 120_000;
export const MAX_COOLDOWN_MS = 86_400_000;

export function validateRules(accountIdentity: string, rules: readonly QuotaRule[]) {
  if (!/^[a-zA-Z0-9:_-]{1,128}$/.test(accountIdentity) || rules.length < 1 || rules.length > MAX_STORE_RULES) {
    throw new AdmissionStoreError("invalid_store_input");
  }
  const keys = new Set<string>();
  for (const rule of rules) {
    if (typeof rule.key !== "string" || rule.key.length < 1 || rule.key.length > 256 || keys.has(rule.key) ||
      !Number.isInteger(rule.maxConcurrent) || rule.maxConcurrent < 1 || rule.maxConcurrent > 10_000 ||
      (rule.rpm === undefined) !== (rule.burst === undefined) ||
      (rule.rpm !== undefined && (!Number.isFinite(rule.rpm) || rule.rpm < 1 || rule.rpm > 1_000_000 ||
        !Number.isInteger(rule.burst) || rule.burst! < 1 || rule.burst! > 10_000))) {
      throw new AdmissionStoreError("invalid_store_input");
    }
    keys.add(rule.key);
  }
}

export function validateAcquire(input: AdmissionAcquireInput) {
  validateRules(input.accountIdentity, input.rules);
  if (!/^[a-zA-Z0-9:_-]{1,128}$/.test(input.leaseId) || !Number.isInteger(input.ttlMs) ||
    input.ttlMs < 1 || input.ttlMs > MAX_LEASE_TTL_MS) {
    throw new AdmissionStoreError("invalid_store_input");
  }
}

export function validateCompletion(permit: Permit, outcome: AdmissionOutcome) {
  if (!/^[a-zA-Z0-9:_-]{1,128}$/.test(permit.accountIdentity) || !/^[a-zA-Z0-9:_-]{1,128}$/.test(permit.id) ||
    !Number.isSafeInteger(permit.expiresAt) || permit.ruleKeys.length < 1 || permit.ruleKeys.length > MAX_STORE_RULES ||
    permit.ruleKeys.some((key) => typeof key !== "string" || key.length < 1 || key.length > 256) ||
    new Set(permit.ruleKeys).size !== permit.ruleKeys.length ||
    (outcome.cooldownMs !== undefined && (!Number.isInteger(outcome.cooldownMs) || outcome.cooldownMs < 0 || outcome.cooldownMs > MAX_COOLDOWN_MS)) ||
    outcome.scopeKeys?.some((key) => !permit.ruleKeys.includes(key))) {
    throw new AdmissionStoreError("invalid_store_input");
  }
}
