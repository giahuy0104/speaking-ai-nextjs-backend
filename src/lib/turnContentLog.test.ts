import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_LOGGED_TEXT_CHARS, maskAudioUrl, turnContent } from "./turnContentLog";

const on = { LOG_TURN_CONTENT: "true" };

test("adds nothing unless LOG_TURN_CONTENT=true", () => {
  assert.deepEqual(turnContent({ sourceText: "Hôm nay trời nắng đẹp" }, {}), {});
  assert.deepEqual(turnContent({ sourceText: "Hôm nay trời nắng đẹp" }, { LOG_TURN_CONTENT: "1" }), {});
});

test("logs the sentences, trimmed and cut to a bounded length", () => {
  assert.deepEqual(turnContent({ sourceText: "  Hôm nay trời nắng đẹp ", translatedText: "今天天气晴朗好看" }, on),
    { sourceText: "Hôm nay trời nắng đẹp", translatedText: "今天天气晴朗好看" });
  const long = "a".repeat(MAX_LOGGED_TEXT_CHARS + 50);
  const logged = turnContent({ sourceText: long }, on).sourceText as string;
  assert.equal(Array.from(logged).length, MAX_LOGGED_TEXT_CHARS + 1, "200 characters and an ellipsis");
  assert.ok(logged.endsWith("…"));
});

test("skips empty values and masks the client id", () => {
  assert.deepEqual(turnContent({ sourceText: "", translatedText: undefined, clientId: "android_0123456789abcdef" }, on),
    { clientId: "…abcdef" });
});

test("audio URLs never carry their signatures in logs", () => {
  assert.equal(
    maskAudioUrl("/api/audio/target?lang=zh&exp=1&sig=SECRETSIG&node=3001&text=x"),
    "/api/audio/target?lang=zh&exp=1&sig=***&node=3001&text=x",
  );
  assert.equal(
    maskAudioUrl("/api/audio/stream?text=Hi&missToken=abc-123&nocache=1700.SIGNED"),
    "/api/audio/stream?text=Hi&missToken=***&nocache=***",
  );
  assert.deepEqual(turnContent({ audioUrl: "/api/audio/target?sig=abc&lang=ja" }, on), { audioUrl: "/api/audio/target?sig=***&lang=ja" });
  assert.equal(maskAudioUrl(null), undefined);
});
