import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { freemem, totalmem } from "node:os";
import { runAudioLoadWorkers } from "./lib/audioLoadRunner";

type Item = { item?: Item[]; request?: { header?: { key: string; value: string; disabled?: boolean }[]; body?: { raw?: string } } };
type Measurement = { requestId: string; status: number | null; elapsedMs: number; cache: string | null; reason?: string; stage?: string };
async function main() {
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const clients = Number(args.get("--clients") || 20);
const seconds = Number(args.get("--seconds") || 120);
const mode = args.get("--mode") || "sustained";
const maxRequests = Number(args.get("--max-requests") || 2000);
const maxUsedMemoryPercent = Number(args.get("--max-memory-percent") || 90);
const minFreeMemoryMB = Number(args.get("--min-free-memory-mb") || 1024);
const url = new URL(args.get("--url") || "http://localhost:3000/api/audio/translate");
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password ||
    url.pathname !== "/api/audio/translate" || !["burst", "sustained"].includes(mode) ||
    !Number.isInteger(clients) || clients < 1 || clients > 100 || !Number.isInteger(seconds) || seconds < 1 || seconds > 120 ||
    !Number.isInteger(maxRequests) || maxRequests < clients || maxRequests > 10_000 ||
    !Number.isFinite(maxUsedMemoryPercent) || maxUsedMemoryPercent < 1 || maxUsedMemoryPercent >= 95 ||
    !Number.isFinite(minFreeMemoryMB) || minFreeMemoryMB < 256) {
  throw new Error("Invalid local benchmark arguments");
}
const collection = JSON.parse(await readFile(args.get("--collection") || "docs/postman/Audio-Translation-Performance.postman_collection.json", "utf8"));
function firstRequest(items: Item[]): NonNullable<Item["request"]> | undefined {
  for (const item of items) { if (item.request) return item.request; const nested = firstRequest(item.item || []); if (nested) return nested; }
}
const sample = firstRequest(collection.item);
if (!sample?.body?.raw || sample.body.raw.includes("{{")) throw new Error("Collection needs a complete raw multipart body");
const headers = Object.fromEntries((sample.header || []).filter(h => !h.disabled && !/^x-request-id$/i.test(h.key)).map(h => [h.key, h.value]));
if (process.env.CLOUDFLARE_POOL_BENCHMARK_AUTH_TOKEN) headers.Authorization = `Bearer ${process.env.CLOUDFLARE_POOL_BENCHMARK_AUTH_TOKEN}`;
const runId = `opt-${args.get("--label") || "baseline"}-${randomUUID()}`;
const startedAt = new Date().toISOString();
const measurements: Measurement[] = [];
const start = performance.now();
const sendUntil = start + seconds * 1000;
async function send(sequence: number) {
  const requestId = `${runId}-${sequence}`;
  const sent = performance.now();
  let measurement: Measurement = { requestId, status: null, elapsedMs: 0, cache: null };
  try {
    const response = await fetch(url, { method: "POST", headers: { ...headers, "X-Request-Id": requestId }, body: sample!.body!.raw,
      redirect: "error", signal: AbortSignal.timeout(40_000) });
    const payload = await response.json().catch(() => null);
    measurement = { ...measurement, status: response.status, cache: response.headers.get("X-Audio-Cache"),
      reason: payload?.error?.details?.reason, stage: payload?.error?.details?.stage };
    if (response.status === 200 && (!payload?.englishText?.trim() || payload?.targetLanguage !== "en")) measurement.reason = "invalid_contract";
  } catch { measurement.reason = "network_failure"; }
  measurement.elapsedMs = Math.round(performance.now() - sent);
  measurements.push(measurement);
}
console.info(JSON.stringify({ event: "benchmark_started", runId, clients, seconds, mode, usesRealProvider: true,
  maxUsedMemoryPercent, minFreeMemoryMB }));
const admissionStop = new AbortController();
const stopAdmission = () => admissionStop.abort();
process.once("SIGINT", stopAdmission);
process.once("SIGTERM", stopAdmission);
const load = await runAudioLoadWorkers({ clients, mode: mode as "burst" | "sustained", maxRequests, sendUntil,
  now: () => performance.now(), readMemory: () => {
    const freeBytes = freemem();
    return { freeBytes, usedPercent: Number((100 * (1 - freeBytes / totalmem())).toFixed(2)) };
  },
  maxUsedMemoryPercent, minFreeMemoryBytes: minFreeMemoryMB * 1024 * 1024,
  send, stopSignal: admissionStop.signal,
  onStop: (reason, memory) => console.info(JSON.stringify({ event: "benchmark_draining", reason,
    usedMemoryPercent: memory.usedPercent, freeMemoryMB: Math.round(memory.freeBytes / 1024 / 1024) })),
});
process.removeListener("SIGINT", stopAdmission);
process.removeListener("SIGTERM", stopAdmission);
const elapsedSeconds = (performance.now() - start) / 1000;
const successful = measurements.filter(m => m.status === 200 && !m.reason);
function latency(rows: Measurement[]) {
  const sorted = rows.map(m => m.elapsedMs).sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null;
  return { p50: q(.5), p95: q(.95), p99: q(.99), max: sorted.at(-1) ?? null };
}
const counts = (values: string[]) => values.reduce<Record<string, number>>((m, k) => { m[k] = (m[k] || 0) + 1; return m; }, {});
const report = { runId, startedAt, completedAt: new Date().toISOString(), clients, sendWindowSeconds: seconds, elapsedSeconds, mode,
  workload: "unchanged Postman raw multipart; identical recording", drain: "in-flight requests finish after send window; no end-of-test cancellation",
  attempted: measurements.length, successful: successful.length, successRate: measurements.length ? successful.length / measurements.length : null,
  successfulPerSecond: successful.length / elapsedSeconds, statusCounts: counts(measurements.map(m => String(m.status ?? "network"))),
  cacheCounts: counts(measurements.map(m => m.cache || "not_instrumented")), successLatencyMs: latency(successful),
  allLatencyMs: latency(measurements), semanticQualityEvaluated: false, maxRequests,
  requestLimitReached: load.admitted >= maxRequests, loadControl: load,
  generatorMemory: { rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024), maxUsedMemoryPercent, minFreeMemoryMB } };
const output = path.resolve(args.get("--output") || `docs/postman/reports/${runId}.json`);
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify({ report, requests: measurements }, null, 2) + "\n");
console.info(JSON.stringify(report, null, 2));
if (!measurements.length || successful.length !== measurements.length ||
    load.stopReason === "memory_pressure" || load.stopReason === "interrupted") process.exitCode = 1;
}
main().catch(() => { console.error("Local benchmark failed; check arguments and collection. No credentials or audio printed."); process.exitCode = 1; });
