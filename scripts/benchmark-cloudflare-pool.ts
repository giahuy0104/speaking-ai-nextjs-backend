import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

type Sample = { audioPath: string; sourceLanguage: string; referenceEnglish?: string; mimeType?: string };
type Manifest = { samples: Sample[]; clientId?: string };
type Result = { elapsedMs: number; sendOffsetMs: number; status: number | null;
  outcome: "success" | "http_failure" | "network_failure" | "contract_failure";
  exactReferenceMatch?: boolean };

function argumentsMap() {
  const args = process.argv.slice(2); const options = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    if (["--allow-remote", "--help"].includes(args[i])) options.set(args[i], "true");
    else {
      if (!args[i].startsWith("--") || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error("invalid_arguments");
      options.set(args[i], args[++i]);
    }
  }
  const allowed = new Set(["--allow-remote", "--help", "--manifest", "--url", "--mode", "--clients", "--duration-seconds", "--output"]);
  if ([...options.keys()].some(key => !allowed.has(key))) throw new Error("invalid_arguments");
  return options;
}
function percentile(values: number[], quantile: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)]);
}
const normalized = (value: string) => value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");

async function main() {
  const options = argumentsMap();
  if (options.has("--help")) {
    console.info("benchmark-cloudflare-pool --manifest file.json [--url http://localhost:3000/api/audio/translate] [--mode burst|sustained] [--clients 20] [--duration-seconds 120] [--output results.json] [--allow-remote]\nManifest: {samples:[{audioPath,sourceLanguage,referenceEnglish?,mimeType?}],clientId?}.\nOptional installation bearer: CLOUDFLARE_POOL_BENCHMARK_AUTH_TOKEN. Remote targets require --allow-remote. This calls the endpoint and can spend provider quota."); return;
  }
  const url = new URL(options.get("--url") || "http://localhost:3000/api/audio/translate");
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/api/audio/translate") throw new Error("invalid_url");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!local && (!options.has("--allow-remote") || url.protocol !== "https:")) throw new Error("remote_requires_explicit_https");
  const mode = options.get("--mode") || "burst";
  const clients = Number(options.get("--clients") || 20);
  const durationSeconds = Number(options.get("--duration-seconds") || 120);
  if (!["burst", "sustained"].includes(mode) || !Number.isInteger(clients) || clients < 1 || clients > 100 ||
    !Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 600 || !options.get("--manifest")) throw new Error("invalid_arguments");
  const manifestPath = path.resolve(options.get("--manifest")!);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
  if (!Array.isArray(manifest.samples) || !manifest.samples.length || manifest.samples.length > 100 ||
    (manifest.clientId !== undefined && typeof manifest.clientId !== "string")) throw new Error("invalid_manifest");
  let totalBytes = 0;
  const samples = await Promise.all(manifest.samples.map(async sample => {
    if (typeof sample.audioPath !== "string" || !/^[a-z]{2,3}$/.test(sample.sourceLanguage) ||
      (sample.referenceEnglish !== undefined && typeof sample.referenceEnglish !== "string") ||
      (sample.mimeType !== undefined && typeof sample.mimeType !== "string")) throw new Error("invalid_manifest_sample");
    const bytes = await readFile(path.resolve(path.dirname(manifestPath), sample.audioPath));
    totalBytes += bytes.length;
    if (!bytes.length || bytes.length > 10 * 1024 * 1024 || totalBytes > 64 * 1024 * 1024) throw new Error("benchmark_audio_too_large");
    return { ...sample, audio: new File([bytes], path.basename(sample.audioPath), { type: sample.mimeType || "application/octet-stream" }) };
  }));
  const results: Result[] = []; let sequence = 0;
  const startedAt = performance.now(); const stopAt = startedAt + durationSeconds * 1000;
  const send = async () => {
    if (results.length >= 100_000) throw new Error("benchmark_sample_limit");
    const sample = samples[sequence++ % samples.length];
    const form = new FormData(); form.set("audio", sample.audio); form.set("sourceLanguage", sample.sourceLanguage);
    if (manifest.clientId) form.set("clientId", manifest.clientId);
    const headers: Record<string, string> = {};
    if (process.env.CLOUDFLARE_POOL_BENCHMARK_AUTH_TOKEN) headers.Authorization = `Bearer ${process.env.CLOUDFLARE_POOL_BENCHMARK_AUTH_TOKEN}`;
    const requestStarted = performance.now();
    let status: number | null = null;
    let outcome: Result["outcome"] = "network_failure"; let exactReferenceMatch: boolean | undefined;
    try {
      const response = await fetch(url, { method: "POST", body: form, headers, signal: AbortSignal.timeout(40_000), redirect: "error" });
      status = response.status;
      const payload = await response.json().catch(() => null);
      outcome = !response.ok ? "http_failure" : payload?.targetLanguage === "en" && typeof payload?.englishText === "string" && payload.englishText.trim()
        ? "success" : "contract_failure";
      if (outcome === "success" && sample.referenceEnglish !== undefined) exactReferenceMatch = normalized(payload.englishText) === normalized(sample.referenceEnglish);
    } catch { /* Network errors are counted separately, never passed off as fast successful requests. */ }
    results.push({ status, outcome, sendOffsetMs: requestStarted - startedAt, elapsedMs: performance.now() - requestStarted,
      ...(exactReferenceMatch === undefined ? {} : { exactReferenceMatch }) });
  };
  await Promise.all(Array.from({ length: clients }, async () => {
    do { await send(); } while (mode === "sustained" && performance.now() < stopAt);
  }));
  const elapsedSeconds = (performance.now() - startedAt) / 1000;
  const successful = results.filter(result => result.outcome === "success");
  const statusCounts: Record<string, number> = {};
  for (const result of results) { const key = result.status === null ? "network" : String(result.status); statusCounts[key] = (statusCounts[key] || 0) + 1; }
  const report = {
    mode, clients, attempted: results.length, successful: successful.length, successRate: successful.length / results.length,
    attemptedPerSecond: results.length / elapsedSeconds, elapsedSeconds, statusCounts,
    networkFailures: results.filter(r => r.outcome === "network_failure").length,
    contractFailures: results.filter(r => r.outcome === "contract_failure").length,
    burstSendSkewMs: mode === "burst" ? Math.round(Math.max(...results.map(r => r.sendOffsetMs)) - Math.min(...results.map(r => r.sendOffsetMs))) : null,
    successLatencyMs: { p50: percentile(successful.map(r => r.elapsedMs), .5), p95: percentile(successful.map(r => r.elapsedMs), .95), p99: percentile(successful.map(r => r.elapsedMs), .99) },
    allRequestLatencyMs: { p50: percentile(results.map(r => r.elapsedMs), .5), p95: percentile(results.map(r => r.elapsedMs), .95), p99: percentile(results.map(r => r.elapsedMs), .99) },
    exactReferenceMatches: successful.filter(r => r.exactReferenceMatch === true).length,
    referenceEvaluated: successful.filter(r => r.exactReferenceMatch !== undefined).length,
    semanticQuality: "requires_human_review_exact_match_is_not_semantic_scoring",
    admissionAndProviderMetrics: "correlate_backend_cloudflare_pool_events_not_observable_from_http_alone",
  };
  if (options.get("--output")) await writeFile(path.resolve(options.get("--output")!), JSON.stringify({ report, requests: results }, null, 2));
  console.info(JSON.stringify(report, null, 2));
  if (successful.length !== results.length) process.exitCode = 1;
}

main().catch(() => {
  console.error("Benchmark failed. Check arguments, manifest and local/staging server. No secrets or audio text printed.");
  process.exitCode = 1;
});
