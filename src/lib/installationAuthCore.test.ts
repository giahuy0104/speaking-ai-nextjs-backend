import assert from "node:assert/strict";
import { test } from "node:test";
import { AppError } from "@/lib/appError";
import {
  issueInstallationToken,
  verifyInstallationToken,
} from "./installationAuthCore";

const secret = "installation-auth-test-secret-with-at-least-32-characters";

test("installation access token is signed and scoped to its kind", () => {
  const issued = issueInstallationToken(
    {
      kind: "access",
      clientId: "ios_12345678-test",
      platform: "ios",
      tokenVersion: 1,
      sessionId: "session-1",
    },
    secret,
    300,
  );

  const claims = verifyInstallationToken(issued.token, secret, "access");
  assert.equal(claims.clientId, "ios_12345678-test");
  assert.equal(claims.platform, "ios");
  assert.throws(
    () => verifyInstallationToken(issued.token, secret, "refresh"),
    (error: unknown) =>
      error instanceof AppError && error.code === "UNAUTHORIZED",
  );
});

test("installation token rejects tampering and expiry", () => {
  const issued = issueInstallationToken(
    {
      kind: "refresh",
      clientId: "android_12345678-test",
      platform: "android",
      tokenVersion: 2,
      sessionId: "session-2",
    },
    secret,
    -1,
  );
  assert.throws(
    () => verifyInstallationToken(issued.token, secret, "refresh"),
    (error: unknown) =>
      error instanceof AppError && error.code === "UNAUTHORIZED",
  );

  const valid = issueInstallationToken(
    {
      kind: "access",
      clientId: "web_12345678-test",
      platform: "web",
      tokenVersion: 1,
      sessionId: "session-3",
    },
    secret,
    300,
  ).token;
  const parts = valid.split(".");
  const tampered = `${parts[0]}.${parts[1]}x.${parts[2]}`;
  assert.throws(
    () => verifyInstallationToken(tampered, secret, "access"),
    (error: unknown) =>
      error instanceof AppError && error.code === "UNAUTHORIZED",
  );
});
