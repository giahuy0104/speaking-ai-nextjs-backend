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
type InstallationAuthGlobal = typeof globalThis & {
  __homiInstallationRecords?: Map<string, InstallationRecord>;
  __homiInstallationRateLimits?: Map<string, RateLimitBucket>;
};
const authGlobal = globalThis as InstallationAuthGlobal;

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
    required: enabled("INSTALLATION_AUTH_REQUIRED"),
    accessTtlSeconds: positiveInteger("INSTALLATION_ACCESS_TTL_SECONDS", 3600),
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
      refreshSessionId: randomUUID(),
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
};

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
  const record = await readRecord(claims.clientId);
  if (
    !record ||
    record.tokenVersion !== claims.tokenVersion ||
    record.refreshSessionId !== claims.sessionId
  ) {
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
  };
}

export async function revokeInstallation(request: Request) {
  const access = await requireInstallationAccess(request);
  await removeRecord(access.clientId);
  return access;
}

export function createInstallationSecret() {
  return randomBytes(32).toString("base64url");
}
