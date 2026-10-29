export type AudioJobProgress = { jobId: string; status: "queued" | "running" | "retrying"; statusUrl: string; nextPollMs: number };
export type AudioTranslationResponse = { targetLanguage: "en"; englishText: string; sourceText?: string; sourceLanguage?: string };

export class AudioTranslationClientError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
function failure(status: number, payload: { error?: { code?: string; message?: string } } | null) {
  return new AudioTranslationClientError(status, payload?.error?.code || "AUDIO_TRANSLATION_FAILED", payload?.error?.message || "Không thể hoàn tất bản dịch.");
}

/** Browser-safe helper. POST once; polling never resubmits the audio. Persist
 * onJob(jobId/statusUrl) in the app when polling must resume after a reload. */
export async function translateAudioWithJobs(input: {
  audio: File; accessToken: string; clientId?: string; sourceLanguage?: string; endpoint?: string;
  idempotencyKey?: string; signal?: AbortSignal; maxWaitMs?: number; onJob?: (job: AudioJobProgress) => void;
}): Promise<AudioTranslationResponse> {
  const endpoint = input.endpoint || "/api/audio/translate";
  const body = new FormData(); body.set("audio", input.audio); body.set("sourceLanguage", input.sourceLanguage || "vi");
  if (input.clientId) body.set("clientId", input.clientId);
  const signal = AbortSignal.any([AbortSignal.timeout(Math.max(1000, Math.min(900_000, input.maxWaitMs || 900_000))), ...(input.signal ? [input.signal] : [])]);
  const authorization = `Bearer ${input.accessToken}`;
  const response = await fetch(endpoint, { method: "POST", body, signal, redirect: "error", headers: {
    Authorization: authorization, Prefer: "respond-async", "Idempotency-Key": input.idempotencyKey || crypto.randomUUID(),
  } });
  const payload = await response.json().catch(() => null);
  if (response.status === 200 && typeof payload?.englishText === "string") return payload;
  if (response.status !== 202 || !/^[a-f0-9]{64}$/.test(payload?.jobId || "")) throw failure(response.status, payload);
  return waitForAudioTranslationJob({ ...input, jobId: payload.jobId, statusUrl: payload.statusUrl, nextPollMs: payload.nextPollMs, endpoint, signal });
}

/** Resume an accepted job without uploading audio again. */
export async function waitForAudioTranslationJob(input: {
  jobId: string; statusUrl?: string; nextPollMs?: number; accessToken: string; endpoint?: string;
  signal?: AbortSignal; maxWaitMs?: number; onJob?: (job: AudioJobProgress) => void;
}): Promise<AudioTranslationResponse> {
  if (!/^[a-f0-9]{64}$/.test(input.jobId)) throw failure(400, null);
  const base = new URL(input.endpoint || "/api/audio/translate", typeof location === "undefined" ? "http://localhost" : location.href);
  const statusUrl = new URL(input.statusUrl || `/api/audio/jobs/${input.jobId}`, base);
  if (statusUrl.origin !== base.origin || statusUrl.pathname !== `/api/audio/jobs/${input.jobId}` || statusUrl.search || statusUrl.hash) throw failure(502, null);
  const signal = AbortSignal.any([AbortSignal.timeout(Math.max(1000, Math.min(900_000, input.maxWaitMs || 900_000))), ...(input.signal ? [input.signal] : [])]);
  const authorization = `Bearer ${input.accessToken}`;
  let payload: { jobId: string; status: "queued" | "running" | "retrying"; nextPollMs: number } = { jobId: input.jobId, status: "queued", nextPollMs: input.nextPollMs || 2000 };
  let failures = 0;
  for (;;) {
    input.onJob?.({ jobId: payload.jobId, status: payload.status || "queued", statusUrl: statusUrl.href, nextPollMs: payload.nextPollMs || 2000 });
    await sleep(Math.max(250, Math.min(10_000, Number(payload.nextPollMs) || 2000)) + Math.floor(Math.random() * 150), signal);
    const polled = await fetch(statusUrl, { headers: { Authorization: authorization }, signal, redirect: "error", cache: "no-store" });
    const next = await polled.json().catch(() => null);
    if ([429, 503].includes(polled.status)) {
      const retryAfter = Number(polled.headers.get("Retry-After"));
      payload = { ...payload, nextPollMs: Math.min(10_000, Math.max(retryAfter * 1000 || 0, 1000 * 2 ** Math.min(failures++, 3))) };
      continue;
    }
    if (polled.status !== 200) throw failure(polled.status, next);
    failures = 0;
    if (next?.status === "completed" && typeof next.result?.englishText === "string") return next.result;
    if (next?.status === "failed") throw failure(200, next);
    if (!["queued", "running", "retrying"].includes(next?.status)) throw failure(502, null);
    payload = { ...next, jobId: payload.jobId };
  }
}
