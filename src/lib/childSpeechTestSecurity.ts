import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

type RateLimitBucket = {
  count: number;
  resetAt: number;
};

type ChildSpeechTestSecurityGlobal = typeof globalThis & {
  __childSpeechTestRateLimits?: Map<string, RateLimitBucket>;
};

const securityGlobal = globalThis as ChildSpeechTestSecurityGlobal;

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest();
}

function safeEquals(candidate: string, expected: string) {
  return timingSafeEqual(sha256(candidate), sha256(expected));
}

export function hasValidChildSpeechTestToken(request: Request) {
  const expected = process.env.CHILD_SPEECH_TEST_TOKEN?.trim() ?? "";
  if (!expected) return false;

  const authorization = request.headers.get("authorization")?.trim() ?? "";
  const [scheme, supplied, extra] = authorization.split(/\s+/);
  return (
    extra === undefined &&
    scheme?.toLowerCase() === "bearer" &&
    typeof supplied === "string" &&
    safeEquals(supplied, expected)
  );
}

function positiveInteger(name: string, fallback: number) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function requestFingerprint(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",", 1)[0];
  return forwarded?.trim() || request.headers.get("x-real-ip")?.trim() || "local";
}

export function consumeChildSpeechTestRateLimit(request: Request) {
  const now = Date.now();
  const windowMs = 60_000;
  const limit = positiveInteger(
    "CHILD_SPEECH_TEST_REQUESTS_PER_MINUTE",
    90,
  );
  const buckets = securityGlobal.__childSpeechTestRateLimits ??= new Map();
  if (buckets.size > 512) {
    for (const [bucketKey, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(bucketKey);
    }
  }
  const key = requestFingerprint(request);
  const existing = buckets.get(key);

  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return 0;
  }

  existing.count += 1;
  if (existing.count <= limit) return 0;
  return Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
}
