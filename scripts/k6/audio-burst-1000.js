// k6 burst test: exactly REQUESTS uploads of ONE audio file to
// POST /api/audio/translate, spread evenly across WINDOW_MS.
//
// Run (from the repo root):
//   k6 run scripts/k6/audio-burst-1000.js
//   k6 run -e UNIQUE=1 scripts/k6/audio-burst-1000.js
//
// Env:
//   BASE_URL    target origin (default https://api-dev.hoamytech.com)
//   AUDIO_PATH  WAV file to send (default: the recording below)
//   LANGUAGE    sourceLanguage (default vi)
//   REQUESTS    number of requests (default 1000)
//   WINDOW_MS   time window in which all requests start (default 1000)
//   TOKENS      installations registered in setup, shared round-robin (default 10;
//               registration is limited to ~12/min per IP)
//   UNIQUE      0 (default) sends byte-identical audio. The backend coalesces
//               identical audio from the same client, so 1000 requests become
//               about TOKENS x 2 real translations.
//               1 changes the last 4 bytes per request (inaudible) so every
//               request is its own translation.
//   FALLBACK    1 sends "Prefer: respond-async": the backend answers 200 when it has
//               room and 202 + a job when it is busy; the script then polls the job.
//   JOB_TIMEOUT_S  max seconds to poll a fallback job (default 300)
//   ALLOW_PROD=1 required to target the production API

import http from "k6/http";
import { check, sleep, fail } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

const BASE_URL = (__ENV.BASE_URL || "https://api-dev.hoamytech.com").replace(/\/+$/, "");
const AUDIO_PATH = __ENV.AUDIO_PATH ||
  "D:/Code/HuaMei/App_noi/GHI ÂM GIỌNG TRẺ EM/GHI ÂM GIỌNG TRẺ EM/TONG_HOP_AUDIO_CHIA_50/NHOM_02/MIEN-BAC__B-46-G-01__CAU-07-con-khong-hieu_009.wav";
const LANGUAGE = __ENV.LANGUAGE || "vi";
const REQUESTS = Number(__ENV.REQUESTS || 1000);
const WINDOW_MS = Number(__ENV.WINDOW_MS || 1000);
const TOKENS = Number(__ENV.TOKENS || 10);
const UNIQUE = __ENV.UNIQUE === "1";
const FALLBACK = __ENV.FALLBACK === "1";
const JOB_TIMEOUT_S = Number(__ENV.JOB_TIMEOUT_S || 300);
const MISSING_RESULT_REPOLLS = 3;
const POLL_ERROR_RETRIES = 3;
const PATH = "/api/audio/translate";
const REQUEST_TIMEOUT = "40s"; // route maxDuration is 35s
const SHOWN_STATUSES = ["200", "202", "422", "429", "500", "502", "503", "504"];

