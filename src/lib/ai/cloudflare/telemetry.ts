export type TelemetrySink = (event: string, fields: Record<string, string | number | boolean>) => void;
const fields = new Set(["requestId", "parentRequestId", "workload", "stage", "accountAlias", "model", "attempt",
  "admissionWaitMs", "queueDepth", "providerElapsedMs", "remainingBudgetMs", "status", "safeReason", "upstreamCodes", "configVersion",
  "failureSource", "abortCause", "upstreamStatus"]);
const events = new Set(["cloudflare_pool_admission", "cloudflare_pool_attempt_completed",
  "cloudflare_pool_cooldown", "cloudflare_pool_unavailable", "cloudflare_pool_cleanup_failed",
  "cloudflare_pool_queued", "cloudflare_pool_request_admitted"]);

export function emitTelemetry(sink: TelemetrySink | undefined, event: string, input: Record<string, unknown>) {
  if (!events.has(event)) return;
  const safe: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!fields.has(key)) continue;
    if (key === "parentRequestId" && (typeof value !== "string" || !/^[a-zA-Z0-9._:-]{8,100}$/.test(value))) continue;
    if (typeof value === "string") safe[key] = value.slice(0, 150);
    else if (typeof value === "number" && Number.isFinite(value) || typeof value === "boolean") safe[key] = value;
  }
  try { sink?.(event, safe); } catch { /* Observability cannot change admission or provider results. */ }
}
