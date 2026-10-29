import { isPoolEnabled, parsePoolConfig } from "../src/lib/ai/cloudflare/accountConfig";
import { AccountDispatcher } from "../src/lib/ai/cloudflare/dispatcher";
import { createDeadline } from "../src/lib/ai/cloudflare/deadline";
import { MemoryAdmissionStore } from "../src/lib/ai/cloudflare/memoryAdmissionStore";
import { publicPoolError } from "../src/lib/ai/cloudflare/providerError";
import { createRedisClient } from "../src/lib/ai/cloudflare/redisClient";
import { RedisAdmissionStore } from "../src/lib/ai/cloudflare/redisAdmissionStore";
import { translateVietnameseWithCloudflare } from "../src/lib/ai/cloudflareText";
import type { AdmissionStore, CloudflareExecutionContext } from "../src/lib/ai/cloudflare/types";

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help")) {
    console.info("check-cloudflare-pool [--validate] [--smoke]\nDefault: check enabled config and Redis PING; --validate also checks disabled config.\n--smoke explicitly spends one text inference per enabled text-capable account.");
    return;
  }
  if ([...args].some(arg => !["--validate", "--smoke"].includes(arg))) throw new Error("invalid_arguments");
  if (!isPoolEnabled() && !args.has("--validate") && !args.has("--smoke")) {
    console.info(JSON.stringify({ enabled: false, status: "disabled_no_pool_initialized" })); return;
  }
  const config = parsePoolConfig();
  let store: AdmissionStore;
  if (config.store === "redis") {
    const client = await createRedisClient(config.redisUrl!);
    try { await client.sendCommand(["PING"]); } catch { await client.close(); throw new Error("redis_unavailable"); }
    store = new RedisAdmissionStore(client, config.namespace);
  } else store = new MemoryAdmissionStore();
  try {
    console.info(JSON.stringify({ status: "configuration_valid", store: config.store, configVersion: config.configVersion,
      accounts: config.accounts.map(account => ({ alias: account.alias, enabled: account.enabled })) }));
    if (!args.has("--smoke")) return;
    let failures = 0;
    for (const account of config.accounts.filter(account => account.enabled)) {
      const model = process.env.CLOUDFLARE_TEXT_MODEL?.trim() || "@cf/meta/llama-4-scout-17b-16e-instruct";
      if (!account.capabilities.text.includes(model)) {
        console.info(JSON.stringify({ alias: account.alias, smoke: "skipped_no_text_capability" })); continue;
      }
      // Explicit per-account smoke also covers the reserved legacy account
      // before stage 2 enables ordinary pooled traffic on it.
      const dispatcher = new AccountDispatcher({ ...config, accounts: [account], routeLegacyAccount: true,
        maxAttemptsPerStage: 1, maxAttemptsPerRequest: 1 }, store);
      const execution: CloudflareExecutionContext = { requestId: "pool-config-smoke", workload: "audio-translate",
        ...createDeadline(10_000), attempts: { used: 0, max: 1 }, dispatcher };
      try {
        await translateVietnameseWithCloudflare("Xin chào", "Translate into English. Return only the translation.", 16, { execution });
        console.info(JSON.stringify({ alias: account.alias, smoke: "text_passed" }));
      } catch (error) {
        failures++;
        console.info(JSON.stringify({ alias: account.alias, smoke: "failed", status: publicPoolError(error).status }));
      }
    }
    if (failures) process.exitCode = 1;
  } finally { await store.close?.(); }
}

main().catch(() => {
  console.error(JSON.stringify({ status: "check_failed", message: "Kiểm tra tham số, cấu hình pool và kết nối Redis. Không in secrets để chẩn đoán." }));
  process.exitCode = 1;
});
