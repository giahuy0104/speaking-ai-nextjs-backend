import { createHash } from "node:crypto";
import { PoolError } from "./providerError";
import type { CloudflareAccount, CloudflareOperation, CloudflareTask, QuotaRule } from "./types";

export function operationTask(operation: CloudflareOperation): CloudflareTask {
  switch (operation) {
    case "audio_translation_asr": case "legacy_asr": return "asr";
    case "audio_translation_text": case "legacy_text": return "text";
    case "legacy_tts": return "tts";
    default: throw new PoolError("configuration");
  }
}

/** Account, task and optional model quotas all apply to each inference attempt. */
export function quotaRules(
  account: CloudflareAccount,
  operation: CloudflareOperation,
  model: string,
): readonly QuotaRule[] {
  const task = operationTask(operation);
  const limit = account.limits[task];
  if (!limit) throw new PoolError("configuration");
  const rules: QuotaRule[] = [
    Object.freeze({ key: "account", maxConcurrent: account.limits.accountMaxConcurrent }),
    Object.freeze({ key: `task:${task}`, ...limit }),
  ];
  const modelLimit = account.limits.models?.[model];
  if (modelLimit) {
    rules.push(Object.freeze({
      key: `model:${createHash("sha256").update(model).digest("hex")}`,
      ...modelLimit,
    }));
  }
  return Object.freeze(rules);
}
