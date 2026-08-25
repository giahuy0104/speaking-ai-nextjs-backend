import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "@/lib/appError";

export type InstallationPlatform = "ios" | "android" | "web";

export type InstallationTokenKind = "access" | "refresh";

export type InstallationTokenClaims = {
  version: 1;
  kind: InstallationTokenKind;
  clientId: string;
  platform: InstallationPlatform;
  tokenVersion: number;
  sessionId: string;
  issuedAt: number;
  expiresAt: number;
};

const tokenPrefix = "homi_install_v1";

function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function sign(payload: string, secret: string) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function unauthorized(message: string, status = 401): never {
  throw new AppError("UNAUTHORIZED", message, status);
}

export function issueInstallationToken(
  input: Omit<InstallationTokenClaims, "version" | "issuedAt" | "expiresAt">,
  secret: string,
  ttlSeconds: number,
) {
  const now = Math.floor(Date.now() / 1000);
  const claims: InstallationTokenClaims = {
    version: 1,
    ...input,
    issuedAt: now,
    expiresAt: now + ttlSeconds,
  };
  const payload = encode(claims);
  return {
    token: `${tokenPrefix}.${payload}.${sign(payload, secret)}`,
    claims,
  };
}

export function verifyInstallationToken(
  token: string,
  secret: string,
  expectedKind: InstallationTokenKind,
) {
  const [prefix = "", payload = "", suppliedSignature = "", extra] =
    token.split(".");
  if (
    prefix !== tokenPrefix ||
    !payload ||
    !suppliedSignature ||
    extra !== undefined
  ) {
    unauthorized("Phiên xác thực installation không hợp lệ.");
  }

  const expectedSignature = sign(payload, secret);
  const expectedBytes = Buffer.from(expectedSignature);
  const suppliedBytes = Buffer.from(suppliedSignature);
  if (
    expectedBytes.byteLength !== suppliedBytes.byteLength ||
    !timingSafeEqual(expectedBytes, suppliedBytes)
  ) {
    unauthorized("Chữ ký phiên xác thực installation không hợp lệ.");
  }

  let claims: InstallationTokenClaims;
  try {
    claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as InstallationTokenClaims;
  } catch {
    unauthorized("Nội dung phiên xác thực installation không hợp lệ.");
  }

  if (
    claims.version !== 1 ||
    claims.kind !== expectedKind ||
    !claims.clientId ||
    !claims.sessionId ||
    !Number.isInteger(claims.tokenVersion) ||
    claims.tokenVersion < 1
  ) {
    unauthorized("Phạm vi phiên xác thực installation không hợp lệ.");
  }
  if (
    !Number.isFinite(claims.expiresAt) ||
    claims.expiresAt <= Date.now() / 1000
  ) {
    unauthorized("Phiên xác thực installation đã hết hạn.");
  }
  return claims;
}

export function bearerToken(request: Request) {
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  return authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
}
