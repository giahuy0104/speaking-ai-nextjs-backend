import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

// This smoke never reads local env files or sends jobs to a provider. Workers
// use an internal Docker network; the web uses its own bridge so Docker can
// publish its port on host loopback. All credentials are synthetic, all web
// probes are unauthenticated, and Redis instances/volumes are disposable.
const defaults = {
  "web-image": "speaking-ai-railway-web:check",
  "worker-image": "speaking-ai-railway-worker:check",
  "redis-image": "redis:7.4-alpine",
};
const options = { ...defaults };
for (let index = 2; index < process.argv.length; index++) {
  const argument = process.argv[index];
  if (argument === "--help") {
    console.log("Usage: node scripts/smoke-railway-images.mjs [--web-image IMAGE] [--worker-image IMAGE] [--redis-image IMAGE]");
    process.exit(0);
  }
  const key = argument.replace(/^--/, "");
  if (!(key in defaults) || !process.argv[index + 1] || process.argv[index + 1].startsWith("--")) {
    throw new Error("Unknown or incomplete option: " + argument);
  }
  options[key] = process.argv[++index];
}

const runId = randomUUID();
const labelKey = "io.speaking-ai.railway-smoke";
const label = labelKey + "=" + runId;
const prefix = "railway-smoke-" + runId.slice(0, 8);
const network = prefix + "-network";
const webNetwork = prefix + "-web-network";
const webName = prefix + "-web";
const workerName = prefix + "-worker";
const quotaName = prefix + "-quota";
const jobsName = prefix + "-jobs";
const port = 4317;
const createdNetworks = [];
let cleanupPromise;
let passed = 0;

const webEnvironment = {
  DATABASE_URL: "postgresql://smoke:smoke-db-secret@audit-unreachable.neon.tech/smoke?sslmode=require",
  PERSISTENCE_BACKEND: "postgres",
  AUDIO_STORAGE_BACKEND: "postgres",
  AUDIO_SESSION_CHUNK_STORAGE_BACKEND: "postgres",
  ADMIN_USERNAME: "smoke-admin",
  ADMIN_PASSWORD: "smoke-admin-password-not-real",
  INSTALLATION_AUTH_SECRET: "smoke-installation-secret-at-least-32-characters",
  INSTALLATION_AUTH_REQUIRED: "false",
  AUDIO_UPLOAD_REQUIRE_SCOPED_TOKEN: "false",
  CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  CLOUDFLARE_WORKERS_AI_API_TOKEN: "smoke-provider-token-not-real",
  CLOUDINARY_CLOUD_NAME: "smoke-cloud",
  CLOUDINARY_API_KEY: "smoke-cloud-key-not-real",
  CLOUDINARY_API_SECRET: "smoke-cloud-secret-not-real",
  CLOUDFLARE_AUDIO_TRANSLATION_POOL_ENABLED: "false",
  CLOUDFLARE_POOL_SHARE_LEGACY_ACCOUNT: "false",
  CLOUDFLARE_POOL_ROUTE_LEGACY_ACCOUNT: "false",
  AUDIO_TRANSLATION_CACHE_ENABLED: "false",
  AUDIO_TRANSLATION_JOBS_ENABLED: "false",
  PWA_ALLOWED_ORIGINS: "https://railway-smoke.example",
  PORT: String(port),
};
const secretMarkers = ["smoke-db-secret", webEnvironment.ADMIN_PASSWORD,
  webEnvironment.INSTALLATION_AUTH_SECRET, webEnvironment.CLOUDFLARE_WORKERS_AI_API_TOKEN,
  webEnvironment.CLOUDINARY_API_KEY, webEnvironment.CLOUDINARY_API_SECRET];

