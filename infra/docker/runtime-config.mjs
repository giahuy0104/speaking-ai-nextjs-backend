// Production-only configuration. Errors name settings, never their values.
export class DeploymentConfigurationError extends Error {
  constructor(setting, reason = "required") {
    super(`Invalid deployment setting: ${setting} (${reason}).`);
    this.name = "DeploymentConfigurationError";
  }
}
const fail = (key, reason) => { throw new DeploymentConfigurationError(key, reason); };
const value = (env, key) => env[key]?.trim() || "";
function required(env, key) {
  const result = value(env, key);
  if (!result) fail(key, "required");
  return result;
}
function flag(env, key) {
  const result = value(env, key).toLowerCase();
  if (result && result !== "true" && result !== "false") fail(key, "use_true_or_false");
  env[key] = String(result === "true");
  return result === "true";
}
function address(env, key, protocols) {
  let parsed;
  try { parsed = new URL(required(env, key)); } catch { fail(key, "invalid_url"); }
  if (!protocols.includes(parsed.protocol) || !parsed.hostname || parsed.hash) fail(key, "invalid_url");
  return parsed;
}
const r2Keys = ["CLOUDFLARE_R2_ACCOUNT_ID", "CLOUDFLARE_R2_ACCESS_KEY_ID", "CLOUDFLARE_R2_SECRET_ACCESS_KEY", "CLOUDFLARE_R2_BUCKET"];

