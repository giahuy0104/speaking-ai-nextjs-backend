// k6 closed-loop test: each virtual user behaves like one person using the app.
//
//   record (as long as the clip) -> send -> wait for the answer -> think -> repeat
//
// A user never has two requests in flight, so a slow server lowers the request
// rate instead of piling requests up. The test holds each user count for a while
// and prints one result line per user count.
//
// Build the audio mix first:
//   node scripts/k6/build-audio-mix.mjs --src "<folder with .wav>"
// Run (from the repo root):
//   k6 run scripts/k6/audio-closed-loop.js
//   k6 run -e STAGES=50:3m,100:3m,200:3m -e MODE=jobs scripts/k6/audio-closed-loop.js
//
// Env:
//   BASE_URL          target origin (default https://api-dev.hoamytech.com)
//   MODE              sync = POST /api/audio/translate (default)
//                     jobs = POST /api/audio/jobs, then poll the job
//   STAGES            user counts and how long to hold each, "users:duration,..."
//                     (default 20:1m,50:2m,100:2m). Use each user count once.
//   RAMP              time to move from one user count to the next (default 30s)
//   THINK_MIN_S / THINK_MAX_S   pause between an answer and the next recording (default 3 / 8)
//   RECORD            1 = wait the clip's length before sending, as if recording (default); 0 = skip
//   BUSY_RETRIES      times a user re-sends after a 429 before giving up (default 0)
//   CLIENT_TIMEOUT_S  how long the app waits for one HTTP response (default 40)
//   JOB_TIMEOUT_S     jobs mode: how long a user waits for a job (default 120)
//   AUDIO_MIX         mix file from build-audio-mix.mjs (default ./data/audio-mix.json)
//   TOKENS            installations registered in setup and shared by the users (default 12;
//                     registration allows about 12 per minute per IP)
//   SUMMARY_FILE      also write the full k6 summary as JSON to this path
//   ALLOW_PROD=1      required to target the production API
//
// Outcome of one loop, as the user sees it:
//   ok       got a translation
//   unclear  HTTP 422: the server could not understand the audio (not a load failure)
//   busy     HTTP 429 after BUSY_RETRIES
//   error    anything else, including timeouts

import http from "k6/http";
import { sleep, fail } from "k6";
import { SharedArray } from "k6/data";
import { b64decode } from "k6/encoding";
import { Counter, Rate, Trend } from "k6/metrics";

const BASE_URL = (__ENV.BASE_URL || "https://api-dev.hoamytech.com").replace(/\/+$/, "");
const MODE = (__ENV.MODE || "sync").toLowerCase();
const AUDIO_MIX = __ENV.AUDIO_MIX || "./data/audio-mix.json";
const THINK_MIN_S = Number(__ENV.THINK_MIN_S || 3);
const THINK_MAX_S = Number(__ENV.THINK_MAX_S || 8);
const RECORD = __ENV.RECORD !== "0";
const BUSY_RETRIES = Number(__ENV.BUSY_RETRIES || 0);
const CLIENT_TIMEOUT_S = Number(__ENV.CLIENT_TIMEOUT_S || 40);
const JOB_TIMEOUT_S = Number(__ENV.JOB_TIMEOUT_S || 120);
const TOKENS = Number(__ENV.TOKENS || 12);
const MAX_RETRY_WAIT_S = 10;
const POLL_ERROR_RETRIES = 3;
const MISSING_RESULT_REPOLLS = 3;
const OUTCOMES = ["ok", "unclear", "busy", "error"];
const SHOWN_STATUSES = ["0", "200", "202", "401", "413", "422", "429", "500", "502", "503", "504"];

function seconds(text) {
  let total = 0;
  for (const [, amount, unit] of String(text).matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) {
    total += Number(amount) * { ms: 0.001, s: 1, m: 60, h: 3600 }[unit];
  }
  if (!(total > 0)) fail(`Cannot read a duration from "${text}" (use for example 30s, 2m, 1m30s)`);
  return total;
}

