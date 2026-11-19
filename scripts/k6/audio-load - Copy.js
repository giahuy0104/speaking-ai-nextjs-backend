// k6 load test for the audio translation flow.
//
// Modes:
//   MODE=sync  POST /api/audio/translate (wait for the translation in one request)
//   MODE=jobs  POST /api/audio/jobs, then poll GET /api/audio/jobs/:jobId until done
//
// Load is arrival-rate based: RATE new flows start per second regardless of how
// slow the server is (k6 adds VUs up to MAX_VUS; overflow shows as dropped_iterations).
//
// Example:
//   k6 run -e BASE_URL=https://api-dev.hoamytech.com -e MODE=sync -e RATE=5 -e DURATION=1m scripts/k6/audio-load.js
//
// Env:
//   BASE_URL     target origin (default https://api-dev.hoamytech.com)
//   MODE         sync | jobs (default sync)
//   PROFILE      constant | ramp (default ramp: 1/s -> RATE over DURATION, then hold)
//   RATE         target new flows per second (default 5)
//   DURATION     duration of each stage, e.g. 30s, 2m (default 1m)
//   MAX_VUS      upper bound of concurrent VUs (default 500)
//   TOKENS       installations registered in setup and shared round-robin (default 10)
//   AUDIO_FILE   iteration data JSON [{audioName, sourceLanguage, audioBase64}]
//   JOB_TIMEOUT_S  max seconds to poll a job (default 90)
//   P95_MS       p95 threshold for the full flow (default 15000)
//   ALLOW_PROD=1 required to target the production API

import http from "k6/http";
import { check, sleep, fail } from "k6";
import { SharedArray } from "k6/data";
import { b64decode } from "k6/encoding";
import { Counter, Rate, Trend } from "k6/metrics";

const BASE_URL = (__ENV.BASE_URL || "https://api-dev.hoamytech.com").replace(/\/+$/, "");
const MODE = (__ENV.MODE || "sync").toLowerCase();
const PROFILE = (__ENV.PROFILE || "ramp").toLowerCase();
const RATE = Number(__ENV.RATE || 5);
const DURATION = __ENV.DURATION || "1m";
const MAX_VUS = Number(__ENV.MAX_VUS || 500);
const TOKENS = Number(__ENV.TOKENS || 10);
const AUDIO_FILE = __ENV.AUDIO_FILE || "../../docs/postman/iteration-data/audio-iteration-data-10.json";
const JOB_TIMEOUT_S = Number(__ENV.JOB_TIMEOUT_S || 90);
const P95_MS = Number(__ENV.P95_MS || 15000);
const REQUEST_TIMEOUT = "40s"; // route maxDuration is 35s

const PROD_HOSTS = ["api.hoamytech.com"];
const host = BASE_URL.replace(/^https?:\/\//i, "").split(/[/:]/)[0];
if (!/^https?:\/\//i.test(BASE_URL)) fail("BASE_URL must start with http:// or https://");
if (PROD_HOSTS.includes(host) && __ENV.ALLOW_PROD !== "1") fail(`Refusing to load-test production (${host}). Set ALLOW_PROD=1 to override.`);
if (MODE !== "sync" && MODE !== "jobs") fail("MODE must be sync or jobs");

const audios = new SharedArray("audios", () => {
  const rows = JSON.parse(open(AUDIO_FILE));
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`No rows in ${AUDIO_FILE}`);
  return rows.map(r => ({
    audioName: r.audioName,
    sourceLanguage: r.sourceLanguage || "vi",
    audioBase64: String(r.audioBase64).replace(/\s+/g, ""),
  }));
});

const flowDuration = new Trend("audio_flow_duration", true);
const jobQueueWait = new Trend("audio_job_queue_wait", true);
const flowSuccess = new Rate("audio_flow_success");
const rateLimited = new Rate("audio_rate_limited");
const cacheHit = new Rate("audio_cache_hit");
const failures = new Counter("audio_flow_failures");

function scenario() {
  const base = { preAllocatedVUs: Math.min(MAX_VUS, Math.max(10, RATE * 2)), maxVUs: MAX_VUS, timeUnit: "1s", exec: "audioFlow" };
  if (PROFILE === "constant") return { ...base, executor: "constant-arrival-rate", rate: RATE, duration: DURATION };
  return { ...base, executor: "ramping-arrival-rate", startRate: 1,
    stages: [{ target: RATE, duration: DURATION }, { target: RATE, duration: DURATION }, { target: 0, duration: "10s" }] };
}

export const options = {
  setupTimeout: "15m",
  scenarios: { audio: scenario() },
  thresholds: {
    audio_flow_success: ["rate>0.95"],
    audio_flow_duration: [`p(95)<${P95_MS}`],
    audio_rate_limited: ["rate<0.05"],
  },
  summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "p(99)", "max"],
};

