import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { AppError } from "../appError";
import { combineAbortSignals, timeoutSignal } from "./cloudflare/abortDiagnostics";

/**
 * Google Cloud Translation (v3, NMT model) as a provider for the text translation
 * step: AUDIO_TEXT_PROVIDER / AUDIO_TEXT_PROVIDER_EN may list "google", usually last,
 * as the fallback when the model providers are overloaded.
 *
 * NMT translates the sentence as it is: unlike the LLM providers it takes no
 * instruction (child-friendly wording, practice context), so it is a fallback.
 *
 * Credentials: GOOGLE_TRANSLATE_CREDENTIALS_JSON, else GOOGLE_TTS_CREDENTIALS_JSON
 * (service-account JSON, raw or base64), else the file in GOOGLE_APPLICATION_CREDENTIALS.
 * The service account needs the Cloud Translation API enabled and the role
 * "Cloud Translation API User". Project: GOOGLE_TRANSLATE_PROJECT_ID or the key's.
 */

export type GoogleTranslateReason =
  | "not_configured" | "unsupported_language" | "timeout" | "network_error"
  | "rate_limited" | "provider_error" | "invalid_response" | "empty_response";

export class GoogleTranslateProviderError extends Error {
  constructor(readonly reason: GoogleTranslateReason, readonly status?: number) {
    super(`Google Translate failed: ${reason}`);
    this.name = "GoogleTranslateProviderError";
  }
}

export const GOOGLE_TRANSLATE_MODEL = "google-translate-nmt";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/cloud-translation";
const TOKEN_LIFETIME_S = 3600;
// Renew a little early so a call never carries a token that expires in flight.
const TOKEN_RENEW_MARGIN_MS = 60_000;
// NMT answers a sentence in ~100-300 ms; keep room inside the 20 s turn.
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TRANSLATION_CHARS = 2_000;
const LANGUAGE_CODES: Readonly<Record<string, string>> = { en: "en", zh: "zh-CN", ja: "ja", ko: "ko", fr: "fr" };

type ServiceAccount = { clientEmail: string; privateKey: string; projectId: string };
type Transport = (url: string, init: RequestInit) => Promise<Response>;

// One token per process even if Next loads this module in several bundles.
const STATE_KEY = Symbol.for("homi.googleTranslate.state");
type State = { token?: { value: string; expiresAt: number }; pending?: Promise<string> };
const holder = globalThis as typeof globalThis & { [STATE_KEY]?: State };
const state = (): State => (holder[STATE_KEY] ??= {});
let transportOverride: Transport | undefined;

export function setGoogleTranslateTransportForTests(transport: Transport | undefined) {
  transportOverride = transport;
}

export function resetGoogleTranslateForTests() {
  delete holder[STATE_KEY];
}

const transport: Transport = (url, init) => (transportOverride ?? fetch)(url, init);

