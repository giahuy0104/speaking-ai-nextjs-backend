type Environment = Readonly<Record<string, string | undefined>>;
type Probes = { database(signal: AbortSignal): Promise<boolean>; redis(url: string): Promise<boolean>; storage(): Promise<boolean> };

export async function checkReadiness(env: Environment, probes: Probes) {
  const checks: Record<string, boolean> = {};
  const run = async (name: string, operation: () => Promise<boolean>) => {
    try { checks[name] = await operation(); } catch { checks[name] = false; }
  };
  // A real abort signal bounds the HTTP query and prevents orphaned database requests.
  const operations = [run("database", () => probes.database(AbortSignal.timeout(3000))), run("storage", probes.storage)];
  if (env.CLOUDFLARE_AUDIO_TRANSLATION_POOL_ENABLED === "true") {
    operations.push(run("quota", () => probes.redis(env.CLOUDFLARE_POOL_REDIS_URL || "")));
    if (env.AUDIO_TRANSLATION_CACHE_ENABLED === "true") operations.push(run("cache", () => probes.redis(env.AUDIO_TRANSLATION_CACHE_REDIS_URL || "")));
    if (env.AUDIO_TRANSLATION_JOBS_ENABLED === "true") operations.push(run("jobs", () => probes.redis(env.AUDIO_TRANSLATION_JOBS_REDIS_URL || "")));
  }
  await Promise.all(operations);
  return { ready: Object.values(checks).every(Boolean), checks };
}
