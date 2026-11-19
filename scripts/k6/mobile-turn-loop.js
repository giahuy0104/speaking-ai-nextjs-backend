// k6 closed-loop test that follows the Android app's request flow for one turn
// (see docs/load-test/mobile-1000-users-plan.md):
//
//   mic ready -> child speaks [en: POST /api/conversation/preview mid-speech]
//   -> endpoint silence -> POST /api/conversation (sourceText, android_streaming)
//   -> GET audioUrl (+ PATCH /api/history, + a second GET like the app's cache)
//   -> wait until the clip has finished playing -> next turn
//
// Android recognizes speech on the device, so the server gets text: each clip in
// MIX_FILE carries the transcript of one of the test recordings and its length.
//
// Run (repo root):
//   k6 run -e STAGES=10:2m scripts/k6/mobile-turn-loop.js
//   k6 run -e STAGES=100:5m,250:5m,500:5m,750:5m,1000:10m -e RAMP=2m scripts/k6/mobile-turn-loop.js
//
// Env:
//   BASE_URL            default https://api-dev.hoamytech.com (production refused unless ALLOW_PROD=1)
//   STAGES / RAMP       "users:hold,..." and the time between user counts (default 10:2m / 30s)
//   LANG_MIX            target languages and weights (default en:40,zh:15,ja:15,ko:15,fr:15)
//   MIX_FILE            default ./data/mobile-mix-10cau.json
//   TOKENS              installations registered in setup (default 50)
//   ENDPOINT_SILENCE_MS silence the app waits before closing the utterance (default 550)
//   PREVIEW=0           skip the en preview call
//   SECOND_AUDIO_GET=0  skip the app's second download of the clip
//   SUMMARY_FILE        write the full summary JSON here
//   TURNS_PER_MIN       pace each user to this many turns a minute, e.g. "8-12" (a fresh
//                       random rate each turn) or "10"; a turn that runs longer than its
//                       slot starts the next one at once. Unset: the next turn starts
//                       as soon as the clip has finished playing.
//   THINK               pause after each turn before the next, e.g. "1s-5s" (random in the
//                       range each turn) or "3s". Unset: no pause.
//
// k6 does not stream response bodies: the first audio byte is the response's
// time to first byte, and "playable" (first 100 ms of sound) is interpolated
// over the download, assuming bytes arrive evenly.

import http from "k6/http";
import { sleep, fail } from "k6";
import { SharedArray } from "k6/data";
import { Counter, Rate, Trend } from "k6/metrics";

const BASE_URL = (__ENV.BASE_URL || "https://api-dev.hoamytech.com").replace(/\/+$/, "");
const MIX_FILE = __ENV.MIX_FILE || "./data/mobile-mix-10cau.json";
const TOKENS = Number(__ENV.TOKENS || 50);
const ENDPOINT_SILENCE_S = Number(__ENV.ENDPOINT_SILENCE_MS || 550) / 1000;
const PREVIEW = __ENV.PREVIEW !== "0";
const SECOND_AUDIO_GET = __ENV.SECOND_AUDIO_GET !== "0";
const CONVERSATION_TIMEOUT = "20s";
const AUDIO_TIMEOUT = "30s";
const BUSY_RETRIES = 3;
const WAV_HEADER_BYTES = 44;
const WAV_BYTES_PER_S = 48000; // 24 kHz mono 16-bit
const MP3_BYTES_PER_S = 6000; // ~48 kbps
const PLAYABLE_S = 0.1;
const LONG_CLIP_MS = 4000;

const TURNS_PER_MIN = (() => {
  if (!__ENV.TURNS_PER_MIN) return null;
  const [low, high = low] = String(__ENV.TURNS_PER_MIN).split("-").map(Number);
  if (!(low > 0) || !(high >= low)) fail(`TURNS_PER_MIN "${__ENV.TURNS_PER_MIN}" must look like 10 or 8-12`);
  return { low, high };
})();

