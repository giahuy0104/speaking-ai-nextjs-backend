import assert from "node:assert/strict";
import test from "node:test";
import { diagnoseChildSpeechTranscript } from "./childSpeechTranscriptDiagnostic";

test("reports the exact child-speech repair strategy without translation", () => {
  const diagnostic = diagnoseChildSpeechTranscript("Con hát nước.");

  assert.equal(diagnostic.text, "Con khát nước.");
  assert.equal(diagnostic.corpusRepairApplied, true);
  assert.equal(diagnostic.strategy, "observed_child_alias");
  assert.match(diagnostic.correctionId ?? "", /^CHILD-ASR-V2-/);
  assert.ok(diagnostic.repairMs >= 0);
});

test("keeps an unmatched production ASR transcript visible for review", () => {
  const diagnostic = diagnoseChildSpeechTranscript("Con hát nút");

  assert.equal(diagnostic.rawText, "Con hát nút");
  assert.equal(diagnostic.text, "Con hát nút");
  assert.equal(diagnostic.corpusRepairApplied, false);
  assert.equal(diagnostic.strategy, undefined);
});
