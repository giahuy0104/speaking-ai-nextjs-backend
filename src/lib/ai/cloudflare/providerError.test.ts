import assert from "node:assert/strict";
import test from "node:test";
import { getFailureDiagnostics, networkFault, parseRetryAfter, PoolError, ProviderFault, providerFaultFromResponse, publicPoolError } from "./providerError";
import { clientAbortSignal } from "./abortDiagnostics";

test("Retry-After handles delta seconds and HTTP date with bounded invalid values", () => {
  const now = Date.UTC(2026, 9, 26);
  assert.equal(parseRetryAfter("2", now), 2_000);
  assert.equal(parseRetryAfter(new Date(now + 3_000).toUTCString(), now), 3_000);
  assert.equal(parseRetryAfter("999999", now), 60_000);
  for (const value of [null, "", "-2", "NaN", "Infinity", "1e3", "garbage"]) assert.equal(parseRetryAfter(value, now), undefined);
  assert.equal(parseRetryAfter(new Date(now - 1_000).toUTCString(), now), undefined);
});

test("provider classification keeps unknown 4006 opaque and never retains body or credentials", () => {
  const fault = providerFaultFromResponse(new Response("secret-token account-id transcript", {
    status: 429, headers: { "Retry-After": "2" },
  }), { errors: [{ code: 4006, message: "secret-token" }] });
  assert.equal(fault.reason, "rate_limited");
  assert.deepEqual(fault.codes, [4006]);
  assert.equal(fault.retryAfterMs, 2000);
  const projected = publicPoolError(fault, "text_translation");
  assert.equal(projected.status, 429);
  assert.equal(projected.code, "LLM_FAILED");
  assert.match(projected.message, /Cloudflare.*giới hạn/);
  assert.doesNotMatch(JSON.stringify(projected), /secret-token|account-id|transcript|4006/);
  for (const status of [401, 403]) assert.equal(providerFaultFromResponse(new Response(null, { status })).reason, "credentials");
  assert.equal(providerFaultFromResponse(new Response(null, { status: 503 })).reason, "provider_error");
  assert.equal(providerFaultFromResponse(new Response(null, { status: 200 })).reason, "invalid_response");
});

test("network failures, timeout and client abort have distinct safe public projections", () => {
  assert.equal(networkFault(new Error("token-containing URL"), new AbortController().signal).reason, "network_error");
  const timeout = new AbortController(); timeout.abort(new DOMException("timeout", "TimeoutError"));
  assert.equal(networkFault(null, timeout.signal).reason, "timeout");
  const cancelled = new AbortController(); cancelled.abort();
  assert.equal(networkFault(null, cancelled.signal).reason, "cancelled");
  assert.equal(publicPoolError(new ProviderFault("timeout")).status, 504);
  const deadline = publicPoolError(new PoolError("timeout", 504, undefined,
    { failureSource: "backend", abortCause: "request_deadline" }));
  assert.match(deadline.message, /Máy chủ.*hết thời gian/);
  assert.doesNotMatch(deadline.message, /Cloudflare/);
  const attempt = publicPoolError(new PoolError("timeout", 504, undefined,
    { failureSource: "backend", abortCause: "attempt_timeout" }), "text_translation");
  assert.match(attempt.message, /hết thời gian chờ Cloudflare.*dịch văn bản/);
  assert.doesNotMatch(publicPoolError(networkFault(null, cancelled.signal)).message, /Cloudflare|không khả dụng/);
  assert.match(publicPoolError(new PoolError("queue_timeout", 429)).message, /hàng đợi/);
  assert.match(publicPoolError(new PoolError("capacity", 429)).message, /Máy chủ/);
  assert.equal(publicPoolError(new PoolError("configuration")).status, 503);
  assert.doesNotMatch(JSON.stringify(publicPoolError(new Error("secret-token"))), /secret-token/);
});

test("HTTP response diagnostics survive public projection without entering the API response", () => {
  const upstream = providerFaultFromResponse(new Response(null, { status: 503 }),
    { errors: [{ code: 1234, message: "private provider response" }] });
  const projected = publicPoolError(upstream, "text_translation");
  assert.deepEqual(getFailureDiagnostics(projected), { failureSource: "cloudflare", upstreamStatus: 503, upstreamCodes: [1234] });
  assert.equal(projected.details?.reason, "provider_error");
  assert.equal(projected.details?.failureSource, undefined);
  assert.equal(projected.details?.upstreamStatus, undefined);
  assert.match(projected.message, /Cloudflare.*HTTP 503.*dịch văn bản/);
  assert.doesNotMatch(JSON.stringify(projected), /private|1234/);
});

test("transport failures and untagged AbortError are not attributed to Cloudflare HTTP responses", () => {
  const open = new AbortController();
  assert.deepEqual(getFailureDiagnostics(networkFault(new Error("private token"), open.signal)), { failureSource: "network" });
  assert.equal(getFailureDiagnostics(networkFault(new DOMException("private", "AbortError"), open.signal)).failureSource, "unknown");
  const client = new AbortController(); clientAbortSignal(client.signal); client.abort();
  const error = publicPoolError(networkFault(null, client.signal));
  assert.match(error.message, /bị hủy.*ngắt/);
  assert.doesNotMatch(error.message, /Cloudflare|không khả dụng/);
  assert.deepEqual(getFailureDiagnostics(error), { failureSource: "client", abortCause: "client_disconnect" });
});
