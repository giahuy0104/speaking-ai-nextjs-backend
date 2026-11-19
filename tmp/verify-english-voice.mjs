// Two English turns on api-dev (k6-style installation: no history, no cache) and the voice each got.
import { randomBytes } from "node:crypto";
const BASE = "https://api-dev.hoamytech.com";
const hex = n => randomBytes(n).toString("hex");
const reg = await fetch(`${BASE}/api/installations/register`, { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ clientId: `web_k6_${hex(12)}`, platform: "web", installationSecret: hex(24), appVersion: "verify-english-voice" }) });
if (reg.status !== 201) throw new Error(`register ${reg.status}`);
const { clientId, accessToken } = await reg.json();
for (const sourceText of ["Hôm nay trời nắng đẹp",
  "Cuối tuần này gia đình tôi dự định đi biển để nghỉ ngơi và ngắm hoàng hôn."]) {
  const started = Date.now();
  const res = await fetch(`${BASE}/api/conversation`, { method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", "X-Request-Id": `verify-en-${hex(6)}` },
    body: JSON.stringify({ clientId, context: "home", targetLanguage: "en", childAge: 6, sourceText, asrMode: "android_streaming" }) });
  const body = await res.json();
  const audioStarted = Date.now();
  const audio = await fetch(new URL(body.audioUrl, BASE));
  const reader = audio.body.getReader();
  let first = null, bytes = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; if (first === null) first = Date.now() - audioStarted; bytes += value.byteLength; }
  console.log(JSON.stringify({ english: body.englishText, chars: body.englishText?.length, conversation: res.status,
    textMs: audioStarted - started, audio: audio.status, contentType: audio.headers.get("content-type"),
    source: audio.headers.get("x-audio-source"), firstByteMs: first, totalMs: Date.now() - audioStarted, bytes }));
}