function randomHex(length) {
  let out = "";
  while (out.length < length) out += Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
  return out.slice(0, length);
}

function registerInstallation() {
  const payload = JSON.stringify({
    clientId: `web_k6_${randomHex(24)}`,
    platform: "web",
    installationSecret: randomHex(48),
    appVersion: "k6-audio-load-1.0",
  });
  for (let attempt = 0; attempt < 10; attempt++) {
    const res = http.post(`${BASE_URL}/api/installations/register`, payload, {
      headers: { "Content-Type": "application/json", Accept: "application/json" }, timeout: "20s",
    });
    if (res.status === 201) return { clientId: res.json("clientId"), accessToken: res.json("accessToken") };
    if (res.status === 429) {
      const wait = Number(res.headers["Retry-After"]) || 10;
      console.warn(`register rate limited, waiting ${wait}s`);
      sleep(wait + 1);
      continue;
    }
    fail(`register failed: HTTP ${res.status} ${res.body && String(res.body).slice(0, 200)}`);
  }
  fail("register failed after retries");
}

export function setup() {
  const health = http.get(`${BASE_URL}/api/health`, { timeout: "10s" });
  if (health.status >= 500 || health.status === 0) fail(`health check failed: HTTP ${health.status}`);
  const tokens = [];
  for (let i = 0; i < TOKENS; i++) tokens.push(registerInstallation());
  console.log(`registered ${tokens.length} installations against ${BASE_URL} (mode=${MODE})`);
  return { tokens };
}

function errorCode(res) {
  try { return res.json("error.code") || `HTTP_${res.status}`; } catch (_) { return `HTTP_${res.status}`; }
}

function recordFailure(stage, res) {
  failures.add(1, { stage, code: errorCode(res) });
  flowSuccess.add(false);
}

function submit(token, audio, path, extraHeaders) {
  const body = {
    audio: http.file(b64decode(audio.audioBase64, "std"), audio.audioName, "audio/wav"),
    sourceLanguage: audio.sourceLanguage,
    clientId: token.clientId,
  };
  const res = http.post(`${BASE_URL}${path}`, body, {
    headers: { Authorization: `Bearer ${token.accessToken}`, Accept: "application/json",
      "X-Request-Id": `k6-${MODE}-${randomHex(16)}`, ...extraHeaders },
    timeout: REQUEST_TIMEOUT, tags: { name: path },
  });
  rateLimited.add(res.status === 429);
  return res;
}

function syncFlow(token, audio) {
  const res = submit(token, audio, "/api/audio/translate", {});
  const ok = check(res, {
    "translate 200": r => r.status === 200,
    "englishText not empty": r => r.status === 200 && Boolean(r.json("englishText")),
  });
  if (res.status === 200) cacheHit.add(String(res.headers["X-Audio-Cache"] || "").toUpperCase() === "HIT");
  flowDuration.add(res.timings.duration);
  if (!ok) return recordFailure("translate", res);
  flowSuccess.add(true);
}

function jobsFlow(token, audio) {
  const startedAt = Date.now();
  const res = submit(token, audio, "/api/audio/jobs", { "Idempotency-Key": `k6-${randomHex(32)}` });
  if (!check(res, { "job accepted 202": r => r.status === 202 })) return recordFailure("submit", res);
  const statusUrl = res.json("statusUrl");
  let nextPollMs = Number(res.json("nextPollMs")) || 2000;
  let seenRunning = false;
  while (Date.now() - startedAt < JOB_TIMEOUT_S * 1000) {
    sleep(nextPollMs / 1000);
    const poll = http.get(`${BASE_URL}${statusUrl}`, {
      headers: { Authorization: `Bearer ${token.accessToken}`, Accept: "application/json" },
      timeout: "15s", tags: { name: "/api/audio/jobs/:jobId" },
    });
    if (poll.status !== 200) return recordFailure("poll", poll);
    const status = poll.json("status");
    if (!seenRunning && status !== "queued") { seenRunning = true; jobQueueWait.add(Date.now() - startedAt); }
    if (status === "completed") {
      flowDuration.add(Date.now() - startedAt);
      const ok = check(poll, { "job englishText not empty": r => Boolean(r.json("result.englishText")) });
      if (!ok) return recordFailure("result", poll);
      flowSuccess.add(true);
      return;
    }
    if (status === "failed") { flowDuration.add(Date.now() - startedAt); return recordFailure("job_failed", poll); }
    nextPollMs = Number(poll.json("nextPollMs")) || 2000;
  }
  failures.add(1, { stage: "poll", code: "JOB_TIMEOUT" });
  flowSuccess.add(false);
}

export function audioFlow(data) {
  const n = __VU * 100003 + __ITER;
  const token = data.tokens[n % data.tokens.length];
  const audio = audios[n % audios.length];
  if (MODE === "jobs") jobsFlow(token, audio);
  else syncFlow(token, audio);
}
