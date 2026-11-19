// k6 burst test: every virtual user makes exactly ONE turn, all users of a wave at once.
//
//   POST /api/conversation  multipart audio (Vietnamese recording), targetLanguage zh/ja/ko/fr
//   -> translation + latency.asrMs + latency.llmMs + audioUrl
//   GET audioUrl            first audio byte and end of download
//
// Waves (WAVES, default 100,250,500,1000) start WAVE_GAP apart (default 2m). Each wave is a
// per-vu-iterations scenario (1 iteration per VU); all its VUs sleep until one shared
// instant (the rendezvous) and then send together.
//
// Run (repo root):
//   k6 run -e AUDIO_DIR=C:/Users/DELL/Downloads/10_cau_tieng_viet scripts/k6/audio-conversation-waves.js
//   k6 run -e WAVES=5 -e AUDIO_DIR=... scripts/k6/audio-conversation-waves.js   (smoke)
//
// Env:
//   BASE_URL      default https://api-dev.hoamytech.com (production refused unless ALLOW_PROD=1)
//   AUDIO_DIR     folder with <name>.mp3 for every clip in MIX_FILE (required)
//   MIX_FILE      clip names and lengths (default ./data/mobile-mix-10cau.json)
//   LANG_MIX      target languages and weights (default zh:1,ja:1,ko:1,fr:1; en:1 = English only)
//   WAVES / WAVE_GAP / WAVE_MAX   users per wave, time between wave starts, max wave length (90s)
//   TOKENS        installations registered in setup, shared round-robin (default 50)
//   UNIQUE=0      send byte-identical files (default 1: the last bytes differ per user, so
//                 no two uploads are the same and the server cannot merge them)
//   SUMMARY_FILE  write the full summary JSON here
//
// "Sent" is when the upload finished (k6 timings: response end - waiting - receiving).
// k6 does not stream bodies: the first audio byte is the GET's time to first byte, and
// "playable" (first 100 ms of sound) is interpolated over the download.

import http from "k6/http";
import { sleep, fail } from "k6";
import { SharedArray } from "k6/data";
import encoding from "k6/encoding";
import { Counter, Rate, Trend } from "k6/metrics";

const BASE_URL = (__ENV.BASE_URL || "https://api-dev.hoamytech.com").replace(/\/+$/, "");
const AUDIO_DIR = (__ENV.AUDIO_DIR || "").replace(/[\\/]+$/, "");
const MIX_FILE = __ENV.MIX_FILE || "./data/mobile-mix-10cau.json";
const TOKENS = Number(__ENV.TOKENS || 50);
const UNIQUE = __ENV.UNIQUE !== "0";
const CONVERSATION_TIMEOUT = "60s";
const AUDIO_TIMEOUT = "60s";
const RENDEZVOUS_LEAD_MS = 3000;
const WAV_HEADER_BYTES = 44;
const WAV_BYTES_PER_S = 48000; // 24 kHz mono 16-bit
const MP3_BYTES_PER_S = 4000; // Google / DeepInfra clips are ~32 kbps
const PLAYABLE_S = 0.1;
const LONG_CLIP_MS = 4000;