function safeOutput(text = "") {
  for (const secret of secretMarkers) text = text.replaceAll(secret, "[redacted]");
  return text;
}
function docker(args, { allowFailure = false, timeout = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile("docker", args, { encoding: "utf8", timeout, maxBuffer: 2 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const result = { code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout: stdout || "", stderr: stderr || "" };
        if (error && !allowFailure) reject(new Error("Docker command failed: " + args[0] + ". " + safeOutput(result.stderr).slice(-1200)));
        else resolve(result);
      });
  });
}
function envArguments(environment) {
  return Object.entries(environment).flatMap(([key, value]) => ["--env", key + "=" + value]);
}
function pass(name) {
  passed++;
  console.log("PASS " + name);
}
function assertPublic(value) {
  for (const marker of secretMarkers) assert.equal(value.includes(marker), false, "Response or startup diagnostic leaked synthetic credentials");
}
async function waitUntil(operation, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  do {
    try { if (await operation()) return; } catch (error) { lastError = error; }
    await delay(250);
  } while (Date.now() < deadline);
  throw new Error("Smoke condition timed out" + (lastError ? ": " + safeOutput(lastError.message) : ""));
}
async function requireImage(image, instruction) {
  const result = await docker(["image", "inspect", image], { allowFailure: true });
  if (result.code) throw new Error("Required local image is missing: " + image + ". " + instruction);
  const [metadata] = JSON.parse(result.stdout);
  return metadata;
}
async function cleanup() {
  cleanupPromise ??= (async () => {
    const containers = await docker(["ps", "--all", "--quiet", "--filter", "label=" + label], { allowFailure: true });
    const ids = containers.stdout.trim().split(/\s+/).filter(Boolean);
    if (ids.length) await docker(["rm", "--force", "--volumes", ...ids], { allowFailure: true });
    for (const name of createdNetworks) {
      const owned = await docker(["network", "inspect", name, "--format", "{{index .Labels \"" + labelKey + "\"}}"], { allowFailure: true });
      if (owned.stdout.trim() === runId) await docker(["network", "rm", name], { allowFailure: true });
    }
  })();
  return cleanupPromise;
}