function timeoutMs() {
  const value = Number(process.env.GOOGLE_TRANSLATE_TIMEOUT_MS);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

function parseKey(raw: string): Record<string, unknown> {
  return JSON.parse(raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8")) as Record<string, unknown>;
}

function serviceAccount(): ServiceAccount {
  const raw = process.env.GOOGLE_TRANSLATE_CREDENTIALS_JSON?.trim() || process.env.GOOGLE_TTS_CREDENTIALS_JSON?.trim();
  const file = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  let json: Record<string, unknown>;
  try {
    if (raw) json = parseKey(raw);
    else if (file) json = parseKey(readFileSync(file, "utf8").trim());
    else throw new Error("missing");
  } catch {
    throw new GoogleTranslateProviderError("not_configured");
  }
  const projectId = process.env.GOOGLE_TRANSLATE_PROJECT_ID?.trim() || json.project_id;
  if (typeof json.client_email !== "string" || typeof json.private_key !== "string" ||
      typeof projectId !== "string" || !/^[a-z][a-z0-9-]{4,62}$/.test(projectId)) {
    throw new GoogleTranslateProviderError("not_configured");
  }
  return { clientEmail: json.client_email, privateKey: json.private_key, projectId };
}

const base64url = (value: string | Buffer) => Buffer.from(value).toString("base64url");

/** Service-account OAuth (JWT bearer grant), no client library needed. */
async function fetchToken(account: ServiceAccount, signal: AbortSignal): Promise<{ value: string; expiresAt: number }> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify({
    iss: account.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat: issuedAt, exp: issuedAt + TOKEN_LIFETIME_S,
  }))}`;
  let assertion: string;
  try {
    assertion = `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(account.privateKey).toString("base64url")}`;
  } catch {
    throw new GoogleTranslateProviderError("not_configured");
  }
  const response = await send(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    signal,
  });
  const body = await response.json().catch(() => null) as { access_token?: unknown; expires_in?: unknown } | null;
  if (typeof body?.access_token !== "string") throw new GoogleTranslateProviderError("invalid_response", response.status);
  const lifetimeS = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : TOKEN_LIFETIME_S;
  return { value: body.access_token, expiresAt: Date.now() + lifetimeS * 1000 };
}

async function accessToken(account: ServiceAccount, signal: AbortSignal) {
  const current = state();
  if (current.token && current.token.expiresAt - TOKEN_RENEW_MARGIN_MS > Date.now()) return current.token.value;
  current.pending ??= fetchToken(account, signal)
    .then(token => {
      current.token = token;
      return token.value;
    })
    .finally(() => {
      current.pending = undefined;
    });
  return current.pending;
}

/** One HTTP call; failures become provider errors (upstream bodies are never kept). */
async function send(url: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await transport(url, init);
  } catch {
    const signal = init.signal as AbortSignal | undefined;
    throw new GoogleTranslateProviderError(signal?.aborted ? "timeout" : "network_error");
  }
  if (response.ok) return response;
  await response.body?.cancel().catch(() => undefined);
  const status = response.status;
  if (status === 429) throw new GoogleTranslateProviderError("rate_limited", status);
  if (status === 401 || status === 403) throw new GoogleTranslateProviderError("not_configured", status);
  if (status === 400 || status === 404) throw new GoogleTranslateProviderError("invalid_response", status);
  throw new GoogleTranslateProviderError("provider_error", status);
}

/** Translates Vietnamese into `language` (en/zh/ja/ko/fr) with the NMT model. */
export async function translateWithGoogle(
  text: string,
  language: string,
  options: { signal?: AbortSignal } = {},
): Promise<{ translatedText: string; model: string }> {
  const target = LANGUAGE_CODES[language];
  if (!target) throw new GoogleTranslateProviderError("unsupported_language");
  const account = serviceAccount();
  const deadline = timeoutSignal(timeoutMs(), "attempt_timeout");
  const signal = options.signal ? combineAbortSignals([options.signal, deadline]) : deadline;
  const token = await accessToken(account, signal);
  const project = `projects/${account.projectId}/locations/global`;
  const response = await send(`https://translation.googleapis.com/v3/${project}:translateText`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [text],
      mimeType: "text/plain",
      sourceLanguageCode: "vi",
      targetLanguageCode: target,
      model: `${project}/models/general/nmt`,
    }),
    signal,
  });
  const body = await response.json().catch(() => null) as { translations?: Array<{ translatedText?: unknown }> } | null;
  const translated = body?.translations?.[0]?.translatedText;
  if (typeof translated !== "string") throw new GoogleTranslateProviderError("invalid_response", response.status);
  const translatedText = translated.trim();
  if (!translatedText) throw new GoogleTranslateProviderError("empty_response", response.status);
  if (translatedText.length > MAX_TRANSLATION_CHARS) throw new GoogleTranslateProviderError("invalid_response", response.status);
  return { translatedText, model: GOOGLE_TRANSLATE_MODEL };
}

function statusFor(error: GoogleTranslateProviderError) {
  switch (error.reason) {
    case "not_configured": return 503;
    case "timeout": return 504;
    case "rate_limited": return 429;
    case "unsupported_language": return 500;
    default: return 502;
  }
}

/**
 * The public error for a failed Google translation. Every provider fault is a 429
 * or a 5xx, so another provider in the list still gets a chance.
 */
export function toGoogleTranslateAppError(error: unknown) {
  if (!(error instanceof GoogleTranslateProviderError)) return error;
  return new AppError("LLM_FAILED", "Dịch vụ dịch tạm thời gặp lỗi. Vui lòng thử lại.", statusFor(error), {
    provider: "google",
    stage: "text_translation",
    reason: error.reason,
    ...(error.status !== undefined ? { upstreamStatus: error.status } : {}),
  });
}