function parseStages(text) {
  const stages = String(text).split(",").map(part => {
    const [users, hold] = part.trim().split(":");
    if (!(Number(users) > 0) || !hold) fail(`STAGES entry "${part}" must look like 50:2m`);
    return { users: Number(users), holdS: seconds(hold) };
  });
  if (new Set(stages.map(stage => stage.users)).size !== stages.length) fail("STAGES must use each user count once");
  return stages;
}

const STAGES = parseStages(__ENV.STAGES || "20:1m,50:2m,100:2m");
const RAMP_S = seconds(__ENV.RAMP || "30s");

const host = BASE_URL.replace(/^https?:\/\//i, "").split(/[/:]/)[0];
if (!/^https?:\/\//i.test(BASE_URL)) fail("BASE_URL must start with http:// or https://");
if (host === "api.hoamytech.com" && __ENV.ALLOW_PROD !== "1") fail("Refusing to load-test production. Set ALLOW_PROD=1 to override.");
if (MODE !== "sync" && MODE !== "jobs") fail("MODE must be sync or jobs");
if (!(THINK_MAX_S >= THINK_MIN_S && THINK_MIN_S >= 0)) fail("THINK_MIN_S must be <= THINK_MAX_S");

const mix = new SharedArray("audio mix", () => {
  const clips = JSON.parse(open(AUDIO_MIX));
  if (!Array.isArray(clips) || !clips.length) throw new Error(`No clips in ${AUDIO_MIX}`);
  return clips;
});

// Elapsed-time windows: results are tagged with the user count being held, or "ramp".
const TIMELINE = [];
{
  let at = 0;
  for (const stage of STAGES) {
    TIMELINE.push({ from: at, to: at + RAMP_S, label: "ramp" });
    at += RAMP_S;
    TIMELINE.push({ from: at, to: at + stage.holdS, label: String(stage.users) });
    at += stage.holdS;
  }
}
function stageLabel(testStartedAt) {
  const elapsedS = (Date.now() - testStartedAt) / 1000;
  for (const window of TIMELINE) if (elapsedS >= window.from && elapsedS < window.to) return window.label;
  return "end";
}

const waitTime = new Trend("loop_wait", true);
const outcomeRates = Object.fromEntries(OUTCOMES.map(outcome => [outcome, new Rate(`loop_${outcome}`)]));
const statusCounter = new Counter("loop_http_status");
const missingResult = new Counter("loop_completed_without_result");

// A threshold on a tagged sub-metric is what makes k6 keep per-stage numbers for the summary.
const thresholds = {};
for (const stage of STAGES) {
  thresholds[`loop_wait{users:${stage.users}}`] = ["max>=0"];
  for (const outcome of OUTCOMES) thresholds[`loop_${outcome}{users:${stage.users}}`] = ["rate>=0"];
}
for (const status of SHOWN_STATUSES) thresholds[`loop_http_status{status:${status}}`] = ["count>=0"];

const rampingStages = STAGES.flatMap(stage => [
  { duration: `${RAMP_S}s`, target: stage.users },
  { duration: `${stage.holdS}s`, target: stage.users },
]);

export const options = {
  setupTimeout: "15m",
  scenarios: {
    users: { executor: "ramping-vus", startVUs: 0, stages: rampingStages, exec: "userLoop",
      gracefulRampDown: "60s", gracefulStop: `${(MODE === "jobs" ? JOB_TIMEOUT_S : CLIENT_TIMEOUT_S) + 5}s` },
  },
  thresholds,
  summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "max"],
};

function randomHex(length) {
  let out = "";
  while (out.length < length) out += Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
  return out.slice(0, length);
}

function registerInstallation() {
  const payload = JSON.stringify({ clientId: `web_k6_${randomHex(24)}`, platform: "web",
    installationSecret: randomHex(48), appVersion: "k6-closed-loop-1.0" });
  for (let attempt = 0; attempt < 10; attempt++) {
    const res = http.post(`${BASE_URL}/api/installations/register`, payload, {
      headers: { "Content-Type": "application/json", Accept: "application/json" }, timeout: "20s" });
    if (res.status === 201) return { clientId: res.json("clientId"), accessToken: res.json("accessToken") };
    if (res.status !== 429) fail(`register failed: HTTP ${res.status} ${String(res.body).slice(0, 200)}`);
    const wait = Number(res.headers["Retry-After"]) || 10;
    console.warn(`register rate limited, waiting ${wait}s`);
    sleep(wait + 1);
  }
  fail("register failed after retries");
}

export function setup() {
  const tokens = [];
  for (let i = 0; i < TOKENS; i++) tokens.push(registerInstallation());
  const lengths = mix.map(clip => clip.durationMs / 1000);
  console.log(`closed loop -> ${BASE_URL} | mode=${MODE} | stages=${STAGES.map(s => `${s.users} users x ${s.holdS}s`).join(", ")} | ` +
    `ramp=${RAMP_S}s | think=${THINK_MIN_S}-${THINK_MAX_S}s | clips=${mix.length} (${Math.min(...lengths).toFixed(1)}-${Math.max(...lengths).toFixed(1)}s) | ` +
    `record=${RECORD} | busy retries=${BUSY_RETRIES} | tokens=${tokens.length}`);
  return { tokens, testStartedAt: Date.now() };
}

function jsonField(res, path) {
  try { return res.json(path); } catch (_) { return undefined; }
}

function sendAudio(token, clip, path, extraHeaders) {
  const res = http.post(`${BASE_URL}${path}`, {
    audio: http.file(b64decode(clip.audioBase64, "std"), clip.audioName, "audio/wav"),
    sourceLanguage: clip.sourceLanguage || "vi",
    clientId: token.clientId,
  }, {
    headers: { Authorization: `Bearer ${token.accessToken}`, Accept: "application/json",
      "X-Request-Id": `k6-loop-${randomHex(16)}`, ...extraHeaders },
    timeout: `${CLIENT_TIMEOUT_S}s`, tags: { name: path },
  });
  statusCounter.add(1, { status: String(res.status) });
  return res;
}

function rejection(res) {
  const kind = res.status === 429 ? "busy" : res.status === 422 ? "unclear" : "error";
  return { kind, retryAfterS: Number(res.headers["Retry-After"]) || 1 };
}

function syncAttempt(token, clip) {
  const res = sendAudio(token, clip, "/api/audio/translate", {});
  if (res.status === 200) return { kind: jsonField(res, "englishText") ? "ok" : "error" };
  return rejection(res);
}

function jobsAttempt(token, clip) {
  const startedAt = Date.now();
  const res = sendAudio(token, clip, "/api/audio/jobs", { "Idempotency-Key": `k6-${randomHex(32)}` });
  if (res.status !== 202) return rejection(res);
  const statusUrl = jsonField(res, "statusUrl");
  let nextPollMs = Number(jsonField(res, "nextPollMs")) || 2000;
  let pollFailures = 0;
  let repolls = 0;
  while (Date.now() - startedAt < JOB_TIMEOUT_S * 1000) {
    sleep(nextPollMs / 1000);
    const poll = http.get(`${BASE_URL}${statusUrl}`, {
      headers: { Authorization: `Bearer ${token.accessToken}`, Accept: "application/json" },
      timeout: "15s", tags: { name: "/api/audio/jobs/:jobId" },
    });
    if (poll.status !== 200) {
      // One failed status read does not mean the job failed: the app would ask again.
      if (++pollFailures > POLL_ERROR_RETRIES) return { kind: "error" };
      nextPollMs = 2000;
      continue;
    }
    const status = jsonField(poll, "status");
    if (status === "failed") return { kind: "error" };
    if (status === "completed") {
      if (jsonField(poll, "result.englishText")) return { kind: "ok" };
      missingResult.add(1);
      if (++repolls > MISSING_RESULT_REPOLLS) return { kind: "error" };
      nextPollMs = 1000;
      continue;
    }
    nextPollMs = Number(jsonField(poll, "nextPollMs")) || 2000;
  }
  return { kind: "error" };
}

export function userLoop(data) {
  const token = data.tokens[(__VU - 1) % data.tokens.length];
  const clip = mix[Math.floor(Math.random() * mix.length)];
  if (RECORD) sleep(clip.durationMs / 1000);

  const tags = { users: stageLabel(data.testStartedAt) };
  const sentAt = Date.now();
  let outcome;
  for (let retries = 0; ; retries++) {
    outcome = MODE === "jobs" ? jobsAttempt(token, clip) : syncAttempt(token, clip);
    if (outcome.kind !== "busy" || retries >= BUSY_RETRIES) break;
    sleep(Math.min(outcome.retryAfterS, MAX_RETRY_WAIT_S));
  }
  for (const kind of OUTCOMES) outcomeRates[kind].add(outcome.kind === kind, tags);
  // The wait a user feels: from sending until the app has an answer to show.
  if (outcome.kind === "ok" || outcome.kind === "unclear") waitTime.add(Date.now() - sentAt, tags);

  sleep(THINK_MIN_S + Math.random() * (THINK_MAX_S - THINK_MIN_S));
}

function percent(rate) { return rate === undefined ? "    -" : `${(rate * 100).toFixed(1).padStart(5)}%`; }
function secondsText(ms) { return ms === undefined ? "    -" : `${(ms / 1000).toFixed(1).padStart(5)}s`; }

export function handleSummary(data) {
  const metric = name => (data.metrics[name] || {}).values || {};
  const lines = [
    "",
    `Closed-loop result (${MODE}, ${BASE_URL})`,
    "users | loops | req/s |     ok | unclear |   busy |  error | wait avg | wait p95 | wait max",
    "------|-------|-------|--------|---------|--------|--------|----------|----------|---------",
  ];
  for (const stage of STAGES) {
    const tag = `{users:${stage.users}}`;
    const ok = metric(`loop_ok${tag}`);
    const loops = (ok.passes || 0) + (ok.fails || 0);
    const wait = metric(`loop_wait${tag}`);
    lines.push([
      String(stage.users).padStart(5), String(loops).padStart(5), (loops / stage.holdS).toFixed(1).padStart(5),
      percent(loops ? ok.rate : undefined), ` ${percent(loops ? metric(`loop_unclear${tag}`).rate : undefined)}`,
      percent(loops ? metric(`loop_busy${tag}`).rate : undefined), percent(loops ? metric(`loop_error${tag}`).rate : undefined),
      `  ${secondsText(wait.avg)}`, `  ${secondsText(wait["p(95)"])}`, ` ${secondsText(wait.max)}`,
    ].join(" | "));
  }
  const statuses = SHOWN_STATUSES.map(status => [status, metric(`loop_http_status{status:${status}}`).count || 0])
    .filter(([, count]) => count > 0).map(([status, count]) => `${status === "0" ? "no response" : status}: ${count}`);
  lines.push("", `HTTP responses to the audio upload, whole run: ${statuses.join(", ") || "none"}`);
  const missing = metric("loop_completed_without_result").count;
  if (missing) lines.push(`Job status said "completed" without a result ${missing} time(s); the script asked again.`);
  lines.push("Rows cover only the time each user count was held; ramp time is left out.", "");
  const out = { stdout: lines.join("\n") };
  if (__ENV.SUMMARY_FILE) out[__ENV.SUMMARY_FILE] = JSON.stringify(data, null, 1);
  return out;
}
