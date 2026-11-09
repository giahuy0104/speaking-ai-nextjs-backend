import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const suffix = randomUUID().slice(0, 8);
const containers = [];
function docker(args) {
  const result = spawnSync("docker", args, { encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw Error(`Integration Docker command failed: ${args[0]}. Ensure Docker is running.`);
  return result.stdout.trim();
}
async function redis(role) {
  const name = `speaking-ai-${role}-test-${suffix}`;
  docker(["run", "-d", "--name", name, "--label", `speaking-ai.test-run=${suffix}`, "-p", "127.0.0.1::6379", "redis:7.4-alpine", "--appendonly", "no", "--maxmemory", "128mb", "--maxmemory-policy", "noeviction"]);
  containers.push(name);
  for (let i = 0; i < 60; i++) {
    const ready = spawnSync("docker", ["exec", name, "redis-cli", "ping"], { encoding: "utf8", windowsHide: true });
    if (ready.status === 0 && ready.stdout.trim() === "PONG") {
      const binding = docker(["port", name, "6379/tcp"]);
      return `redis://${binding}/0`;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw Error("Integration Redis startup timeout.");
}

try {
  const quota = await redis("quota");
  const jobs = await redis("jobs");
  const env = { ...process.env, CLOUDFLARE_POOL_TEST_REDIS_URL: quota, CLOUDFLARE_POOL_TEST_REDIS_CONFIRM_ISOLATED: "true", CLOUDFLARE_POOL_TEST_REDIS_ALLOW_SCRIPT_FLUSH: "true", AUDIO_TRANSLATION_JOB_TEST_REDIS_URL: jobs, AUDIO_TRANSLATION_JOB_TEST_ISOLATED: "true", AUDIO_TRANSLATION_JOB_TEST_QUOTA_REDIS_URL: quota, APP_RECORDS_ARCHIVE_DOCKER_TEST: "true" };
  console.info("Running all tests with disposable Redis and PostgreSQL. Production credentials are not loaded.");
  const child = spawn(process.execPath, ["scripts/run-tests.mjs"], { cwd: root, env, stdio: "inherit", windowsHide: true });
  process.exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code ?? 1)); });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  for (const name of containers) {
    const owner = spawnSync("docker", ["inspect", "--format", '{{index .Config.Labels "speaking-ai.test-run"}}', name], { encoding: "utf8", windowsHide: true });
    if (owner.status === 0 && owner.stdout.trim() === suffix) spawnSync("docker", ["rm", "-f", "-v", name], { stdio: "ignore", windowsHide: true });
  }
}
