import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AppError } from "@/lib/appError";
import { isPostgresStorageEnabled } from "@/lib/db";
import {
  deleteRecord,
  getRecord,
  insertRecordIfAbsent,
  updateRecord,
} from "@/lib/db/records";
import {
  bearerToken,
  issueInstallationToken,
  type InstallationPlatform,
  verifyInstallationToken,
} from "@/lib/installationAuthCore";

const namespace = "installation_auth";
const clientIdPattern = /^(ios|android|web)_[A-Za-z0-9._:-]{8,180}$/;
const installationSecretPattern = /^[A-Za-z0-9_-]{32,180}$/;

export type InstallationRecord = {
  clientId: string;
  platform: InstallationPlatform;
  installationSecretHash: string;
  tokenVersion: number;
  refreshSessionId: string;
  appVersion?: string;
  createdAt: string;
  updatedAt: string;
};

type RateLimitBucket = { startedAt: number; count: number };
type CachedInstallation = { record: InstallationRecord; expiresAt: number };
type InstallationAuthGlobal = typeof globalThis & {
  __homiInstallationRecords?: Map<string, InstallationRecord>;
  __homiInstallationRateLimits?: Map<string, RateLimitBucket>;
  __homiInstallationAccessCache?: Map<string, CachedInstallation>;
};
const authGlobal = globalThis as InstallationAuthGlobal;

// Every authenticated request used to read the installation from the database.
// Under load that query failed first (Neon "fetch failed"), so a confirmed record is
// reused briefly. A token revoked or rotated on another backend instance may still
// be accepted until the entry expires; writes on this instance drop it at once.
const DEFAULT_ACCESS_CACHE_TTL_MS = 30_000;
// Bounds how long a revocation on another instance can be ignored, whatever is configured.
const MAX_ACCESS_CACHE_TTL_MS = 60_000;
const MAX_ACCESS_CACHE_ENTRIES = 10_000;
// Bumped on every installation write in this process. A storage read that overlapped
// a write (e.g. a refresh) is not cached, so it cannot re-insert the pre-write record.
let installationWriteGeneration = 0;

function accessCacheTtlMs() {
  const raw = process.env.INSTALLATION_ACCESS_CACHE_TTL_MS?.trim();
  if (!raw) return DEFAULT_ACCESS_CACHE_TTL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.min(MAX_ACCESS_CACHE_TTL_MS, Math.floor(parsed))
    : DEFAULT_ACCESS_CACHE_TTL_MS;
}

function accessCache() {
  return (authGlobal.__homiInstallationAccessCache ??= new Map());
}

function cachedInstallation(clientId: string) {
  const entry = accessCache().get(clientId);
  if (!entry) return null;
  if (entry.expiresAt > Date.now()) return entry.record;
  accessCache().delete(clientId);
  return null;
}