function seconds(text) {
  let total = 0;
  for (const [, amount, unit] of String(text).matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) {
    total += Number(amount) * { ms: 0.001, s: 1, m: 60, h: 3600 }[unit];
  }
  if (!(total > 0)) fail(`Cannot read a duration from "${text}"`);
  return total;
}

const STAGES = String(__ENV.STAGES || "10:2m").split(",").map(part => {
  const [users, hold] = part.trim().split(":");
  if (!(Number(users) > 0) || !hold) fail(`STAGES entry "${part}" must look like 100:5m`);
  return { users: Number(users), holdS: seconds(hold) };
});
const RAMP_S = seconds(__ENV.RAMP || "30s");

const LANGS = String(__ENV.LANG_MIX || "en:40,zh:15,ja:15,ko:15,fr:15").split(",").map(part => {
  const [lang, weight] = part.trim().split(":");
  if (!["en", "zh", "ja", "ko", "fr"].includes(lang) || !(Number(weight) > 0)) fail(`LANG_MIX entry "${part}"`);
  return { lang, weight: Number(weight) };
});
const LANG_TOTAL = LANGS.reduce((sum, item) => sum + item.weight, 0);

const host = BASE_URL.replace(/^https?:\/\//i, "").split(/[/:]/)[0];
if (host === "api.hoamytech.com" && __ENV.ALLOW_PROD !== "1") fail("Refusing to load-test production.");

const mix = new SharedArray("mobile mix", () => {
  const clips = JSON.parse(open(MIX_FILE));
  if (!Array.isArray(clips) || !clips.length) throw new Error(`No clips in ${MIX_FILE}`);
  return clips;
});

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
function stageLabel(startedAt) {
  const elapsedS = (Date.now() - startedAt) / 1000;
  for (const window of TIMELINE) if (elapsedS >= window.from && elapsedS < window.to) return window.label;
  return "end";
}

// Milliseconds from "the child stopped speaking" (voice end).
const voiceEndToText = new Trend("voice_end_to_text_ms", true);
const voiceEndToFirstAudioByte = new Trend("voice_end_to_first_audio_byte_ms", true);
const voiceEndToPlayable = new Trend("voice_end_to_playable_ms", true);
const voiceEndToAudioEnd = new Trend("voice_end_to_audio_end_ms", true);
// Voice synthesized but no URL returned (zh/ja/ko/fr for k6 installations while the
// dev audio-cache bypass is on): the speech exists when the response arrives.
const voiceEndToSpeechReadyNoUrl = new Trend("voice_end_to_speech_ready_no_url_ms", true);
const conversationMs = new Trend("conversation_ms", true);
const audioTtfb = new Trend("audio_ttfb_ms", true);
const audioDownload = new Trend("audio_download_ms", true);
const audioBytes = new Trend("audio_bytes");
const turnOk = new Rate("turn_ok");
const noAudioUrl = new Rate("turn_no_audio_url");
const audioFailed = new Rate("audio_failed");
const statusCounter = new Counter("http_status_by_step");
// The server returns 200 even when it could not make the voice (audioSource
// "device_tts": the app falls back to the phone's own TTS).
const speechMade = new Rate("speech_made");
const serverLlm = new Trend("server_llm_ms", true);
const serverTts = new Trend("server_tts_ms", true);

const TREND_NAMES = ["voice_end_to_text_ms", "voice_end_to_first_audio_byte_ms", "voice_end_to_playable_ms",
  "voice_end_to_audio_end_ms", "voice_end_to_speech_ready_no_url_ms", "conversation_ms", "audio_ttfb_ms", "audio_download_ms",
  "server_llm_ms", "server_tts_ms"];
const thresholds = {};
const stageTags = STAGES.map(stage => String(stage.users));
for (const users of stageTags) {
  for (const name of TREND_NAMES) {
    thresholds[`${name}{users:${users}}`] = ["max>=0"];
    for (const { lang } of LANGS) thresholds[`${name}{users:${users},lang:${lang}}`] = ["max>=0"];
  }
  thresholds[`turn_ok{users:${users}}`] = ["rate>=0"];
  thresholds[`speech_made{users:${users}}`] = ["rate>=0"];
  thresholds[`turn_no_audio_url{users:${users}}`] = ["rate>=0"];
  thresholds[`audio_failed{users:${users}}`] = ["rate>=0"];
  for (const { lang } of LANGS) thresholds[`turn_ok{users:${users},lang:${lang}}`] = ["rate>=0"];
}
for (const step of ["conversation", "audio", "preview"]) {
  for (const status of ["0", "200", "206", "307", "401", "403", "404", "413", "422", "429", "500", "502", "503", "504"]) {
    thresholds[`http_status_by_step{step:${step},status:${status}}`] = ["count>=0"];
  }
}

export const options = {
  setupTimeout: "20m",
  scenarios: {
    users: {
      executor: "ramping-vus", startVUs: 0, exec: "userLoop", gracefulRampDown: "30s", gracefulStop: "40s",
      stages: STAGES.flatMap(stage => [
        { duration: `${RAMP_S}s`, target: stage.users },
        { duration: `${stage.holdS}s`, target: stage.users },
      ]),
    },
  },
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
    installationSecret: randomHex(48), appVersion: "k6-mobile-flow-1.0" });
  for (let attempt = 0; attempt < 15; attempt++) {
    const res = http.post(`${BASE_URL}/api/installations/register`, payload, {
      headers: { "Content-Type": "application/json" }, timeout: "20s" });
    if (res.status === 201) return { clientId: res.json("clientId"), accessToken: res.json("accessToken") };
    // 429: registration rate limit. 5xx: a brief database hiccup (seen with Neon).
    if (res.status !== 429 && res.status < 500) fail(`register failed: HTTP ${res.status}`);
    sleep(res.status === 429 ? (Number(res.headers["Retry-After"]) || 10) + 1 : 3);
  }
  fail("register failed after retries");
}

