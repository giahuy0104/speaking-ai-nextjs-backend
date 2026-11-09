import { randomUUID } from "node:crypto";
import { createRedisClient } from "./redisClient";
import { RedisAdmissionStore } from "./redisAdmissionStore";
import type { Permit } from "./types";

async function run() {
  const url = process.env.CF_POOL_WORKER_REDIS_URL!;
  const namespace = process.env.CF_POOL_WORKER_NAMESPACE!;
  const identity = process.env.CF_POOL_WORKER_IDENTITY!;
  const store = new RedisAdmissionStore(await createRedisClient(url), namespace);
  const permits: Permit[] = [];
  process.send?.({ type: "ready" });
  process.on("message", async (message) => {
    try {
      if (message === "go") {
        const results = await Promise.all(Array.from({ length: 40 }, () => store.acquire({
          accountIdentity: identity, rules: [{ key: "account", maxConcurrent: 5 },
            { key: "task:asr", rpm: 60, burst: 5, maxConcurrent: 5 }],
          leaseId: randomUUID(), ttlMs: 10_000,
        })));
        for (const result of results) if (result.granted) permits.push(result.permit);
        process.send?.({ type: "result", admitted: permits.length });
      }
      if (message === "release") {
        await Promise.all(permits.map((permit) => store.complete(permit, {})));
        await store.close();
        process.disconnect();
      }
    } catch {
      process.send?.({ type: "failed" });
      await store.close();
      process.exitCode = 1;
      process.disconnect();
    }
  });
}

run().catch(() => { process.send?.({ type: "failed" }); process.exitCode = 1; process.disconnect(); });
