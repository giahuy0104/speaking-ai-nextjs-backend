import assert from "node:assert/strict";
import { test } from "node:test";
import { targetSpeechModeFor } from "./targetSpeechMode";

test("without streaming every sentence is a finished clip", () => {
  assert.equal(targetSpeechModeFor("zh", "今天早上我起得很早，打开窗户，呼吸了新鲜空气。", { streaming: false, env: {} }), "clip");
});

test("a short sentence is a finished MP3 clip, a long one streams", () => {
  const options = { streaming: true, env: {} };
  // Defaults: 20 characters for zh/ja/ko (~3.5 s of speech), 50 for fr.
  assert.equal(targetSpeechModeFor("zh", "今天天气晴朗好看", options), "clip");
  assert.equal(targetSpeechModeFor("zh", "今天早上我起得很早，打开窗户，呼吸了新鲜空气。", options), "stream");
  assert.equal(targetSpeechModeFor("ja", "こんにちは、元気ですか？", options), "clip");
  assert.equal(targetSpeechModeFor("ko", "오늘은 날씨가 정말 좋아서 공원에 산책하러 갔어요", options), "stream");
  assert.equal(targetSpeechModeFor("fr", "Il fait beau aujourd'hui.", options), "clip");
  assert.equal(targetSpeechModeFor("fr", "Ce matin je me suis levé tôt et j'ai ouvert la fenêtre.", options), "stream");
});

test("the thresholds come from the environment", () => {
  const env = { AUDIO_TARGET_STREAM_MIN_CHARS: "5", AUDIO_TARGET_STREAM_MIN_CHARS_FR: "200" };
  assert.equal(targetSpeechModeFor("zh", "今天天气晴朗好看", { streaming: true, env }), "stream");
  assert.equal(targetSpeechModeFor("fr", "Ce matin je me suis levé tôt et j'ai ouvert la fenêtre.", { streaming: true, env }), "clip");
});

test("length counts characters of the normalized text, so the pipeline and the audio route agree", () => {
  const options = { streaming: true, env: { AUDIO_TARGET_STREAM_MIN_CHARS: "8" } };
  // Surrounding and repeated whitespace does not count.
  assert.equal(targetSpeechModeFor("zh", "  今天   天气  ", options), "clip");
  assert.equal(targetSpeechModeFor("zh", "今天天气晴朗好看", options), "stream");
  // An emoji is one character, not two UTF-16 units: 7 characters here.
  assert.equal(targetSpeechModeFor("zh", "今天天气晴朗😀", options), "clip");
});

test("an invalid threshold falls back to the default", () => {
  const env = { AUDIO_TARGET_STREAM_MIN_CHARS: "abc" };
  assert.equal(targetSpeechModeFor("zh", "今天天气晴朗好看", { streaming: true, env }), "clip");
});
