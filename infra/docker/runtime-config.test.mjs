import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { configureDeployment } from "./runtime-config.mjs";

const fixture = (overrides = {}) => ({
  DATABASE_URL: "postgresql://audit:secret@audit.neon.tech/audit?sslmode=require",
  ADMIN_USERNAME: "audit", ADMIN_PASSWORD: "audit-only-password", INSTALLATION_AUTH_SECRET: "audit-installation-secret-minimum-32-characters",
  CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), CLOUDFLARE_WORKERS_AI_API_TOKEN: "audit-provider-token",
  CLOUDINARY_CLOUD_NAME: "audit", CLOUDINARY_API_KEY: "audit-key", CLOUDINARY_API_SECRET: "audit-secret",
  ...overrides,
});
const pooled = (overrides = {}) => fixture({
  CLOUDFLARE_AUDIO_TRANSLATION_POOL_ENABLED: "true", CLOUDFLARE_ACCOUNTS_JSON: "[]",
  CLOUDFLARE_POOL_REDIS_URL: "rediss://user:encoded%40password@quota.railway.internal:6379",
  ...overrides,
});
test("Railway startup accepts environment variables without Compose secrets or disabled Redis", () => {
  const env = fixture({ PORT: "4321", INSTALLATION_AUTH_REQUIRED: "false", AUDIO_UPLOAD_REQUIRE_SCOPED_TOKEN: "false" });
  const result = configureDeployment(env);
  assert.equal(result.runtime, "railway"); assert.equal(env.PORT, "4321"); assert.equal(env.HOSTNAME, "0.0.0.0");
  assert.equal(env.INSTALLATION_AUTH_REQUIRED, "true"); assert.equal(env.AUDIO_UPLOAD_REQUIRE_SCOPED_TOKEN, "true");
  assert.equal(env.CLOUDFLARE_POOL_REDIS_URL, undefined);
});
test("Railway Redis URLs retain credentials, host, TLS and database index", () => {
  const env = pooled(); const original = env.CLOUDFLARE_POOL_REDIS_URL;
  configureDeployment(env); assert.equal(env.CLOUDFLARE_POOL_REDIS_URL, original);
});
test("Compose translates host-loopback URLs only in explicit Compose mode", () => {
  const env = pooled({ APP_RUNTIME: "compose", CLOUDFLARE_POOL_REDIS_URL: "redis://localhost:16379", CLOUDFLARE_POOL_REDIS_PASSWORD: "password@with/$quotes" });
  configureDeployment(env);
  const url = new URL(env.CLOUDFLARE_POOL_REDIS_URL);
  assert.equal(url.hostname, "redis"); assert.equal(decodeURIComponent(url.password), "password@with/$quotes");
});
test("enabled Redis stores cannot share a host even with explicit default port or different DB", () => {
  const env = pooled({ AUDIO_TRANSLATION_CACHE_ENABLED: "true", CLOUDFLARE_POOL_REDIS_URL: "redis://same/0", AUDIO_TRANSLATION_CACHE_REDIS_URL: "redis://same:6379/1" });
  assert.throws(() => configureDeployment(env), /requires_separate_redis_instance/);
});
test("Railway jobs require R2 while explicit Compose shared-volume jobs remain supported", () => {
  const env = pooled({ AUDIO_TRANSLATION_JOBS_ENABLED: "true", AUDIO_TRANSLATION_JOBS_REDIS_URL: "redis://jobs:6379", AUDIO_TRANSLATION_JOB_STORAGE: "local", AUDIO_TRANSLATION_JOB_SHARED_DIRECTORY: "/app/shared" });
  assert.throws(() => configureDeployment(env), /railway_requires_r2/);
  env.APP_RUNTIME = "compose"; env.CLOUDFLARE_POOL_REDIS_PASSWORD = "audit-only-password";
  env.AUDIO_TRANSLATION_JOB_NAMESPACE = " jobs ";
  assert.equal(configureDeployment(env, "worker").jobs, true);
  assert.equal(env.AUDIO_TRANSLATION_JOB_NAMESPACE, "jobs");
});
test("rejects raw Railway Postgres, local persistence and partial storage credentials", () => {
  for (const overrides of [{ DATABASE_URL: "postgresql://user:secret@postgres.railway.internal/db" }, { PERSISTENCE_BACKEND: "local" }, { AUDIO_STORAGE_BACKEND: "local" }, { AUDIO_SESSION_CHUNK_STORAGE_BACKEND: "r2" }]) {
    assert.throws(() => configureDeployment(fixture(overrides)), /Invalid deployment setting/);
  }
});
test("origin normalization accepts trailing slash but rejects credential-bearing or path origins", () => {
  const env = fixture({ PWA_ALLOWED_ORIGINS: "https://app.example/,https://app.example" });
  configureDeployment(env); assert.equal(env.PWA_ALLOWED_ORIGINS, "https://app.example");
  for (const origin of ["https://user:secret@app.example/", "https://app.example/path", "http://app.example", "https://app.example/?secret=1"]) assert.throws(() => configureDeployment(fixture({ PWA_ALLOWED_ORIGINS: origin })), /PWA_ALLOWED_ORIGINS/);
});
test("public generated TTS cannot share its R2 bucket with private voice inputs or archive", () => {
  assert.throws(() => configureDeployment(fixture({ AUDIO_STORAGE_BACKEND: "r2" })), /public_tts_cannot_share_private_audio_bucket/);
  assert.throws(() => configureDeployment(fixture({ AUDIO_STORAGE_BACKEND: "r2", AUDIO_SESSION_CHUNK_STORAGE_BACKEND: "postgres", APP_RECORDS_ARCHIVE_R2_BUCKET: "public", CLOUDFLARE_R2_BUCKET: "public" })), /requires_private_archive_bucket/);
});
test("malformed credential-bearing URLs never appear in configuration errors", () => {
  const secret = "do-not-log-this-secret";
  try { configureDeployment(pooled({ CLOUDFLARE_POOL_REDIS_URL: `redis://:${secret}@[broken` })); assert.fail(); }
  catch (error) { assert.match(error.message, /CLOUDFLARE_POOL_REDIS_URL/); assert.equal(error.message.includes(secret), false); }
});
test("actual startup loads an optional env file and preserves service variable precedence", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "railway-startup-"));
  try {
    const dir = path.join(root, "infra/docker"); mkdirSync(dir, { recursive: true });
    for (const name of ["start.mjs", "runtime-config.mjs"]) writeFileSync(path.join(dir, name), readFileSync(new URL(name, import.meta.url)));
    const envFile = path.join(root, "app.env");
    writeFileSync(envFile, Object.entries(fixture({ PORT: "4567" })).map(([key, val]) => `${key}=${JSON.stringify(val)}`).join("\n"));
    writeFileSync(path.join(root, "server.js"), "console.log(JSON.stringify({port:process.env.PORT,auth:process.env.INSTALLATION_AUTH_REQUIRED}));");
    const result = spawnSync(process.execPath, [path.join(dir, "start.mjs")], { env: { SystemRoot: process.env.SystemRoot || "", APP_ENV_FILE: envFile, PORT: "8765" }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), { port: "8765", auth: "true" });
    const missing = spawnSync(process.execPath, [path.join(dir, "start.mjs"), "check"], { env: fixture(), encoding: "utf8" });
    assert.equal(missing.status, 0, missing.stderr); assert.match(missing.stdout, /deployment_configuration_valid/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
