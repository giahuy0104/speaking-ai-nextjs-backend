import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  getChildDataPolicy,
  getDiagnosticRetentionDays,
  getHistoryRetentionDays,
  getUserAudioRetentionDays,
} from "./dataPolicy";

const retentionVariables = [
  "USER_AUDIO_RETENTION_DAYS",
  "HISTORY_RETENTION_DAYS",
  "DIAGNOSTIC_RETENTION_DAYS",
  "CHILD_DATA_RETENTION_DAYS",
] as const;
const originalValues = Object.fromEntries(
  retentionVariables.map((name) => [name, process.env[name]]),
);

afterEach(() => {
  for (const name of retentionVariables) {
    const original = originalValues[name];
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
});

test("reads the three data-specific retention periods", () => {
  process.env.USER_AUDIO_RETENTION_DAYS = "30";
  process.env.HISTORY_RETENTION_DAYS = "180";
  process.env.DIAGNOSTIC_RETENTION_DAYS = "30";

  assert.equal(getUserAudioRetentionDays(), 30);
  assert.equal(getHistoryRetentionDays(), 180);
  assert.equal(getDiagnosticRetentionDays(), 30);
  assert.deepEqual(
    {
      userAudioRetentionDays: getChildDataPolicy().userAudioRetentionDays,
      historyRetentionDays: getChildDataPolicy().historyRetentionDays,
      diagnosticRetentionDays: getChildDataPolicy().diagnosticRetentionDays,
      automaticDeletionEnabled: getChildDataPolicy().automaticDeletionEnabled,
    },
    {
      userAudioRetentionDays: 30,
      historyRetentionDays: 180,
      diagnosticRetentionDays: 30,
      automaticDeletionEnabled: true,
    },
  );
});

test("uses the legacy child retention variable during migration", () => {
  delete process.env.USER_AUDIO_RETENTION_DAYS;
  delete process.env.HISTORY_RETENTION_DAYS;
  delete process.env.DIAGNOSTIC_RETENTION_DAYS;
  process.env.CHILD_DATA_RETENTION_DAYS = "45";

  assert.equal(getUserAudioRetentionDays(), 45);
  assert.equal(getHistoryRetentionDays(), 45);
  assert.equal(getDiagnosticRetentionDays(), 45);
});

test("specific retention values override the legacy value", () => {
  process.env.CHILD_DATA_RETENTION_DAYS = "90";
  process.env.USER_AUDIO_RETENTION_DAYS = "30";
  process.env.HISTORY_RETENTION_DAYS = "180";
  process.env.DIAGNOSTIC_RETENTION_DAYS = "30";

  assert.equal(getUserAudioRetentionDays(), 30);
  assert.equal(getHistoryRetentionDays(), 180);
  assert.equal(getDiagnosticRetentionDays(), 30);
});