export function configureDeployment(env, role = "web") {
  if (role !== "web" && role !== "worker") fail("role", "web_or_worker");
  env.NODE_ENV = "production";
  env.HOSTNAME = "0.0.0.0";
  env.PORT = value(env, "PORT") || "3000";
  if (!/^\d+$/.test(env.PORT) || Number(env.PORT) < 1 || Number(env.PORT) > 65535) fail("PORT", "invalid_port");
  const runtime = value(env, "APP_RUNTIME") || "railway";
  if (!["railway", "compose"].includes(runtime)) fail("APP_RUNTIME", "railway_or_compose");
  const database = address(env, "DATABASE_URL", ["postgres:", "postgresql:"]);
  // neon() uses HTTP. A raw Railway PostgreSQL TCP URL is not interchangeable.
  if (!database.hostname.toLowerCase().endsWith(".neon.tech")) fail("DATABASE_URL", "requires_neon_http_driver");
  if (value(env, "PERSISTENCE_BACKEND") && value(env, "PERSISTENCE_BACKEND") !== "postgres") fail("PERSISTENCE_BACKEND", "must_be_postgres");
  env.PERSISTENCE_BACKEND = "postgres";
  required(env, "ADMIN_USERNAME");
  required(env, "ADMIN_PASSWORD");
  if (required(env, "INSTALLATION_AUTH_SECRET").length < 32) fail("INSTALLATION_AUTH_SECRET", "minimum_32_characters");
  if (value(env, "AUDIO_UPLOAD_TOKEN_SECRET") && value(env, "AUDIO_UPLOAD_TOKEN_SECRET").length < 32) fail("AUDIO_UPLOAD_TOKEN_SECRET", "minimum_32_characters");
  env.INSTALLATION_AUTH_REQUIRED = "true";
  env.AUDIO_UPLOAD_REQUIRE_SCOPED_TOKEN = "true";
  const audio = value(env, "AUDIO_STORAGE_BACKEND") || "postgres";
  if (!["postgres", "cloudinary", "r2", "vercel-blob"].includes(audio)) fail("AUDIO_STORAGE_BACKEND", "requires_shared_storage");
  env.AUDIO_STORAGE_BACKEND = audio;
  const chunks = value(env, "AUDIO_SESSION_CHUNK_STORAGE_BACKEND") || (audio === "r2" ? "r2" : "postgres");
  if (!["postgres", "r2"].includes(chunks)) fail("AUDIO_SESSION_CHUNK_STORAGE_BACKEND", "requires_shared_storage");
  env.AUDIO_SESSION_CHUNK_STORAGE_BACKEND = chunks;
  if (audio === "cloudinary") for (const key of ["CLOUDINARY_TTS_CLOUD_NAME", "CLOUDINARY_TTS_API_KEY", "CLOUDINARY_TTS_API_SECRET"]) required(env, key);
  if (audio === "vercel-blob" && !value(env, "GENERATED_AUDIO_BLOB_READ_WRITE_TOKEN") && !value(env, "BLOB_READ_WRITE_TOKEN")) fail("GENERATED_AUDIO_BLOB_READ_WRITE_TOKEN", "required");
  const pool = flag(env, "CLOUDFLARE_AUDIO_TRANSLATION_POOL_ENABLED");
  const cache = flag(env, "AUDIO_TRANSLATION_CACHE_ENABLED");
  const jobs = flag(env, "AUDIO_TRANSLATION_JOBS_ENABLED");
  const sharedLegacy = flag(env, "CLOUDFLARE_POOL_SHARE_LEGACY_ACCOUNT");
  const routeLegacy = flag(env, "CLOUDFLARE_POOL_ROUTE_LEGACY_ACCOUNT");
  if ((cache || jobs || sharedLegacy) && !pool) fail("CLOUDFLARE_AUDIO_TRANSLATION_POOL_ENABLED", "required_by_enabled_features");
  if (routeLegacy && !sharedLegacy) fail("CLOUDFLARE_POOL_ROUTE_LEGACY_ACCOUNT", "requires_shared_legacy_quota");
  if (role === "worker" && !jobs) fail("AUDIO_TRANSLATION_JOBS_ENABLED", "required_for_worker");
  // Preserve the explicit Compose load-test migration; never silently share legacy quota.
  if (flag(env, "CLOUDFLARE_POOL_ALLOW_LEGACY_ACCOUNT_LOCAL_TEST")) {
    if (runtime !== "compose" || sharedLegacy || !pool) fail("CLOUDFLARE_POOL_ALLOW_LEGACY_ACCOUNT_LOCAL_TEST", "development_only");
    let accounts;
    try { accounts = JSON.parse(required(env, "CLOUDFLARE_ACCOUNTS_JSON")); } catch { fail("CLOUDFLARE_ACCOUNTS_JSON", "invalid_json"); }
    if (!Array.isArray(accounts)) fail("CLOUDFLARE_ACCOUNTS_JSON", "invalid_registry");
    const dedicated = accounts.filter(account => account && typeof account.accountId === "string" && account.accountId.toLowerCase() !== value(env, "CLOUDFLARE_ACCOUNT_ID").toLowerCase());
    if (!dedicated.some(account => account.enabled)) fail("CLOUDFLARE_ACCOUNTS_JSON", "requires_dedicated_account");
    env.CLOUDFLARE_ACCOUNTS_JSON = JSON.stringify(dedicated);
    env.CLOUDFLARE_POOL_ALLOW_LEGACY_ACCOUNT_LOCAL_TEST = "false";
  }
  if (role === "web") {
    if (!/^[a-f0-9]{32}$/i.test(required(env, "CLOUDFLARE_ACCOUNT_ID"))) fail("CLOUDFLARE_ACCOUNT_ID", "invalid_account_id");
    required(env, "CLOUDFLARE_WORKERS_AI_API_TOKEN");
    for (const key of ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"]) required(env, key);
  }
  if (pool) {
    if (value(env, "CLOUDFLARE_POOL_STORE") && value(env, "CLOUDFLARE_POOL_STORE") !== "redis") fail("CLOUDFLARE_POOL_STORE", "redis_required_in_production");
    env.CLOUDFLARE_POOL_STORE = "redis";
    required(env, "CLOUDFLARE_ACCOUNTS_JSON");
  }
  const endpoints = new Set();
  const redisSettings = [
    ...(pool ? [["CLOUDFLARE_POOL_REDIS_URL", "redis"]] : []),
    ...(cache ? [["AUDIO_TRANSLATION_CACHE_REDIS_URL", "redis-cache"]] : []),
    ...(jobs ? [["AUDIO_TRANSLATION_JOBS_REDIS_URL", "redis-jobs"]] : []),
  ];
  for (const [key, host] of redisSettings) {
    if (runtime === "compose") {
      const url = new URL(`redis://${host}:6379`);
      url.password = required(env, "CLOUDFLARE_POOL_REDIS_PASSWORD");
      env[key] = url.href;
    }
    const url = address(env, key, ["redis:", "rediss:"]);
    if (url.search) fail(key, "invalid_url");
    const endpoint = `${url.hostname.toLowerCase()}:${url.port || "6379"}`;
    if (endpoints.has(endpoint)) fail(key, "requires_separate_redis_instance");
    endpoints.add(endpoint);
  }
  if (jobs) {
    const storage = value(env, "AUDIO_TRANSLATION_JOB_STORAGE") || "r2";
    if (storage !== "r2" && !(runtime === "compose" && storage === "local" && value(env, "AUDIO_TRANSLATION_JOB_SHARED_DIRECTORY"))) fail("AUDIO_TRANSLATION_JOB_STORAGE", "railway_requires_r2");
    env.AUDIO_TRANSLATION_JOB_STORAGE = storage;
    env.AUDIO_TRANSLATION_JOB_NAMESPACE = value(env, "AUDIO_TRANSLATION_JOB_NAMESPACE") || "speaking-ai-audio-jobs";
    if (!/^[a-zA-Z0-9:_-]{1,100}$/.test(env.AUDIO_TRANSLATION_JOB_NAMESPACE)) fail("AUDIO_TRANSLATION_JOB_NAMESPACE", "invalid_namespace");
  }
  // This implementation has one R2 bucket setting. Public TTS delivery must
  // never expose private recordings, job inputs or archive snapshots.
  if (audio === "r2" && (chunks === "r2" || (jobs && env.AUDIO_TRANSLATION_JOB_STORAGE === "r2"))) fail("AUDIO_STORAGE_BACKEND", "public_tts_cannot_share_private_audio_bucket");
  if (audio === "r2" && value(env, "APP_RECORDS_ARCHIVE_R2_BUCKET") && value(env, "APP_RECORDS_ARCHIVE_R2_BUCKET") === value(env, "CLOUDFLARE_R2_BUCKET")) fail("APP_RECORDS_ARCHIVE_R2_BUCKET", "requires_private_archive_bucket");
  if (audio === "r2" || chunks === "r2" || (jobs && env.AUDIO_TRANSLATION_JOB_STORAGE === "r2") || value(env, "APP_RECORDS_ARCHIVE_R2_BUCKET")) for (const key of r2Keys) required(env, key);
  if (audio === "r2") address(env, "CLOUDFLARE_R2_PUBLIC_BASE_URL", ["https:"]);
  if (value(env, "APP_RECORDS_ARCHIVE_R2_BUCKET") && required(env, "CRON_SECRET").length < 32) fail("CRON_SECRET", "minimum_32_characters");
  const origins = [];
  for (const origin of value(env, "PWA_ALLOWED_ORIGINS").split(",").filter(Boolean)) {
    let url;
    try { url = new URL(origin.trim()); } catch { fail("PWA_ALLOWED_ORIGINS", "invalid_origin"); }
    if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username || url.password) fail("PWA_ALLOWED_ORIGINS", "use_https_origins_without_paths");
    origins.push(url.origin);
  }
  env.PWA_ALLOWED_ORIGINS = [...new Set(origins)].join(",");
  return { role, runtime, persistence: "postgres", audio, chunks, pool, cache, jobs };
}