function rememberInstallation(record: InstallationRecord) {
  const ttlMs = accessCacheTtlMs();
  if (ttlMs === 0) return;
  const cache = accessCache();
  cache.delete(record.clientId);
  // Map keeps insertion order: drop the oldest entry to bound memory.
  if (cache.size >= MAX_ACCESS_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(record.clientId, { record: { ...record }, expiresAt: Date.now() + ttlMs });
}

function forgetInstallation(clientId: string) {
  installationWriteGeneration++;
  authGlobal.__homiInstallationAccessCache?.delete(clientId);
}

function recordMatchesToken(
  record: InstallationRecord | null,
  claims: { tokenVersion: number; sessionId: string },
): record is InstallationRecord {
  return Boolean(record && record.tokenVersion === claims.tokenVersion && record.refreshSessionId === claims.sessionId);
}

function enabled(name: string, fallback = false) {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function positiveInteger(name: string, fallback: number) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function getInstallationAuthConfig() {
  const configuredSecret = process.env.INSTALLATION_AUTH_SECRET?.trim() || "";
  const secret = configuredSecret.length >= 32 ? configuredSecret : null;
  return {
    secret,
    invalidSecret: Boolean(configuredSecret && !secret),
    // A legacy clientId is a development convenience, never a production credential.
    required: process.env.NODE_ENV === "production" || enabled("INSTALLATION_AUTH_REQUIRED"),
    accessTtlSeconds: positiveInteger("INSTALLATION_ACCESS_TTL_SECONDS", 900),
    refreshTtlSeconds: positiveInteger(
      "INSTALLATION_REFRESH_TTL_SECONDS",
      90 * 24 * 60 * 60,
    ),
    registrationRequestsPerMinute: positiveInteger(
      "INSTALLATION_REGISTRATION_REQUESTS_PER_MINUTE",
      12,
    ),
  };
}

function requireSecret() {
  const config = getInstallationAuthConfig();
  if (!config.secret) {
    throw new AppError(
      "AUTH_CONFIGURATION_ERROR",
      config.invalidSecret
        ? "INSTALLATION_AUTH_SECRET phải có tối thiểu 32 ký tự."
        : "Máy chủ chưa cấu hình xác thực installation.",
      503,
    );
  }
  return { ...config, secret: config.secret };
}

function hashSecret(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}

function requestClientKey(request: Request) {
  return (
    request.headers.get("cf-connecting-ip")?.trim() ||
    request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    "unknown"
  );
}

export function consumeInstallationRegistrationRateLimit(request: Request) {
  const limit = getInstallationAuthConfig().registrationRequestsPerMinute;
  const now = Date.now();
  const windowMs = 60_000;
  const key = requestClientKey(request);
  const buckets = (authGlobal.__homiInstallationRateLimits ??= new Map<
    string,
    RateLimitBucket
  >());
  const current = buckets.get(key);
  if (!current || now - current.startedAt >= windowMs) {
    buckets.set(key, { startedAt: now, count: 1 });
    return null;
  }
  current.count += 1;
  if (current.count <= limit) return null;
  return Math.max(1, Math.ceil((windowMs - (now - current.startedAt)) / 1000));
}

async function readRecord(clientId: string) {
  if (isPostgresStorageEnabled()) {
    return (
      (await getRecord<InstallationRecord>(namespace, clientId))?.value ?? null
    );
  }
  return (
    (authGlobal.__homiInstallationRecords ??= new Map()).get(clientId) ?? null
  );
}

async function createRecord(record: InstallationRecord) {
  forgetInstallation(record.clientId);
  if (isPostgresStorageEnabled()) {
    return insertRecordIfAbsent({
      namespace,
      key: record.clientId,
      clientId: record.clientId,
      createdAt: record.createdAt,
      value: record,
    });
  }
  const records = (authGlobal.__homiInstallationRecords ??= new Map());
  if (records.has(record.clientId)) return false;
  records.set(record.clientId, record);
  return true;
}

async function replaceRecord(
  clientId: string,
  mutate: (record: InstallationRecord) => InstallationRecord,
) {
  forgetInstallation(clientId);
  if (isPostgresStorageEnabled()) {
    return updateRecord<InstallationRecord>({
      namespace,
      key: clientId,
      clientId,
      mutate,
    });
  }
  const records = (authGlobal.__homiInstallationRecords ??= new Map());
  const current = records.get(clientId);
  if (!current) return null;
  const next = mutate(current);
  records.set(clientId, next);
  return next;
}

async function removeRecord(clientId: string) {
  forgetInstallation(clientId);
  if (isPostgresStorageEnabled()) {
    return deleteRecord(namespace, clientId, clientId);
  }
  return (authGlobal.__homiInstallationRecords ??= new Map()).delete(clientId);
}

function validateRegistration(input: unknown) {
  if (!input || typeof input !== "object") {
    throw new AppError("BAD_REQUEST", "Thông tin installation không hợp lệ.");
  }
  const body = input as Record<string, unknown>;
  const clientId =
    typeof body.clientId === "string" ? body.clientId.trim() : "";
  const platform = body.platform;
  const installationSecret =
    typeof body.installationSecret === "string"
      ? body.installationSecret.trim()
      : "";
  const appVersion =
    typeof body.appVersion === "string" && body.appVersion.trim()
      ? body.appVersion.trim().slice(0, 80)
      : undefined;
  if (!clientIdPattern.test(clientId)) {
    throw new AppError("BAD_REQUEST", "installationId không hợp lệ.");
  }
  if (platform !== "ios" && platform !== "android" && platform !== "web") {
    throw new AppError("BAD_REQUEST", "Nền tảng installation không hợp lệ.");
  }
  if (!clientId.startsWith(`${platform}_`)) {
    throw new AppError("BAD_REQUEST", "installationId không khớp nền tảng.");
  }
  if (!installationSecretPattern.test(installationSecret)) {
    throw new AppError("BAD_REQUEST", "Installation secret không hợp lệ.");
  }
  return {
    clientId,
    platform: platform as InstallationPlatform,
    installationSecret,
    appVersion,
  };
}

function issueTokens(record: InstallationRecord) {
  const config = requireSecret();
  const access = issueInstallationToken(
    {
      kind: "access",
      clientId: record.clientId,
      platform: record.platform,
      tokenVersion: record.tokenVersion,
      sessionId: record.refreshSessionId,
    },
    config.secret,
    config.accessTtlSeconds,
  );
  const refresh = issueInstallationToken(
    {
      kind: "refresh",
      clientId: record.clientId,
      platform: record.platform,
      tokenVersion: record.tokenVersion,
      sessionId: record.refreshSessionId,
    },
    config.secret,
    config.refreshTtlSeconds,
  );
  return {
    clientId: record.clientId,
    accessToken: access.token,
    accessTokenExpiresAt: new Date(
      access.claims.expiresAt * 1000,
    ).toISOString(),
    refreshToken: refresh.token,
    refreshTokenExpiresAt: new Date(
      refresh.claims.expiresAt * 1000,
    ).toISOString(),
  };
}

export async function registerInstallation(input: unknown) {
  requireSecret();
  const registration = validateRegistration(input);
  const existing = await readRecord(registration.clientId);
  const suppliedSecretHash = hashSecret(registration.installationSecret);
  const now = new Date().toISOString();

  if (existing) {
    if (existing.installationSecretHash !== suppliedSecretHash) {
      throw new AppError(
        "INSTALLATION_ALREADY_REGISTERED",
        "Installation này đã được đăng ký bằng credential khác.",
        409,
      );
    }
    const refreshed = await replaceRecord(existing.clientId, (current) => ({
      ...current,
      // Registering the same installation is idempotent. Browser tabs share the
      // device credential; registering one tab must not revoke every other tab.
      // Explicit refresh/revoke still rotates or removes the session below.
      appVersion: registration.appVersion ?? current.appVersion,
      updatedAt: now,
    }));
    if (!refreshed) {
      throw new AppError(
        "DEVICE_NOT_REGISTERED",
        "Không tìm thấy installation.",
        404,
      );
    }
    return issueTokens(refreshed);
  }

  const record: InstallationRecord = {
    clientId: registration.clientId,
    platform: registration.platform,
    installationSecretHash: suppliedSecretHash,
    tokenVersion: 1,
    refreshSessionId: randomUUID(),
    appVersion: registration.appVersion,
    createdAt: now,
    updatedAt: now,
  };
  if (!(await createRecord(record))) {
    // Two tabs can read a new identity before either insert commits. Re-read
    // the winner and accept only the exact same credential, never another owner.
    const winner = await readRecord(record.clientId);
    if (winner?.installationSecretHash === suppliedSecretHash) {
      return issueTokens(winner);
    }
    throw new AppError(
      "INSTALLATION_ALREADY_REGISTERED",
      "Installation vừa được đăng ký. Vui lòng thử lại.",
      409,
    );
  }
  return issueTokens(record);
}

export async function refreshInstallation(refreshToken: string) {
  const config = requireSecret();
  const claims = verifyInstallationToken(
    refreshToken,
    config.secret,
    "refresh",
  );
  const record = await readRecord(claims.clientId);
  if (
    !record ||
    record.tokenVersion !== claims.tokenVersion ||
    record.refreshSessionId !== claims.sessionId
  ) {
    throw new AppError("UNAUTHORIZED", "Refresh token đã bị thu hồi.", 401);
  }
  const now = new Date().toISOString();
  const rotated = await replaceRecord(record.clientId, (current) => {
    if (
      current.tokenVersion !== claims.tokenVersion ||
      current.refreshSessionId !== claims.sessionId
    ) {
      throw new AppError("UNAUTHORIZED", "Refresh token đã được sử dụng.", 401);
    }
    return { ...current, refreshSessionId: randomUUID(), updatedAt: now };
  });
  // A concurrent access check may have cached the pre-rotation record meanwhile.
  forgetInstallation(record.clientId);
  // With "token" verification the previous access token stays valid until it expires:
  // clients refresh ahead of expiry while requests carrying it are still in flight.
  // Only the refresh token is single-use; revoke refuses the session's access tokens.
  if (!rotated) {
    throw new AppError(
      "DEVICE_NOT_REGISTERED",
      "Không tìm thấy installation.",
      404,
    );
  }
  return issueTokens(rotated);
}

export type InstallationAccess = {
  clientId: string;
  platform?: InstallationPlatform;
  legacy: boolean;
  /**
   * How the access token was accepted: "token" = signature and expiry only (no storage
   * read), "cache"/"storage" = installation record confirmed in that place. Absent for legacy access.
   */
  lookup?: "token" | "cache" | "storage";
};

export type InstallationAccessVerification = "token" | "storage";

/**
 * "token" (default) accepts a validly signed, unexpired access token without reading
 * storage, so authentication adds no database round-trip to API calls. The cost: a
 * session refreshed or revoked through another backend instance keeps working there
 * until its access token expires (INSTALLATION_ACCESS_TTL_SECONDS). Refresh always
 * reads storage, so a revoked installation cannot obtain a new access token.
 * "storage" confirms every token against the installation record (cached briefly).
 */
export function getInstallationAccessVerification(): InstallationAccessVerification {
  return process.env.INSTALLATION_ACCESS_VERIFICATION?.trim().toLowerCase() === "storage"
    ? "storage"
    : "token";
}

type SessionClaims = { clientId: string; tokenVersion: number; sessionId: string };
type RevocationGlobal = typeof globalThis & { __homiRevokedInstallationSessions?: Map<string, number> };
const MAX_REVOKED_SESSIONS = 50_000;

function revokedSessions() {
  return ((globalThis as RevocationGlobal).__homiRevokedInstallationSessions ??= new Map());
}

function sessionKey(claims: SessionClaims) {
  return `${claims.clientId}\n${claims.tokenVersion}\n${claims.sessionId}`;
}

/**
 * Remembers, in this process, a session that was rotated or revoked here, so its
 * outstanding access tokens are refused at once instead of when they expire. An
 * entry is needed only until the last token of that session could expire.
 */
function rememberRevokedSession(claims: SessionClaims) {
  const now = Date.now();
  const sessions = revokedSessions();
  for (const [key, expiresAt] of sessions) {
    if (expiresAt > now && sessions.size < MAX_REVOKED_SESSIONS) break;
    sessions.delete(key);
  }
  sessions.set(sessionKey(claims), now + getInstallationAuthConfig().accessTtlSeconds * 1000);
}

function isRevokedSession(claims: SessionClaims) {
  const expiresAt = revokedSessions().get(sessionKey(claims));
  return expiresAt !== undefined && expiresAt > Date.now();
}

async function confirmInstallationRecord(claims: SessionClaims) {
  // A cached record that does not match (e.g. the session was refreshed through the
  // other backend) is re-read before rejecting, so valid tokens are never refused.
  let record = cachedInstallation(claims.clientId);
  const lookup: "cache" | "storage" = recordMatchesToken(record, claims) ? "cache" : "storage";
  if (lookup === "storage") {
    const generationBeforeRead = installationWriteGeneration;
    record = await readRecord(claims.clientId);
    if (!recordMatchesToken(record, claims)) accessCache().delete(claims.clientId);
    else if (generationBeforeRead === installationWriteGeneration) rememberInstallation(record);
  }
  return recordMatchesToken(record, claims) ? lookup : null;
}

export async function requireInstallationAccess(
  request: Request,
  claimedClientId?: string,
): Promise<InstallationAccess> {
  const config = getInstallationAuthConfig();
  const token = bearerToken(request);

  if (!token && !config.required) {
    const legacyClientId = claimedClientId?.trim();
    if (!legacyClientId || !clientIdPattern.test(legacyClientId)) {
      throw new AppError("UNAUTHORIZED", "Thiếu installation credential.", 401);
    }
    return { clientId: legacyClientId, legacy: true };
  }

  const secureConfig = requireSecret();
  if (!token) {
    throw new AppError("UNAUTHORIZED", "Thiếu installation access token.", 401);
  }
  const claims = verifyInstallationToken(token, secureConfig.secret, "access");
  const lookup = isRevokedSession(claims)
    ? null
    : getInstallationAccessVerification() === "token"
      ? "token"
      : await confirmInstallationRecord(claims);
  if (!lookup) {
    throw new AppError(
      "UNAUTHORIZED",
      "Installation access token đã bị thu hồi.",
      401,
    );
  }
  const normalizedClaim = claimedClientId?.trim();
  if (normalizedClaim && normalizedClaim !== claims.clientId) {
    throw new AppError(
      "FORBIDDEN",
      "Installation không có quyền truy cập dữ liệu này.",
      403,
    );
  }
  return {
    clientId: claims.clientId,
    platform: claims.platform,
    legacy: false,
    lookup,
  };
}

export async function revokeInstallation(request: Request) {
  const access = await requireInstallationAccess(request);
  const claims = verifyInstallationToken(bearerToken(request), requireSecret().secret, "access");
  await removeRecord(access.clientId);
  rememberRevokedSession(claims);
  forgetInstallation(access.clientId);
  return access;
}

export function createInstallationSecret() {
  return randomBytes(32).toString("base64url");
}