const host = BASE_URL.replace(/^https?:\/\//i, "").split(/[/:]/)[0];
if (!/^https?:\/\//i.test(BASE_URL)) fail("BASE_URL must start with http:// or https://");
if (host === "api.hoamytech.com" && __ENV.ALLOW_PROD !== "1") fail("Refusing to burst production. Set ALLOW_PROD=1 to override.");
if (!Number.isInteger(REQUESTS) || REQUESTS < 1) fail("REQUESTS must be a positive integer");

const audioBytes = open(AUDIO_PATH, "b");
const audioName = AUDIO_PATH.split(/[\\/]/).pop();

const duration = new Trend("burst_duration", true);
const success = new Rate("burst_success");
const coalesced = new Rate("burst_coalesced");
const byStatus = new Counter("burst_status");
const byError = new Counter("burst_error");
// End to end: from sending the audio to holding the translation, polling included.
const totalDuration = new Trend("burst_total_duration", true);
const jobDuration = new Trend("burst_job_total_duration", true);
const byPath = new Counter("burst_path");
const missingResult = new Counter("burst_completed_without_result");
const pollErrors = new Counter("burst_poll_errors");

// Thresholds on tagged sub-metrics make k6 print one line per status in the summary.
const statusLines = {};
for (const status of SHOWN_STATUSES) statusLines[`burst_status{status:${status}}`] = ["count>=0"];
for (const path of ["sync", "job"]) statusLines[`burst_path{path:${path}}`] = ["count>=0"];

export const options = {
  setupTimeout: "15m",
  scenarios: {
    // The window, plus one request timeout and some slack for the last request to finish.
    burst: { executor: "per-vu-iterations", vus: REQUESTS, iterations: 1, maxDuration: `${Math.ceil(WINDOW_MS / 1000) + 60 + (FALLBACK ? JOB_TIMEOUT_S : 0)}s` },
  },
  thresholds: { burst_success: ["rate>0.95"], ...statusLines },
  summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "p(99)", "max"],
};

function randomHex(length) {
  let out = "";
  while (out.length < length) out += Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
  return out.slice(0, length);
}

function registerInstallation() {
  const payload = JSON.stringify({
    clientId: `web_k6_${randomHex(24)}`, platform: "web",
    installationSecret: randomHex(48), appVersion: "k6-audio-burst-1.0",
  });
  for (let attempt = 0; attempt < 10; attempt++) {
    const res = http.post(`${BASE_URL}/api/installations/register`, payload, {
      headers: { "Content-Type": "application/json", Accept: "application/json" }, timeout: "20s",
    });
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
  console.log(`${REQUESTS} requests in ${WINDOW_MS}ms -> ${BASE_URL}${PATH} | audio=${audioName} ` +
    `(${audioBytes.byteLength} bytes) | tokens=${tokens.length} | unique=${UNIQUE} | fallback=${FALLBACK}`);
  return { tokens };
}

// Same sound, different bytes: overwrite the last two samples with the request number.
function uniqueAudio(index) {
  const copy = audioBytes.slice(0);
  new DataView(copy).setUint32(copy.byteLength - 4, index + 1, true);
  return copy;
}

function errorCode(res) {
  try { return res.json("error.code") || `HTTP_${res.status}`; } catch (_) { return `HTTP_${res.status}`; }
}

// Polls a fallback job until it holds a translation. Returns the English text, or null.
function waitForJob(statusUrl, firstPollMs, token, startedAt) {
  let nextPollMs = firstPollMs;
  let repolls = 0;
  let pollFailures = 0;
  while (Date.now() - startedAt < JOB_TIMEOUT_S * 1000) {
    sleep(nextPollMs / 1000);
    const poll = http.get(`${BASE_URL}${statusUrl}`, {
      headers: { Authorization: `Bearer ${token.accessToken}`, Accept: "application/json" },
      timeout: "15s", tags: { name: "/api/audio/jobs/:jobId" },
    });
    if (poll.status !== 200) {
      // One failed status read does not mean the job failed: a real client would ask again.
      pollErrors.add(1, { status: String(poll.status) });
      if (++pollFailures > POLL_ERROR_RETRIES) { byError.add(1, { code: `POLL_${errorCode(poll)}` }); return null; }
      nextPollMs = 2000;
      continue;
    }
    const status = poll.json("status");
    if (status === "failed") { byError.add(1, { code: "JOB_FAILED" }); return null; }
    if (status === "completed") {
      const text = poll.json("result.englishText");
      if (text) return text;
      // The status endpoint sometimes reports "completed" before the result is readable.
      missingResult.add(1);
      if (++repolls > MISSING_RESULT_REPOLLS) { byError.add(1, { code: "COMPLETED_WITHOUT_RESULT" }); return null; }
      nextPollMs = 1000;
      continue;
    }
    nextPollMs = Number(poll.json("nextPollMs")) || 2000;
  }
  byError.add(1, { code: "JOB_TIMEOUT" });
  return null;
}

export default function (data) {
  const index = __VU - 1;
  sleep((index / REQUESTS) * (WINDOW_MS / 1000));
  const token = data.tokens[index % data.tokens.length];
  const startedAt = Date.now();
  const res = http.post(`${BASE_URL}${PATH}`, {
    audio: http.file(UNIQUE ? uniqueAudio(index) : audioBytes, audioName, "audio/wav"),
    sourceLanguage: LANGUAGE,
    clientId: token.clientId,
  }, {
    headers: { Authorization: `Bearer ${token.accessToken}`, Accept: "application/json",
      "X-Request-Id": `k6-burst-${randomHex(16)}`,
      ...(FALLBACK ? { Prefer: "respond-async", "Idempotency-Key": `k6-${randomHex(32)}` } : {}) },
    timeout: REQUEST_TIMEOUT, tags: { name: PATH },
  });

  if (FALLBACK && res.status === 202) {
    byStatus.add(1, { status: "202" });
    byPath.add(1, { path: "job" });
    duration.add(res.timings.duration);
    const text = waitForJob(res.json("statusUrl"), Number(res.json("nextPollMs")) || 2000, token, startedAt);
    const elapsed = Date.now() - startedAt;
    if (text) { totalDuration.add(elapsed); jobDuration.add(elapsed); }
    success.add(Boolean(text));
    return;
  }

  const ok = check(res, {
    "status 200": r => r.status === 200,
    "englishText not empty": r => r.status === 200 && Boolean(r.json("englishText")),
  });
  duration.add(res.timings.duration);
  success.add(ok);
  byStatus.add(1, { status: String(res.status) });
  if (res.status === 200) { byPath.add(1, { path: "sync" }); totalDuration.add(res.timings.duration); }
  if (res.status === 200) coalesced.add(String(res.headers["X-Audio-Cache"] || "").toLowerCase() === "coalesced");
  else byError.add(1, { code: errorCode(res) });
  if (index === 0) console.log(`first request: HTTP ${res.status} ${res.status === 200 ? JSON.stringify(res.json("englishText")) : errorCode(res)}`);
}