async function main() {
  const webImage = await requireImage(options["web-image"], "Build it first with docker build -t " + options["web-image"] + " .");
  const workerImage = await requireImage(options["worker-image"], "Build it first with docker build -f Dockerfile.worker -t " + options["worker-image"] + " .");
  await requireImage(options["redis-image"], "Pull it first with docker pull " + options["redis-image"]);
  for (const [name, image] of [["web", webImage], ["worker", workerImage]]) {
    assert.ok(image.Config.User && !["root", "0", "0:0"].includes(image.Config.User), name + " image must select a non-root user");
    pass(name + " image declares a non-root user");
  }
  await docker(["network", "create", "--internal", "--label", label, network]);
  createdNetworks.push(network);
  await docker(["network", "create", "--label", label, webNetwork]);
  createdNetworks.push(webNetwork);

  const invalid = await docker(["run", "--rm", "--network", network, "--label", label,
    ...envArguments({ ...webEnvironment, PORT: "invalid-smoke-port" }), options["web-image"]], { allowFailure: true });
  assert.notEqual(invalid.code, 0);
  assert.match(invalid.stdout + invalid.stderr, /PORT/);
  assertPublic(invalid.stdout + invalid.stderr);
  pass("web default entrypoint rejects invalid settings without leaking credentials");

  const disabledWorker = await docker(["run", "--rm", "--network", network, "--label", label,
    ...envArguments(webEnvironment), options["worker-image"]], { allowFailure: true });
  assert.notEqual(disabledWorker.code, 0);
  assert.match(disabledWorker.stdout + disabledWorker.stderr, /AUDIO_TRANSLATION_JOBS_ENABLED/);
  assertPublic(disabledWorker.stdout + disabledWorker.stderr);
  pass("worker default entrypoint requires jobs instead of starting a web server");

  await docker(["run", "--rm", "--network", network, "--label", label, "--entrypoint", "node", options["worker-image"], "-e",
    "const a=require('node:assert/strict');const fs=require('node:fs');a.ok(process.getuid()>0);a.ok(fs.existsSync('scripts/audio-translation-worker.ts'));a.ok(require.resolve('tsx'));import('./infra/docker/pool-config.mjs').then(m=>a.equal(typeof m.parsePoolConfig,'function')).catch(()=>process.exitCode=1);"]);
  pass("worker image includes its TS loader, source and compiled pool parser");

  await docker(["run", "--detach", "--name", webName, "--network", webNetwork, "--label", label,
    "--publish", "127.0.0.1::" + port, ...envArguments(webEnvironment), options["web-image"]]);
  const binding = await docker(["port", webName, String(port) + "/tcp"]);
  const hostPort = binding.stdout.trim().match(/^127\.0\.0\.1:(\d+)$/)?.[1];
  assert.ok(hostPort, "Web smoke must publish an ephemeral loopback port");
  const base = "http://127.0.0.1:" + hostPort;
  await waitUntil(async () => {
    const state = await docker(["inspect", webName, "--format", "{{.State.Running}}"]);
    assert.equal(state.stdout.trim(), "true", "Web container exited during startup");
    return (await fetch(base + "/api/health", { signal: AbortSignal.timeout(2000) })).ok;
  }, 45_000);
  pass("web starts without Compose secrets and binds the supplied nondefault PORT on all container interfaces");
  const uid = await docker(["exec", webName, "node", "-e", "console.log(process.getuid())"]);
  assert.ok(Number(uid.stdout.trim()) > 0);
  pass("web runtime process user is non-root");

  const httpCheck = async (name, route, expected, init = {}) => {
    const response = await fetch(base + route, { ...init, redirect: "manual", signal: AbortSignal.timeout(7000) });
    const body = await response.text();
    assert.equal(response.status, expected, name + " unexpected HTTP status");
    assertPublic(body);
    pass(name);
    return { response, body };
  };
  const health = await httpCheck("health remains live", "/api/health", 200);
  assert.equal(JSON.parse(health.body).status, "ok");
  const ready = await httpCheck("readiness fails closed for unreachable database", "/api/ready", 503);
  assert.deepEqual(JSON.parse(ready.body), { status: "unavailable" });
  assert.equal(ready.response.headers.get("cache-control"), "no-store");
  await httpCheck("admin page redirects to login", "/admin", 307);
  await httpCheck("admin API requires a session", "/api/admin/overview", 401);
  await httpCheck("history rejects bare clientId even with the legacy flag explicitly false", "/api/history?clientId=web_railway-smoke-device", 401);
  await httpCheck("scoped session creation requires installation authentication", "/api/audio-sessions", 401,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ protocolVersion: 2 }) });
  await httpCheck("internal archive requires cron authentication", "/api/internal/app-records/archive", 401);
  await httpCheck("unconfigured origin is rejected", "/api/health", 403,
    { headers: { Origin: "https://unconfigured-smoke.example" } });
  const cors = await httpCheck("configured CORS preflight succeeds", "/api/audio/translate", 204,
    { method: "OPTIONS", headers: { Origin: webEnvironment.PWA_ALLOWED_ORIGINS, "Access-Control-Request-Method": "POST" } });
  assert.equal(cors.response.headers.get("access-control-allow-origin"), webEnvironment.PWA_ALLOWED_ORIGINS);

  for (const [name, alias] of [[quotaName, "quota"], [jobsName, "jobs"]]) {
    await docker(["run", "--detach", "--name", name, "--network", network, "--network-alias", alias, "--label", label,
      options["redis-image"], "redis-server", "--save", "", "--appendonly", "no", "--maxmemory-policy", "noeviction"]);
    await waitUntil(async () => (await docker(["exec", name, "redis-cli", "ping"], { allowFailure: true })).stdout.trim() === "PONG");
  }
  const namespace = "smoke-jobs-" + runId;
  const workerEnvironment = { ...webEnvironment,
    CLOUDFLARE_AUDIO_TRANSLATION_POOL_ENABLED: "true", CLOUDFLARE_POOL_STORE: "redis",
    CLOUDFLARE_POOL_REDIS_URL: "redis://quota:6379",
    CLOUDFLARE_ACCOUNTS_JSON: JSON.stringify([{ alias: "smoke-account", accountId: "b".repeat(32),
      apiTokenEnv: "CLOUDFLARE_POOL_SMOKE_TOKEN", enabled: true,
      capabilities: { asr: ["@cf/openai/whisper-large-v3-turbo"], text: ["@cf/meta/llama-4-scout-17b-16e-instruct"] },
      limits: { asr: { rpm: 60, burst: 10, maxConcurrent: 2 }, text: { rpm: 60, burst: 10, maxConcurrent: 2 }, accountMaxConcurrent: 4 } }]),
    CLOUDFLARE_POOL_SMOKE_TOKEN: "smoke-pool-token-not-real",
    AUDIO_TRANSLATION_JOBS_ENABLED: "true", AUDIO_TRANSLATION_JOBS_REDIS_URL: "redis://jobs:6379",
    AUDIO_TRANSLATION_JOB_NAMESPACE: namespace, AUDIO_TRANSLATION_JOB_STORAGE: "r2",
    CLOUDFLARE_R2_ACCOUNT_ID: "c".repeat(32), CLOUDFLARE_R2_ACCESS_KEY_ID: "smoke-r2-key-not-real",
    CLOUDFLARE_R2_SECRET_ACCESS_KEY: "smoke-r2-secret-not-real", CLOUDFLARE_R2_BUCKET: "smoke-private",
  };
  secretMarkers.push(workerEnvironment.CLOUDFLARE_POOL_SMOKE_TOKEN, workerEnvironment.CLOUDFLARE_R2_ACCESS_KEY_ID,
    workerEnvironment.CLOUDFLARE_R2_SECRET_ACCESS_KEY);
  await docker(["run", "--detach", "--name", workerName, "--network", network, "--label", label,
    ...envArguments(workerEnvironment), options["worker-image"]]);
  await waitUntil(async () => {
    const state = await docker(["inspect", workerName, "--format", "{{.State.Running}}"]);
    assert.equal(state.stdout.trim(), "true", "Worker exited during startup");
    const logs = await docker(["logs", workerName]);
    assertPublic(logs.stdout + logs.stderr);
    return logs.stdout.includes("audio_translation_worker_ready");
  });
  pass("worker default command starts against isolated Redis with R2 configuration");
  const keys = await docker(["exec", jobsName, "redis-cli", "--raw", "KEYS", namespace + ":worker:*"]);
  const heartbeat = keys.stdout.trim();
  assert.ok(heartbeat.startsWith(namespace + ":worker:"));
  const value = await docker(["exec", jobsName, "redis-cli", "GET", heartbeat]);
  const ttl = await docker(["exec", jobsName, "redis-cli", "PTTL", heartbeat]);
  assert.equal(value.stdout.trim(), "ready");
  assert.ok(Number(ttl.stdout.trim()) > 0);
  pass("worker publishes a live, expiring heartbeat without any provider job");
  await docker(["stop", "--time", "10", workerName]);
  const exit = await docker(["inspect", workerName, "--format", "{{.State.ExitCode}}"]);
  assert.equal(exit.stdout.trim(), "0");
  const remaining = await docker(["exec", jobsName, "redis-cli", "--raw", "KEYS", namespace + ":worker:*"]);
  assert.equal(remaining.stdout.trim(), "");
  pass("worker handles SIGTERM cleanly and removes its heartbeat");
  console.log("RAILWAY_IMAGE_SMOKE=PASS checks=" + passed + " (synthetic credentials, isolated network, no provider jobs)");
}

for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  process.once(signal, () => { void cleanup().finally(() => process.exit(code)); });
}
try { await main(); }
catch (error) {
  console.error("RAILWAY_IMAGE_SMOKE=FAIL " + safeOutput(error.message));
  process.exitCode = 1;
} finally { await cleanup(); }
