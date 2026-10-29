import { AppError } from "../../appError";
import { getAbortDiagnostics, type AbortDiagnostics, type FailureSource } from "./abortDiagnostics";

const retryAfter = new WeakMap<AppError, number>();
export type FailureDiagnostics = { failureSource: FailureSource; abortCause?: AbortDiagnostics["abortCause"];
  upstreamStatus?: number; upstreamCodes?: number[] };
const diagnostics = new WeakMap<Error, FailureDiagnostics>();

export function attachFailureDiagnostics<T extends Error>(error: T, fields: FailureDiagnostics): T {
  diagnostics.set(error, fields);
  return error;
}

export function getFailureDiagnostics(error: unknown): FailureDiagnostics {
  if (error instanceof Error) {
    const known = diagnostics.get(error);
    if (known) return known;
  }
  if (error instanceof ProviderFault) {
    if (error.status !== undefined) return { failureSource: "cloudflare", upstreamStatus: error.status,
      upstreamCodes: [...error.codes].slice(0, 8) };
    return { failureSource: error.reason === "network_error" ? "network" : "unknown",
      ...(["cancelled", "timeout"].includes(error.reason) ? { abortCause: "unknown" as const } : {}) };
  }
  if (error instanceof PoolError && error.reason === "cancelled") return { failureSource: "unknown", abortCause: "unknown" };
  if (error instanceof AppError && typeof error.details?.upstreamStatus === "number") {
    return { failureSource: "cloudflare", upstreamStatus: error.details.upstreamStatus };
  }
  return { failureSource: "backend" };
}

export function getPoolRetryAfterMs(error: unknown): number | undefined {
  return error instanceof PoolError || error instanceof ProviderFault ? error.retryAfterMs
    : error instanceof AppError ? retryAfter.get(error) : undefined;
}

export type FaultReason = "rate_limited" | "credentials" | "provider_error" |
  "invalid_response" | "timeout" | "network_error" | "cancelled";

// Only structured, bounded metadata survives the provider boundary. Never retain
// response text, request URLs, exception messages or credentials on these errors.
export class ProviderFault extends Error {
  constructor(
    readonly reason: FaultReason,
    readonly status?: number,
    readonly retryAfterMs?: number,
    readonly codes: readonly number[] = [],
    fields?: FailureDiagnostics,
  ) {
    super(`Cloudflare provider failure: ${reason}`);
    this.name = "ProviderFault";
    if (fields) diagnostics.set(this, fields);
  }
}

export class PoolError extends Error {
  constructor(
    readonly reason: "configuration" | "store_unavailable" | "capacity" |
      "attempt_budget" | "timeout" | "cancelled" | "queue_full" | "queue_timeout",
    readonly status = 503,
    readonly retryAfterMs?: number,
    fields?: FailureDiagnostics,
  ) {
    super(`Cloudflare pool unavailable: ${reason}`);
    this.name = "PoolError";
    if (fields) diagnostics.set(this, fields);
  }
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value?.trim()) return undefined;
  const input = value.trim();
  const numeric = /^\d+(?:\.\d+)?$/.test(input) ? Number(input) * 1000 : NaN;
  const date = /[a-z]/i.test(input) ? Date.parse(input) - now : NaN;
  const delay = Number.isFinite(numeric) ? numeric : date;
  return Number.isFinite(delay) && delay >= 0 ? Math.min(60_000, Math.ceil(delay)) : undefined;
}

export function providerFaultFromResponse(response: Response, payload?: unknown): ProviderFault {
  const errors = payload && typeof payload === "object" && "errors" in payload
    ? payload.errors : undefined;
  const codes = Array.isArray(errors) ? errors.slice(0, 8).flatMap((entry: unknown) => {
    if (!entry || typeof entry !== "object" || !("code" in entry)) return [];
    return typeof entry.code === "number" && Number.isSafeInteger(entry.code) ? [entry.code] : [];
  }) : [];
  const reason = response.status === 429 ? "rate_limited"
    : response.status === 401 || response.status === 403 ? "credentials"
    : response.ok ? "invalid_response" : "provider_error";
  return new ProviderFault(reason, response.status, parseRetryAfter(response.headers.get("Retry-After")), codes);
}

export function networkFault(error: unknown, signal: AbortSignal, upstreamStatus?: number): ProviderFault {
  const name = error instanceof Error ? error.name : "";
  return new ProviderFault(signal.aborted
    ? signal.reason?.name === "TimeoutError" ? "timeout" : "cancelled"
    : name === "TimeoutError" ? "timeout" : name === "AbortError" ? "cancelled" : "network_error",
    undefined, undefined, [], {
      ...(signal.aborted ? getAbortDiagnostics(signal) : {
        failureSource: name === "AbortError" || name === "TimeoutError" ? "unknown" as const : "network" as const,
      }),
      ...(upstreamStatus !== undefined ? { upstreamStatus } : {}),
    });
}

