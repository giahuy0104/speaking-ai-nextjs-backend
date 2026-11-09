import { createHash } from "node:crypto";
import { AdmissionStoreError, validateAcquire, validateCompletion, validateRules } from "./admissionStore";
import { isNoScriptError, type PoolRedisClient } from "./redisClient";
import { ACQUIRE_SCRIPT, COMPLETE_SCRIPT, SNAPSHOT_SCRIPT } from "./redisScripts";
import type { AccountSnapshot, AdmissionAcquireInput, AdmissionOutcome, AdmissionResult, AdmissionStore, Permit, QuotaRule } from "./types";

function numericReply(value: unknown, length: number): number[] {
  if (!Array.isArray(value) || value.length !== length || value.some((item) => typeof item !== "number" || !Number.isSafeInteger(item) || item < 0)) {
    throw new AdmissionStoreError();
  }
  return value as number[];
}

export class RedisAdmissionStore implements AdmissionStore {
  constructor(private readonly client: PoolRedisClient, private readonly namespace: string) {
    if (!/^[a-zA-Z0-9:_-]{1,100}$/.test(namespace)) throw new AdmissionStoreError("invalid_store_input");
  }

  private accountKey(identity: string) { return `${this.namespace}:{${identity}}`; }

  private ruleKeys(identity: string, keys: readonly string[]) {
    const prefix = this.accountKey(identity);
    return keys.flatMap((key) => {
      const hash = createHash("sha256").update(key).digest("hex");
      return [`${prefix}:rule:${hash}`, `${prefix}:active:${hash}`];
    });
  }

  private async run(script: string, keys: readonly string[], args: readonly string[]) {
    const hash = createHash("sha1").update(script).digest("hex");
    try {
      return await this.client.sendCommand(["EVALSHA", hash, String(keys.length), ...keys, ...args]);
    } catch (error) {
      if (!isNoScriptError(error)) throw new AdmissionStoreError();
      // NOSCRIPT guarantees the command did not execute. Other failures are uncertain
      // and must never cause a second admission command or an inference retry.
      try { return await this.client.sendCommand(["EVAL", script, String(keys.length), ...keys, ...args]); }
      catch { throw new AdmissionStoreError(); }
    }
  }

  async acquire(input: AdmissionAcquireInput): Promise<AdmissionResult> {
    validateAcquire(input);
    const prefix = this.accountKey(input.accountIdentity);
    const ruleKeys = input.rules.map((rule) => rule.key);
    const reply = await this.run(ACQUIRE_SCRIPT,
      [`${prefix}:meta`, `${prefix}:lease:${input.leaseId}`, ...this.ruleKeys(input.accountIdentity, ruleKeys)],
      [JSON.stringify(input.rules), input.leaseId, String(input.ttlMs), JSON.stringify(ruleKeys)]);
    if (Array.isArray(reply) && reply[0] === 0) {
      const [, retryAfterMs] = numericReply(reply, 2);
      return { granted: false, retryAfterMs };
    }
    const [granted, expiresAt, probe] = numericReply(reply, 3);
    if (granted !== 1 || probe > 1) throw new AdmissionStoreError();
    return { granted: true, permit: Object.freeze({ id: input.leaseId, accountIdentity: input.accountIdentity,
      ruleKeys: Object.freeze(ruleKeys), expiresAt, probe: probe === 1 }) };
  }

  async complete(permit: Permit, outcome: AdmissionOutcome): Promise<void> {
    validateCompletion(permit, outcome);
    const prefix = this.accountKey(permit.accountIdentity);
    const scopes = outcome.scopeKeys ?? permit.ruleKeys;
    const reply = await this.run(COMPLETE_SCRIPT,
      [`${prefix}:meta`, `${prefix}:lease:${permit.id}`, ...this.ruleKeys(permit.accountIdentity, permit.ruleKeys)],
      [permit.id, String(permit.expiresAt), JSON.stringify(permit.ruleKeys),
        JSON.stringify({ cooldownMs: outcome.cooldownMs, disable: outcome.disable }),
        JSON.stringify(permit.ruleKeys.map((key) => scopes.includes(key)))]);
    if (reply !== 0 && reply !== 1) throw new AdmissionStoreError();
  }

  async snapshot(accountIdentity: string, rules: readonly QuotaRule[]): Promise<AccountSnapshot> {
    validateRules(accountIdentity, rules);
    const prefix = this.accountKey(accountIdentity);
    const [active, retryAfterMs] = numericReply(await this.run(SNAPSHOT_SCRIPT,
      [`${prefix}:meta`, ...this.ruleKeys(accountIdentity, rules.map((rule) => rule.key))], [JSON.stringify(rules)]), 2);
    return { active, retryAfterMs };
  }

  async close() { await this.client.close(); }
}
