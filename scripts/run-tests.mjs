import { readdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
async function discover(directory) {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });
  const found = await Promise.all(entries.map(entry => entry.isDirectory() ? discover(path.join(directory, entry.name)) : /\.test\.(?:ts|mjs)$/.test(entry.name) ? [path.join(directory, entry.name)] : []));
  return found.flat();
}
const files = (await Promise.all(["src", "scripts", "infra"].map(discover))).flat().sort();
const env = { ...process.env, NODE_ENV: "test", DATABASE_URL: "", PERSISTENCE_BACKEND: "local" };
// A developer may have exported live credentials in the shell. Test processes
// receive only their disposable infrastructure URLs and per-test fixtures.
const applicationKeys = new Set(Object.keys(parseEnv(await readFile(path.join(root, ".env.example"), "utf8"))));
for (const key of Object.keys(env)) {
  if ((applicationKeys.has(key) || /^(?:CLOUDFLARE_|CLOUDINARY_|INSTALLATION_|AUDIO_|ADMIN_|CRON_SECRET$|APP_ENV_FILE$|APP_RUNTIME$|APP_RECORDS_ARCHIVE_R2_BUCKET$|GENERATED_AUDIO_BLOB_|BLOB_READ_WRITE_TOKEN$)/.test(key))
      && !key.startsWith("CLOUDFLARE_POOL_TEST_REDIS_") && !key.startsWith("AUDIO_TRANSLATION_JOB_TEST_")) delete env[key];
}
env.DATABASE_URL = "";
env.PERSISTENCE_BACKEND = "local";
const child = spawn(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=1", ...files], { cwd: root, env, stdio: "inherit", windowsHide: true });
child.once("error", () => { process.exitCode = 1; });
child.once("exit", code => { process.exitCode = code ?? 1; });
