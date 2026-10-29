import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { configureDeployment, DeploymentConfigurationError } from "./runtime-config.mjs";

try {
  const envFile = process.env.APP_ENV_FILE;
  if (envFile) loadEnvFile(envFile);
  else if (existsSync("/run/secrets/app_env")) loadEnvFile("/run/secrets/app_env");
  const command = process.argv[2] || "web";
  const role = command === "check" ? (process.env.APP_ROLE || "web") : command;
  const configuration = configureDeployment(process.env, role);
  if (configuration.pool) {
    const parser = existsSync(new URL("./pool-config.mjs", import.meta.url))
      ? new URL("./pool-config.mjs", import.meta.url)
      : new URL("../../.deployment-runtime/pool-config.mjs", import.meta.url);
    const { parsePoolConfig } = await import(parser.href);
    parsePoolConfig();
  }
  if (command === "check") console.info(JSON.stringify({ event: "deployment_configuration_valid", ...configuration }));
  else if (role === "worker") await import("../../scripts/audio-translation-worker.ts");
  else await import("../../server.js");
} catch (error) {
  const reason = error instanceof DeploymentConfigurationError ? error.message : "Check environment file, pool registry and runtime dependencies.";
  console.error(JSON.stringify({ event: "deployment_startup_failed", reason }));
  process.exitCode = 1;
}