if (!AUDIO_DIR) fail("Set AUDIO_DIR to the folder with the .mp3 recordings");
const host = BASE_URL.replace(/^https?:\/\//i, "").split(/[/:]/)[0];
if (host === "api.hoamytech.com" && __ENV.ALLOW_PROD !== "1") fail("Refusing to load-test production.");

function seconds(text) {
  let total = 0;
  for (const [, amount, unit] of String(text).matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) {
    total += Number(amount) * { ms: 0.001, s: 1, m: 60, h: 3600 }[unit];
  }
  if (!(total > 0)) fail(`Cannot read a duration from "${text}"`);
  return total;
}

const WAVES = String(__ENV.WAVES || "100,250,500,1000").split(",").map(Number);
if (!WAVES.every(users => Number.isInteger(users) && users > 0)) fail(`WAVES "${__ENV.WAVES}"`);
// A wave is named and tagged by its user count, so two waves of one size would merge.
if (new Set(WAVES).size !== WAVES.length) fail(`WAVES "${__ENV.WAVES}" must all differ`);
const WAVE_GAP_S = seconds(__ENV.WAVE_GAP || "2m");
const WAVE_MAX_S = seconds(__ENV.WAVE_MAX || "90s");
if (WAVE_MAX_S + 15 > WAVE_GAP_S) fail("WAVE_MAX must end at least 15 s before the next wave");

const LANGS = String(__ENV.LANG_MIX || "zh:1,ja:1,ko:1,fr:1").split(",").map(part => {
  const [lang, weight] = part.trim().split(":");
  if (!["en", "zh", "ja", "ko", "fr"].includes(lang) || !(Number(weight) > 0)) fail(`LANG_MIX entry "${part}"`);
  return { lang, weight: Number(weight) };
});
const LANG_TOTAL = LANGS.reduce((sum, item) => sum + item.weight, 0);

// Base64 in a SharedArray: one copy for all VUs instead of ~0.5 MB of files per VU.
const clips = new SharedArray("recordings", () => JSON.parse(open(MIX_FILE)).map(clip => ({
  name: clip.name,
  durationMs: clip.utteranceDurationMs,
  audio: encoding.b64encode(open(`${AUDIO_DIR}/${clip.name}.mp3`, "b")),
})));

// Every metric is tagged wave (its user count), lang and len (short/long recording).
const uploadMs = new Trend("upload_ms", true);
const serverAsr = new Trend("server_asr_ms", true);
const serverLlm = new Trend("server_llm_ms", true);
const sendToText = new Trend("send_to_text_ms", true);
const audioTtfb = new Trend("audio_ttfb_ms", true);
const audioDownload = new Trend("audio_download_ms", true);
const sendToPlayable = new Trend("send_to_playable_ms", true);
const sendToAudioEnd = new Trend("send_to_audio_end_ms", true);
const rendezvousSpread = new Trend("rendezvous_late_ms", true);
const postOk = new Rate("post_ok");
const audioUrlReturned = new Rate("audio_url_returned");
const audioOk = new Rate("audio_ok");
const turnOk = new Rate("turn_ok");
const statusCounter = new Counter("http_status_by_step");

const TRENDS = ["upload_ms", "server_asr_ms", "server_llm_ms", "send_to_text_ms", "audio_ttfb_ms",
  "audio_download_ms", "send_to_playable_ms", "send_to_audio_end_ms", "rendezvous_late_ms"];
const RATES = ["post_ok", "audio_url_returned", "audio_ok", "turn_ok"];
const STATUSES = ["0", "200", "202", "400", "401", "403", "404", "408", "413", "422", "429", "500", "502", "503", "504"];

// Thresholds that always pass, only so the summary keeps every tagged sub-metric.
const thresholds = {};
for (const users of WAVES) {
  const tagSets = [`wave:${users}`, ...LANGS.map(({ lang }) => `wave:${users},lang:${lang}`),
    `wave:${users},len:short`, `wave:${users},len:long`];
  for (const tags of tagSets) {
    for (const name of TRENDS) thresholds[`${name}{${tags}}`] = ["max>=0"];
    for (const name of RATES) thresholds[`${name}{${tags}}`] = ["rate>=0"];
  }
  for (const step of ["conversation", "audio"]) {
    for (const status of STATUSES) thresholds[`http_status_by_step{wave:${users},step:${step},status:${status}}`] = ["count>=0"];
  }
}

const scenarios = {};
WAVES.forEach((users, index) => {
  scenarios[`wave_${users}`] = {
    executor: "per-vu-iterations", vus: users, iterations: 1, exec: "oneTurn",
    startTime: `${index * WAVE_GAP_S}s`, maxDuration: `${WAVE_MAX_S}s`, gracefulStop: "5s",
    env: { WAVE_USERS: String(users), WAVE_OFFSET_S: String(index * WAVE_GAP_S) },
  };
});

export const options = {
  setupTimeout: "10m",
  scenarios,
  thresholds,
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max", "count"],
};

function randomHex(length) {
  let out = "";
  while (out.length < length) out += Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
  return out.slice(0, length);
}

function registerInstallation() {
  const payload = JSON.stringify({ clientId: `web_k6_${randomHex(24)}`, platform: "web",
    installationSecret: randomHex(48), appVersion: "k6-audio-waves-1.0" });
  for (let attempt = 0; attempt < 15; attempt++) {
    const res = http.post(`${BASE_URL}/api/installations/register`, payload, {
      headers: { "Content-Type": "application/json" }, timeout: "20s" });
    if (res.status === 201) return { clientId: res.json("clientId"), accessToken: res.json("accessToken") };
    // 429: registration rate limit. 5xx: a brief database hiccup.
    if (res.status !== 429 && res.status < 500) fail(`register failed: HTTP ${res.status}`);
    sleep(res.status === 429 ? (Number(res.headers["Retry-After"]) || 10) + 1 : 3);
  }
  fail("register failed after retries");
}

export function setup() {
  const tokens = [];
  for (let i = 0; i < TOKENS; i++) tokens.push(registerInstallation());
  console.log(`audio waves -> ${BASE_URL} | waves=${WAVES.join(",")} gap=${WAVE_GAP_S}s | ` +
    `langs=${LANGS.map(l => `${l.lang}:${l.weight}`).join(",")} | clips=${clips.length} | tokens=${tokens.length} | unique=${UNIQUE}`);
  // Scenario start times count from the end of setup.
  return { tokens, startedAt: Date.now() };
}

function pickLang() {
  let roll = Math.random() * LANG_TOTAL;
  for (const item of LANGS) {
    roll -= item.weight;
    if (roll < 0) return item.lang;
  }
  return LANGS[LANGS.length - 1].lang;
}

function jsonField(res, path) {
  try { return res.json(path); } catch (_) { return undefined; }
}

/** This user's copy of the recording; with UNIQUE its last 4 bytes (MP3 padding) differ. */
function recording(clip) {
  const bytes = new Uint8Array(encoding.b64decode(clip.audio));
  if (UNIQUE && bytes.length > 8) {
    const mark = (__VU * 2654435761) >>> 0;
    for (let i = 0; i < 4; i++) bytes[bytes.length - 1 - i] = (mark >>> (8 * i)) & 0xff;
  }
  return bytes.buffer;
}

function clipSeconds(contentType, bytes) {
  if (/wav/i.test(contentType || "")) return Math.max(0, bytes - WAV_HEADER_BYTES) / WAV_BYTES_PER_S;
  return bytes / MP3_BYTES_PER_S;
}

export function oneTurn(data) {
  const users = __ENV.WAVE_USERS;
  const token = data.tokens[(__VU - 1) % data.tokens.length];
  const clip = clips[(__VU - 1) % clips.length];
  const lang = pickLang();
  const tags = { wave: users, lang, len: clip.durationMs >= LONG_CLIP_MS ? "long" : "short" };
  const audio = recording(clip);

  // Rendezvous: every user of this wave sends at the same instant.
  const sendAt = data.startedAt + Number(__ENV.WAVE_OFFSET_S) * 1000 + RENDEZVOUS_LEAD_MS;
  const waitS = (sendAt - Date.now()) / 1000;
  if (waitS > 0) sleep(waitS);
  rendezvousSpread.add(Math.max(0, Date.now() - sendAt), tags);

  const res = http.post(`${BASE_URL}/api/conversation`, {
    clientId: token.clientId,
    context: "home",
    childAge: "6",
    targetLanguage: lang,
    audio: http.file(audio, `${clip.name}.mp3`, "audio/mpeg"),
    benchmark: JSON.stringify({ device: "k6", utteranceDurationMs: clip.durationMs, requestedAsrMode: "batch_chunks" }),
  }, {
    headers: { Authorization: `Bearer ${token.accessToken}`, "X-Request-Id": `k6-waves-${randomHex(16)}` },
    timeout: CONVERSATION_TIMEOUT, tags: { name: "conversation" },
  });
  const responseAt = Date.now();
  statusCounter.add(1, { wave: users, step: "conversation", status: String(res.status) });
  const sentAt = responseAt - res.timings.waiting - res.timings.receiving;

  // English answers in englishText; zh/ja/ko/fr in translatedText.
  const translatedText = jsonField(res, lang === "en" ? "englishText" : "translatedText");
  const ok = res.status === 200 && Boolean(translatedText);
  postOk.add(ok, tags);
  if (!ok) {
    turnOk.add(false, tags);
    return;
  }
  uploadMs.add(res.timings.sending, tags);
  sendToText.add(responseAt - sentAt, tags);
  const asrMs = jsonField(res, "latency.asrMs");
  const llmMs = jsonField(res, "latency.llmMs");
  if (typeof asrMs === "number") serverAsr.add(asrMs, tags);
  if (typeof llmMs === "number") serverLlm.add(llmMs, tags);

  const audioUrl = jsonField(res, "audioUrl");
  audioUrlReturned.add(Boolean(audioUrl), tags);
  if (!audioUrl) {
    // The server could not make the voice (the app would use the phone's own TTS).
    turnOk.add(false, tags);
    return;
  }

  const url = /^https?:\/\//i.test(audioUrl) ? audioUrl : `${BASE_URL}${audioUrl}`;
  const audioStartedAt = Date.now();
  const speech = http.get(url, { timeout: AUDIO_TIMEOUT, responseType: "binary", tags: { name: "audio" } });
  const audioEndedAt = Date.now();
  statusCounter.add(1, { wave: users, step: "audio", status: String(speech.status) });
  const bytes = speech.body ? speech.body.byteLength : 0;
  const played = speech.status === 200 && bytes > WAV_HEADER_BYTES;
  audioOk.add(played, tags);
  turnOk.add(played, tags);
  if (!played) return;

  const receivingMs = speech.timings.receiving;
  const firstByteAt = audioEndedAt - receivingMs;
  const soundS = clipSeconds(speech.headers["Content-Type"], bytes);
  const playableAt = firstByteAt + receivingMs * (soundS > 0 ? Math.min(1, PLAYABLE_S / soundS) : 1);
  audioTtfb.add(firstByteAt - audioStartedAt, tags);
  audioDownload.add(receivingMs, tags);
  sendToPlayable.add(playableAt - sentAt, tags);
  sendToAudioEnd.add(Math.max(audioEndedAt, playableAt + soundS * 1000) - sentAt, tags);
}

function cell(metrics, name, tags) {
  const values = metrics[`${name}{${tags}}`]?.values;
  if (!values || !values.count) return "-";
  return `${Math.round(values.med)}/${Math.round(values["p(95)"])}/${Math.round(values.max)}`;
}

function rate(metrics, name, tags) {
  const values = metrics[`${name}{${tags}}`]?.values;
  const total = (values?.passes ?? 0) + (values?.fails ?? 0);
  return total ? `${(100 * values.rate).toFixed(1)}% of ${total}` : "-";
}

export function handleSummary(summary) {
  const metrics = summary.metrics;
  const lines = ["", "per wave (ms: med/p95/max)"];
  for (const users of WAVES) {
    const tags = `wave:${users}`;
    lines.push(`wave ${users}: post ok ${rate(metrics, "post_ok", tags)} | audioUrl ${rate(metrics, "audio_url_returned", tags)} | ` +
      `audio ok ${rate(metrics, "audio_ok", tags)} | turn ok ${rate(metrics, "turn_ok", tags)} | rendezvous late ${cell(metrics, "rendezvous_late_ms", tags)}`);
    lines.push(`  upload ${cell(metrics, "upload_ms", tags)} | asr ${cell(metrics, "server_asr_ms", tags)} | llm ${cell(metrics, "server_llm_ms", tags)} | ` +
      `text ${cell(metrics, "send_to_text_ms", tags)}`);
    lines.push(`  ttfb ${cell(metrics, "audio_ttfb_ms", tags)} | playable ${cell(metrics, "send_to_playable_ms", tags)} | ` +
      `audio end ${cell(metrics, "send_to_audio_end_ms", tags)}`);
    const statuses = Object.entries(metrics)
      .filter(([key, value]) => key.startsWith(`http_status_by_step{wave:${users},`) && value.values.count > 0)
      .map(([key, value]) => `${key.slice(key.indexOf("step:"), -1)}=${value.values.count}`);
    lines.push(`  HTTP ${statuses.join(" ")}`);
  }
  lines.push("");
  const out = { stdout: lines.join("\n") };
  if (__ENV.SUMMARY_FILE) out[__ENV.SUMMARY_FILE] = JSON.stringify(summary, null, 2);
  return out;
}
