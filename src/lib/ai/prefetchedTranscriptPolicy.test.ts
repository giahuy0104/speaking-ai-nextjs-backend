import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "@/lib/appError";
import { resolvePrefetchedTranscriptForPipeline } from "./prefetchedTranscriptPolicy";

function assertLowConfidencePrefetch(sourceText: string) {
  assert.throws(
    () =>
      resolvePrefetchedTranscriptForPipeline({
        sourceText,
        latencyMs: 500,
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "ASR_LOW_CONFIDENCE");
      assert.equal(error.status, 422);
      return true;
    },
  );
}

test("repairs Web Worker prefetched transcripts before cache and translation", () => {
  const result = resolvePrefetchedTranscriptForPipeline(
    {
      sourceText: "Cảm ơn chơi với bạn",
      latencyMs: 430,
    },
  );

  assert.equal(result.sourceText, "Con muốn chơi với bạn.");
  assert.equal(result.latencyMs, 430);
  assert.equal(result.changed, true);
  assert.equal(result.canReuseDownstreamPrefetch, false);
  assert.equal(result.repair.correctionId, "LEGACY-AUDIO-006");
  assert.equal(result.repair.strategy, "reviewed_legacy_audio_alias");
});

test("repairs Batch prefetched transcripts and invalidates stale downstream work", () => {
  const result = resolvePrefetchedTranscriptForPipeline(
    {
      sourceText: "Mẹ ơi, con còn giúp?",
      latencyMs: 780,
    },
  );

  assert.equal(result.sourceText, "Mẹ ơi, con cần giúp.");
  assert.equal(result.changed, true);
  assert.equal(result.canReuseDownstreamPrefetch, false);
  assert.equal(result.repair.correctionId, "LEGACY-AUDIO-024");
});

test("repairs a Web prefetch with an equivalent final politeness particle", () => {
  const result = resolvePrefetchedTranscriptForPipeline({
    sourceText: "Cô chú nó chậm lại nha",
    latencyMs: 510,
  });

  assert.equal(result.sourceText, "Cô chú nói chậm lại nhé");
  assert.equal(result.changed, true);
  assert.equal(result.canReuseDownstreamPrefetch, false);
  assert.equal(result.repair.correctionId, "LEGACY-AUDIO-030");
});

test("repairs the reviewed Book1 alias before Web cache and translation", () => {
  const result = resolvePrefetchedTranscriptForPipeline({
    sourceText: "Còn có một quà báo?",
    latencyMs: 460,
  });

  assert.equal(result.sourceText, "Con có một quả bóng");
  assert.equal(result.changed, true);
  assert.equal(result.canReuseDownstreamPrefetch, false);
  assert.equal(result.repair.correctionId, "BOOK1-AUDIO-001");
  assert.equal(result.repair.strategy, "reviewed_book1_audio_alias");
});

test("repairs a reviewed Book2 alias before Web cache and translation", () => {
  const result = resolvePrefetchedTranscriptForPipeline({
    sourceText: "Con thái con mẹ",
    latencyMs: 520,
  });

  assert.equal(result.sourceText, "Con thấy con mèo.");
  assert.equal(result.changed, true);
  assert.equal(result.canReuseDownstreamPrefetch, false);
  assert.equal(result.repair.correctionId, "BOOK2-AUDIO-002");
  assert.equal(result.repair.strategy, "reviewed_book2_audio_alias");
});

test("repairs a reviewed tested-audio alias before Web cache and translation", () => {
  const result = resolvePrefetchedTranscriptForPipeline({
    sourceText: "Mũ trời chia bát.",
    latencyMs: 540,
  });

  assert.equal(result.sourceText, "Con muốn chơi với bạn.");
  assert.equal(result.changed, true);
  assert.equal(result.canReuseDownstreamPrefetch, false);
  assert.equal(result.repair.correctionId, "TESTED-AUDIO-001");
  assert.equal(result.repair.strategy, "reviewed_tested_audio_alias");
});

test("repairs a confirmed production Web retest variant before cache", () => {
  const result = resolvePrefetchedTranscriptForPipeline({
    sourceText: "Canh hít màu đỏ",
    latencyMs: 12,
  });

  assert.equal(result.sourceText, "Con thích màu đỏ.");
  assert.equal(result.changed, true);
  assert.equal(result.canReuseDownstreamPrefetch, false);
  assert.equal(result.repair.correctionId, "WEB-RETEST-20260811-001");
  assert.equal(result.repair.strategy, "reviewed_web_retest_audio_alias");
});

test("rejects Web Worker subscribe hallucinations before repair and cache", () => {
  assertLowConfidencePrefetch(
    "Hãy subscribe cho kênh Ghiền Mì Gõ để không bỏ lỡ những video hấp dẫn.",
  );
  assertLowConfidencePrefetch(
    "Các bạn hãy subscribe cho kênh Ghiền Mì Gõ để không bỏ lỡ những video hấp dẫn.",
  );
  assertLowConfidencePrefetch(
    "Các bạn hãy subcrise cho kênh để không bỏ lỡ video.",
  );
});

test("rejects Batch prefetched video outros before translation and TTS", () => {
  assertLowConfidencePrefetch(
    "Cảm ơn các bạn đã theo dõi và hẹn gặp lại trong video tiếp theo.",
  );
});

test("keeps legitimate child video and registration phrases", () => {
  for (const sourceText of [
    "Con muốn xem video về con mèo.",
    "Con muốn đăng ký học bơi.",
  ]) {
    const result = resolvePrefetchedTranscriptForPipeline({
      sourceText,
      latencyMs: 400,
    });
    assert.equal(result.sourceText, sourceText);
  }
});

test("keeps downstream prefetch reusable when the transcript is unchanged", () => {
  const result = resolvePrefetchedTranscriptForPipeline(
    {
      sourceText: "Con muốn chơi với bạn.",
      latencyMs: 310,
    },
  );

  assert.equal(result.sourceText, "Con muốn chơi với bạn.");
  assert.equal(result.changed, false);
  assert.equal(result.canReuseDownstreamPrefetch, true);
  assert.equal(result.repair.applied, false);
});
