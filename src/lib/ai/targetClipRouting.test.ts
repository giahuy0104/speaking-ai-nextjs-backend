import assert from "node:assert/strict";
import { test } from "node:test";
import { clipGoesToDeepInfra, deepInfraClipShare } from "./targetClipRouting";

test("the DeepInfra share is off unless set to a number above 0, and at most 1", () => {
  assert.equal(deepInfraClipShare({}), 0);
  assert.equal(deepInfraClipShare({ AUDIO_TARGET_CLIP_DEEPINFRA_SHARE: "abc" }), 0);
  assert.equal(deepInfraClipShare({ AUDIO_TARGET_CLIP_DEEPINFRA_SHARE: "-0.5" }), 0);
  assert.equal(deepInfraClipShare({ AUDIO_TARGET_CLIP_DEEPINFRA_SHARE: " 0.33 " }), 0.33);
  assert.equal(deepInfraClipShare({ AUDIO_TARGET_CLIP_DEEPINFRA_SHARE: "3" }), 1);
});

test("no share sends nothing to DeepInfra; a full share sends everything", () => {
  assert.equal(clipGoesToDeepInfra("ja", "こんにちは。", {}), false);
  assert.equal(clipGoesToDeepInfra("ja", "こんにちは。", { AUDIO_TARGET_CLIP_DEEPINFRA_SHARE: "1" }), true);
});

test("about a third of sentences go to DeepInfra, and a sentence always goes the same way", () => {
  const env = { AUDIO_TARGET_CLIP_DEEPINFRA_SHARE: "0.33" };
  let routed = 0;
  for (let i = 0; i < 3_000; i++) if (clipGoesToDeepInfra("ko", `문장 ${i}번입니다.`, env)) routed++;
  assert.ok(routed > 900 && routed < 1_080, `routed ${routed} of 3000`);

  // Same sentence (as the cache normalizes it): same answer, so cache lookups agree.
  const once = clipGoesToDeepInfra("fr", "Bonjour  le monde.", env);
  for (let i = 0; i < 5; i++) assert.equal(clipGoesToDeepInfra("fr", " Bonjour le monde. ", env), once);
});
