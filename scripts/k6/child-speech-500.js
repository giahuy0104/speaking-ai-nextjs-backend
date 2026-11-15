// Load test: HuaMei Child Speech API (Whisper-tiny, Vietnamese STT) on Cloud Run.
// Usage:
//   k6 run -e STT_API_KEY=... -e AUDIO=/tmp/stt/sample.wav \
//     [-e TOTAL=500] [-e DURATION=2s] scripts/k6/child-speech-500.js
// TOTAL requests are spread evenly over DURATION (constant-arrival-rate).
import http from "k6/http";
import { check } from "k6";
import { Counter, Trend } from "k6/metrics";

const BASE_URL =
  __ENV.STT_URL ||
  "https://huamei-child-speech-api-415112188289.us-central1.run.app";
const API_KEY = __ENV.STT_API_KEY;
const TOTAL = Number(__ENV.TOTAL || 500);
const DURATION = __ENV.DURATION || "2s";
const DURATION_SEC = Number.parseInt(DURATION, 10);
const REQUEST_TIMEOUT = __ENV.TIMEOUT || "180s";

if (!API_KEY) {
  throw new Error("Missing STT_API_KEY env var");
}

const audioBytes = open(__ENV.AUDIO || "/tmp/stt/sample.wav", "b");

const statusCounter = new Counter("stt_status");
const okLatency = new Trend("stt_ok_latency", true);

export const options = {
  scenarios: {
    burst: {
      executor: "constant-arrival-rate",
      rate: TOTAL,
      timeUnit: `${DURATION_SEC}s`,
      duration: DURATION,
      preAllocatedVUs: TOTAL,
      maxVUs: TOTAL,
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
  },
  summaryTrendStats: ["min", "avg", "med", "p(90)", "p(95)", "p(99)", "max"],
};

export default function () {
  const res = http.post(
    `${BASE_URL}/transcribe`,
    { file: http.file(audioBytes, "sample.wav", "audio/wav") },
    { headers: { "x-api-key": API_KEY }, timeout: REQUEST_TIMEOUT },
  );

  statusCounter.add(1, { status: String(res.status) });
  const ok = check(res, {
    "status 200": (r) => r.status === 200,
    "has text": (r) => r.status === 200 && r.body && r.body.length > 2,
  });
  if (ok) okLatency.add(res.timings.duration);
}