export function setup() {
  const tokens = [];
  for (let i = 0; i < TOKENS; i++) tokens.push(registerInstallation());
  console.log(`mobile flow -> ${BASE_URL} | stages=${STAGES.map(s => `${s.users}x${s.holdS}s`).join(",")} ramp=${RAMP_S}s | ` +
    `langs=${LANGS.map(l => `${l.lang}:${l.weight}`).join(",")} | clips=${mix.length} | tokens=${tokens.length}`);
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

function absolute(url) {
  return /^https?:\/\//i.test(url) ? url : `${BASE_URL}${url}`;
}

/** Seconds of sound in a downloaded clip. */
function clipSeconds(contentType, bytes) {
  if (/wav/i.test(contentType || "")) return Math.max(0, bytes - WAV_HEADER_BYTES) / WAV_BYTES_PER_S;
  return bytes / MP3_BYTES_PER_S;
}

const THINK = (() => {
  if (!__ENV.THINK) return null;
  const [low, high = low] = String(__ENV.THINK).split("-").map(seconds);
  if (!(high >= low)) fail(`THINK "${__ENV.THINK}" must look like 3s or 1s-5s`);
  return { low, high };
})();

function think() {
  if (THINK) sleep(THINK.low + Math.random() * (THINK.high - THINK.low));
}

export function userLoop(data) {
  if (!TURNS_PER_MIN) {
    runTurn(data);
    think();
    return;
  }
  const rate = TURNS_PER_MIN.low + Math.random() * (TURNS_PER_MIN.high - TURNS_PER_MIN.low);
  const slotEndsAt = Date.now() + 60000 / rate;
  runTurn(data);
  const leftS = (slotEndsAt - Date.now()) / 1000;
  if (leftS > 0) sleep(leftS);
  think();
}

function runTurn(data) {
  const token = data.tokens[(__VU - 1) % data.tokens.length];
  const clip = mix[Math.floor(Math.random() * mix.length)];
  const lang = pickLang();
  const users = stageLabel(data.startedAt);
  const tags = { users, lang, len: clip.utteranceDurationMs >= LONG_CLIP_MS ? "long" : "short" };
  const auth = { Authorization: `Bearer ${token.accessToken}`, "Content-Type": "application/json" };
  const speechS = clip.utteranceDurationMs / 1000;

  sleep(0.5 + Math.random() * 0.5); // mic becomes ready

  if (lang === "en" && PREVIEW) {
    // A partial transcript mid-speech; the app does not wait for the answer.
    sleep(speechS * 0.6);
    const words = clip.sourceText.split(/\s+/);
    http.asyncRequest("POST", `${BASE_URL}/api/conversation/preview`, JSON.stringify({
      clientId: token.clientId, context: "home", childAge: 6,
      sourceText: words.slice(0, Math.max(2, Math.ceil(words.length * 0.6))).join(" "),
    }), { headers: auth, timeout: "4s", tags: { name: "preview" } })
      .then(res => statusCounter.add(1, { step: "preview", status: String(res.status) }));
    sleep(speechS * 0.4);
  } else {
    sleep(speechS);
  }

  const voiceEndAt = Date.now();
  sleep(ENDPOINT_SILENCE_S);

  const body = JSON.stringify({
    clientId: token.clientId, context: "home", targetLanguage: lang, childAge: 6,
    sourceText: clip.sourceText, asrMode: "android_streaming",
    benchmark: { device: "mobile", utteranceDurationMs: clip.utteranceDurationMs,
      vadSilenceMs: Math.round(ENDPOINT_SILENCE_S * 1000), requestedAsrMode: "android_streaming" },
  });
  let res;
  for (let attempt = 0; ; attempt++) {
    res = http.post(`${BASE_URL}/api/conversation`, body, {
      headers: { ...auth, "X-Request-Id": `k6-mobile-${randomHex(16)}` },
      timeout: CONVERSATION_TIMEOUT, tags: { name: "conversation" } });
    statusCounter.add(1, { step: "conversation", status: String(res.status) });
    if (res.status !== 429 || attempt >= BUSY_RETRIES) break;
    sleep(0.25 * 2 ** attempt);
  }
  const responseAt = Date.now();
  conversationMs.add(res.timings.duration, tags);

  const text = lang === "en" ? jsonField(res, "englishText") : jsonField(res, "translatedText");
  if (res.status !== 200 || !text) {
    turnOk.add(false, tags);
    sleep(1);
    return;
  }
  voiceEndToText.add(responseAt - voiceEndAt, tags);
  const audioSource = jsonField(res, "audioSource");
  const made = audioSource !== "device_tts";
  speechMade.add(made, tags);
  const llmMs = jsonField(res, "latency.llmMs");
  const ttsMs = jsonField(res, "latency.ttsMs");
  if (typeof llmMs === "number") serverLlm.add(llmMs, tags);
  if (made && typeof ttsMs === "number") serverTts.add(ttsMs, tags);

  const audioUrl = jsonField(res, "audioUrl");
  noAudioUrl.add(!audioUrl, tags);
  if (!audioUrl) {
    // The server synthesized the speech but returned no URL: count it as ready,
    // and wait a typical clip length as if the app spoke it with device TTS.
    if (made) voiceEndToSpeechReadyNoUrl.add(responseAt - voiceEndAt, tags);
    turnOk.add(true, tags);
    sleep(Math.min(6, 1 + text.length / 15));
    return;
  }

  const conversationId = jsonField(res, "conversationId");
  const url = absolute(audioUrl);
  const audioStartedAt = Date.now();
  const audio = http.get(url, { timeout: AUDIO_TIMEOUT, responseType: "binary", tags: { name: "audio" } });
  const audioEndedAt = Date.now();
  statusCounter.add(1, { step: "audio", status: String(audio.status) });
  const bytes = audio.body ? audio.body.byteLength : 0;
  if (audio.status !== 200 || bytes <= WAV_HEADER_BYTES) {
    audioFailed.add(true, tags);
    turnOk.add(false, tags);
    sleep(1);
    return;
  }
  audioFailed.add(false, tags);
  turnOk.add(true, tags);

  // Across redirects (307 to the cache) the final response's receiving time is
  // the download; everything before it is waiting for the first byte.
  const receivingMs = audio.timings.receiving;
  const firstByteAt = audioEndedAt - receivingMs;
  const contentType = audio.headers["Content-Type"] || "";
  const soundS = clipSeconds(contentType, bytes);
  const playableFraction = soundS > 0 ? Math.min(1, PLAYABLE_S / soundS) : 1;
  const playableAt = firstByteAt + receivingMs * playableFraction;

  audioTtfb.add(firstByteAt - audioStartedAt, tags);
  audioDownload.add(receivingMs, tags);
  audioBytes.add(bytes, tags);
  voiceEndToFirstAudioByte.add(firstByteAt - voiceEndAt, tags);
  voiceEndToPlayable.add(playableAt - voiceEndAt, tags);
  voiceEndToAudioEnd.add(Math.max(audioEndedAt, playableAt + soundS * 1000) - voiceEndAt, tags);

  // Fire-and-forget calls the app makes once playback starts.
  if (conversationId) {
    http.asyncRequest("PATCH", `${BASE_URL}/api/history`, JSON.stringify({
      clientId: token.clientId, conversationId,
      latency: { timeToFirstAudioMs: Math.round(playableAt - voiceEndAt) },
    }), { headers: auth, timeout: "10s", tags: { name: "history" } });
  }
  if (SECOND_AUDIO_GET) {
    http.asyncRequest("GET", url, null, { timeout: AUDIO_TIMEOUT, responseType: "none", tags: { name: "audio_cache" } });
  }

  // The next turn starts when the clip has finished playing.
  const playbackLeftS = (playableAt + soundS * 1000 - Date.now()) / 1000;
  if (playbackLeftS > 0) sleep(playbackLeftS);
}

function row(metrics, name, tag) {
  const values = metrics[`${name}{${tag}}`]?.values;
  if (!values || !values.count) return "-";
  return `${Math.round(values.med)}/${Math.round(values["p(95)"])}/${Math.round(values.max)} (n=${values.count})`;
}

export function handleSummary(summary) {
  const metrics = summary.metrics;
  const lines = ["", "voice end -> playable audio (ms, med/p95/max), by user count and language"];
  for (const users of stageTags) {
    const ok = metrics[`turn_ok{users:${users}}`]?.values;
    const noUrl = metrics[`turn_no_audio_url{users:${users}}`]?.values;
    const made = metrics[`speech_made{users:${users}}`]?.values;
    lines.push(`users ${users}: ok ${(100 * (ok?.rate ?? 0)).toFixed(1)}% of ${(ok?.passes ?? 0) + (ok?.fails ?? 0)} | ` +
      `voice made by server ${(100 * (made?.rate ?? 0)).toFixed(1)}% | no audio URL ${(100 * (noUrl?.rate ?? 0)).toFixed(1)}%`);
    lines.push(`  server llm ${row(metrics, "server_llm_ms", `users:${users}`)} | server tts (when made) ${row(metrics, "server_tts_ms", `users:${users}`)}`);
    lines.push(`  all   playable ${row(metrics, "voice_end_to_playable_ms", `users:${users}`)} | text ${row(metrics, "voice_end_to_text_ms", `users:${users}`)}`);
    for (const { lang } of LANGS) {
      const tag = `users:${users},lang:${lang}`;
      lines.push(`  ${lang}    playable ${row(metrics, "voice_end_to_playable_ms", tag)} | text ${row(metrics, "voice_end_to_text_ms", tag)} | ` +
        `ready(no URL) ${row(metrics, "voice_end_to_speech_ready_no_url_ms", tag)} | conv ${row(metrics, "conversation_ms", tag)} | ttfb ${row(metrics, "audio_ttfb_ms", tag)}`);
    }
  }
  const statuses = Object.entries(metrics)
    .filter(([key, value]) => key.startsWith("http_status_by_step{") && value.values.count > 0)
    .map(([key, value]) => `${key.slice("http_status_by_step".length)}=${value.values.count}`);
  lines.push(`HTTP status: ${statuses.join(" ")}`, "");
  const out = { stdout: lines.join("\n") };
  if (__ENV.SUMMARY_FILE) out[__ENV.SUMMARY_FILE] = JSON.stringify(summary, null, 2);
  return out;
}