export function isPoolFailure(error: unknown): error is PoolError | ProviderFault {
  return error instanceof PoolError || error instanceof ProviderFault;
}

function publicPoolMessage(fault: PoolError | ProviderFault, stage: "asr" | "text_translation" | "tts") {
  const { failureSource, abortCause, upstreamStatus } = getFailureDiagnostics(fault);
  const operation = stage === "text_translation" ? "dịch văn bản" : stage === "tts" ? "tạo giọng nói" : "nhận diện giọng nói";
  if ((fault.reason === "cancelled" || fault.reason === "timeout") && abortCause === "client_disconnect") {
    return "Yêu cầu đã bị hủy do kết nối từ phía gửi yêu cầu bị ngắt.";
  }
  switch (fault.reason) {
    case "cancelled":
      if (abortCause === "no_subscribers") return "Tác vụ dịch audio đã dừng vì không còn yêu cầu nào chờ kết quả.";
      if (abortCause === "shutdown") return "Máy chủ đã hủy yêu cầu khi dừng xử lý. Vui lòng thử lại sau.";
      return failureSource === "backend"
        ? "Máy chủ đã hủy yêu cầu dịch audio trước khi hoàn tất."
        : "Yêu cầu dịch audio đã bị hủy trước khi hoàn tất.";
    case "timeout":
      if (failureSource === "backend" && abortCause === "attempt_timeout") {
        return `Đã hết thời gian chờ Cloudflare phản hồi ở bước ${operation}. Vui lòng thử lại.`;
      }
      return failureSource === "backend"
        ? "Máy chủ đã dừng yêu cầu dịch audio vì hết thời gian xử lý cho phép. Vui lòng thử lại."
        : "Yêu cầu xử lý audio đã hết thời gian chờ. Vui lòng thử lại.";
    case "configuration":
      return "Cấu hình dịch vụ xử lý audio trên máy chủ chưa hợp lệ. Vui lòng liên hệ quản trị viên.";
    case "store_unavailable":
      return "Máy chủ tạm thời không thể điều phối yêu cầu dịch audio. Vui lòng thử lại sau.";
    case "capacity":
    case "queue_full":
      return "Máy chủ đang xử lý quá nhiều yêu cầu dịch audio. Vui lòng thử lại sau.";
    case "queue_timeout":
      return "Yêu cầu đã chờ quá lâu trong hàng đợi xử lý audio. Vui lòng thử lại sau.";
    case "attempt_budget":
      return "Yêu cầu đã đạt giới hạn số lần xử lý AI cho phép. Vui lòng thử lại sau.";
    case "rate_limited":
      return "Cloudflare đang giới hạn số lượng yêu cầu AI. Vui lòng thử lại sau.";
    case "credentials":
      return "Cloudflare từ chối xác thực hoặc quyền truy cập dịch vụ AI. Vui lòng liên hệ quản trị viên.";
    case "network_error":
      return "Không thể hoàn tất kết nối tới Cloudflare. Vui lòng thử lại.";
    case "invalid_response":
      return `Cloudflare trả về dữ liệu không hợp lệ ở bước ${operation}. Vui lòng thử lại.`;
    case "provider_error": {
      const http = Number.isInteger(upstreamStatus) && upstreamStatus! >= 100 && upstreamStatus! <= 599
        ? ` HTTP ${upstreamStatus}` : "";
      return `Cloudflare trả về lỗi${http} ở bước ${operation}. Vui lòng thử lại sau.`;
    }
  }
}

export function publicPoolError(error: unknown, stage: "asr" | "text_translation" | "tts" = "asr") {
  const fault = isPoolFailure(error) ? error : new PoolError("store_unavailable");
  const status = fault instanceof PoolError ? fault.status
    : fault.reason === "timeout" ? 504 : fault.reason === "cancelled" ? 499
    : fault.reason === "rate_limited" ? 429 : fault.reason === "credentials" ? 503 : 502;
  const projected = new AppError(stage === "asr" ? "ASR_FAILED" : stage === "tts" ? "TTS_FAILED" : "LLM_FAILED",
    isPoolFailure(error) ? publicPoolMessage(fault, stage)
      : "Máy chủ gặp lỗi khi xử lý audio. Vui lòng thử lại sau.",
    status, { provider: "cloudflare", stage, reason: fault.reason });
  const delay = fault.retryAfterMs ?? (status === 429 ? 1_000 : undefined);
  if (delay !== undefined) retryAfter.set(projected, delay);
  diagnostics.set(projected, getFailureDiagnostics(fault));
  return projected;
}
