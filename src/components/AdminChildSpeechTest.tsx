"use client";

import Link from "next/link";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { LanguageToggle } from "@/components/LanguageToggle";
import { useUiLocale } from "@/components/UiLocaleProvider";
import type { ChildSpeechTestResponse } from "@/types/childSpeechTest";
import type { PracticeContext } from "@/types/conversation";

type ReviewerVerdict = "unreviewed" | "approved" | "rejected";

type TestResult = ChildSpeechTestResponse & {
  localId: string;
  reviewerVerdict: ReviewerVerdict;
};

const defaultSentences = [
  "Con khát nước.",
  "Con muốn rửa tay.",
  "Món này ngon quá.",
].join("\n");

const mimeCandidates = [
  "audio/webm;codecs=opus",
  "audio/mp4",
  "audio/webm",
  "audio/ogg;codecs=opus",
] as const;

function responseError(data: unknown, fallback: string) {
  if (
    data &&
    typeof data === "object" &&
    "error" in data &&
    data.error &&
    typeof data.error === "object" &&
    "message" in data.error &&
    typeof data.error.message === "string"
  ) {
    return data.error.message;
  }
  return fallback;
}

function csvValue(value: unknown) {
  const text = value === undefined || value === null ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function buildCsv(results: TestResult[]) {
  const rows = results.map((result) => [
    result.testedAt,
    result.expectedText,
    result.rawAsr,
    result.correctedText,
    result.matchedExpected,
    result.reviewerVerdict,
    result.repair.strategy,
    result.repair.score,
    result.repair.margin,
    result.qualityIssue,
    result.asr.latencyMs,
    result.repair.latencyMs,
    result.totalMs,
    result.context,
    result.childAge,
    result.lessonId,
    result.inputLabel,
    result.requestId,
  ]);
  return [
    [
      "testedAt",
      "expectedText",
      "rawAsr",
      "correctedText",
      "matchedExpected",
      "reviewerVerdict",
      "strategy",
      "score",
      "margin",
      "qualityIssue",
      "asrMs",
      "repairMs",
      "totalMs",
      "context",
      "childAge",
      "lessonId",
      "inputLabel",
      "requestId",
    ],
    ...rows,
  ]
    .map((row) => row.map(csvValue).join(","))
    .join("\n");
}

function badgeClass(result: TestResult) {
  if (result.reviewerVerdict === "approved") {
    return "border-emerald-400/30 bg-emerald-400/10 text-emerald-200";
  }
  if (result.reviewerVerdict === "rejected") {
    return "border-rose-400/30 bg-rose-400/10 text-rose-200";
  }
  return result.matchedExpected
    ? "border-cyan-400/30 bg-cyan-400/10 text-cyan-200"
    : "border-amber-400/30 bg-amber-400/10 text-amber-200";
}

export function AdminChildSpeechTest() {
  const { pick } = useUiLocale();
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordingExpectedRef = useRef("");
  const recordingStartedAtRef = useRef(0);
  const disposedRef = useRef(false);
  const [queueText, setQueueText] = useState(defaultSentences);
  const [sentences, setSentences] = useState(() => defaultSentences.split("\n"));
  const [currentIndex, setCurrentIndex] = useState(0);
  const [context, setContext] = useState<PracticeContext>("home");
  const [childAge, setChildAge] = useState(6);
  const [lessonId, setLessonId] = useState("");
  const [rawReplay, setRawReplay] = useState("");
  const [results, setResults] = useState<TestResult[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const currentSentence = sentences[currentIndex] ?? "";
  const stats = useMemo(() => {
    const matched = results.filter((result) => result.matchedExpected).length;
    const approved = results.filter(
      (result) => result.reviewerVerdict === "approved",
    ).length;
    const rejected = results.filter(
      (result) => result.reviewerVerdict === "rejected",
    ).length;
    return { matched, approved, rejected };
  }, [results]);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.onstop = null;
        recorder.stop();
      }
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  function stopMediaTracks() {
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    mediaRecorderRef.current = null;
  }

  function loadQueue() {
    const nextSentences = queueText
      .split(/\r?\n/)
      .map((sentence) => sentence.trim())
      .filter(Boolean)
      .slice(0, 100);
    if (nextSentences.length === 0) {
      setError(pick("Hãy nhập ít nhất một câu dự kiến.", "请至少输入一个目标句子。"));
      return;
    }
    setSentences(nextSentences);
    setCurrentIndex(0);
    setResults([]);
    setRawReplay("");
    setError(null);
    setNotice(
      pick(
        `Đã nạp ${nextSentences.length} câu kiểm tra.`,
        `已载入 ${nextSentences.length} 个测试句子。`,
      ),
    );
  }

  async function parseTestResponse(response: Response) {
    const data = (await response.json().catch(() => null)) as
      | ChildSpeechTestResponse
      | null;
    if (response.status === 401) {
      window.location.replace("/admin/login");
      throw new Error(pick("Phiên quản trị đã hết hạn.", "管理会话已过期。"));
    }
    if (!response.ok || !data || !("correctedText" in data)) {
      throw new Error(
        responseError(
          data,
          pick("Không chạy được bài kiểm tra.", "无法运行测试。"),
        ),
      );
    }
    return data;
  }

  function appendResult(response: ChildSpeechTestResponse) {
    const result: TestResult = {
      ...response,
      localId: `${response.requestId}-${Date.now()}`,
      reviewerVerdict: "unreviewed",
    };
    setResults((current) => [result, ...current]);
    setRawReplay(response.rawAsr);
    setCurrentIndex((index) =>
      index < sentences.length - 1 ? index + 1 : index,
    );
    setNotice(
      response.matchedExpected
        ? pick("Khớp câu dự kiến.", "与目标句子匹配。")
        : pick("Chưa khớp; hãy xem Raw ASR và chiến lược sửa.", "未匹配；请检查原始 ASR 和修复策略。"),
    );
  }

  async function analyzeAudio(
    audio: Blob,
    expectedText: string,
    durationMs?: number,
    inputLabel = "Web admin microphone",
  ) {
    if (!expectedText) return;
    setIsProcessing(true);
    setError(null);
    try {
      const form = new FormData();
      const extension = audio.type.includes("mp4") ? "m4a" : "webm";
      form.set("audio", audio, `child-speech-test.${extension}`);
      form.set("expectedText", expectedText);
      form.set("context", context);
      form.set("childAge", String(childAge));
      form.set("inputLabel", inputLabel);
      if (lessonId.trim()) form.set("lessonId", lessonId.trim());
      if (durationMs) form.set("utteranceDurationMs", String(durationMs));
      const response = await fetch("/api/admin/child-speech-test", {
        method: "POST",
        body: form,
      });
      appendResult(await parseTestResponse(response));
    } catch (testError) {
      setError(
        testError instanceof Error
          ? testError.message
          : pick("Không kiểm tra được audio.", "无法测试音频。"),
      );
    } finally {
      setIsProcessing(false);
    }
  }

  async function startRecording() {
    if (!currentSentence || isProcessing || isRecording) return;
    setError(null);
    setNotice(null);
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setError(
        pick(
          "Trình duyệt không hỗ trợ ghi âm trực tiếp. Hãy chọn file audio.",
          "浏览器不支持直接录音，请选择音频文件。",
        ),
      );
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      mediaStreamRef.current = stream;
      chunksRef.current = [];
      recordingExpectedRef.current = currentSentence;
      recordingStartedAtRef.current = performance.now();
      const mimeType = mimeCandidates.find((candidate) =>
        MediaRecorder.isTypeSupported(candidate),
      );
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        setError(pick("Ghi âm bị lỗi.", "录音发生错误。"));
        setIsRecording(false);
        stopMediaTracks();
      };
      recorder.onstop = () => {
        const durationMs = Math.round(
          performance.now() - recordingStartedAtRef.current,
        );
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        });
        const expected = recordingExpectedRef.current;
        setIsRecording(false);
        stopMediaTracks();
        if (!disposedRef.current && blob.size > 0) {
          void analyzeAudio(blob, expected, durationMs);
        }
      };
      recorder.start(250);
      setIsRecording(true);
    } catch (recordError) {
      stopMediaTracks();
      setError(
        recordError instanceof Error
          ? recordError.message
          : pick("Không mở được micro.", "无法打开麦克风。"),
      );
    }
  }

  function stopRecording() {
    const recorder = mediaRecorderRef.current;
    if (recorder?.state === "recording") recorder.stop();
  }

  async function runTextReplay() {
    if (!currentSentence || !rawReplay.trim() || isProcessing) return;
    setIsProcessing(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/child-speech-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedText: currentSentence,
          rawAsr: rawReplay.trim(),
          context,
          childAge,
          lessonId: lessonId.trim() || undefined,
          inputLabel: "Admin text replay",
        }),
      });
      appendResult(await parseTestResponse(response));
    } catch (testError) {
      setError(
        testError instanceof Error
          ? testError.message
          : pick("Không chạy được Raw ASR.", "无法运行原始 ASR。"),
      );
    } finally {
      setIsProcessing(false);
    }
  }

  function chooseAudio(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file && currentSentence) {
      void analyzeAudio(
        file,
        currentSentence,
        undefined,
        `Uploaded file · ${file.name}`,
      );
    }
  }

  function setVerdict(localId: string, verdict: ReviewerVerdict) {
    setResults((current) =>
      current.map((result) =>
        result.localId === localId
          ? { ...result, reviewerVerdict: verdict }
          : result,
      ),
    );
  }

  function exportCsv() {
    if (results.length === 0) return;
    const blob = new Blob(["\uFEFF", buildCsv(results)], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `child-speech-test-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <header className="rounded-3xl border border-white/10 bg-gradient-to-br from-slate-900 to-indigo-950 p-6 shadow-2xl">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-cyan-300">
              ASR + Child Speech Matcher
            </p>
            <h1 className="mt-2 text-3xl font-semibold text-white">
              {pick("Kiểm tra giọng trẻ em", "儿童语音测试")}
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-300">
              {pick(
                "Chỉ chạy Cloudflare ASR và lớp sửa. Audio không được lưu, không gọi dịch hoặc TTS.",
                "仅运行 Cloudflare ASR 和修复层，不保存音频，也不调用翻译或 TTS。",
              )}
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link
              href="/admin"
              className="rounded-xl border border-white/15 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-white/10"
            >
              {pick("Về quản trị", "返回管理中心")}
            </Link>
            <LanguageToggle tone="dark" />
          </div>
        </div>
      </header>

      <section className="grid gap-5 lg:grid-cols-[1.05fr_0.95fr]">
        <div className="rounded-3xl border border-white/10 bg-slate-900 p-5">
          <h2 className="text-lg font-semibold text-white">
            {pick("Danh sách câu dự kiến", "目标句子列表")}
          </h2>
          <textarea
            value={queueText}
            onChange={(event) => setQueueText(event.target.value)}
            rows={7}
            className="mt-3 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400"
            aria-label={pick("Mỗi dòng một câu", "每行一个句子")}
          />
          <div className="mt-3 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={loadQueue}
              disabled={isRecording || isProcessing}
              className="rounded-xl bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50"
            >
              {pick("Nạp danh sách", "载入列表")}
            </button>
            <span className="self-center text-sm text-slate-400">
              {sentences.length === 0 ? 0 : currentIndex + 1}/{sentences.length}
            </span>
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            <label className="text-sm text-slate-300">
              {pick("Ngữ cảnh", "场景")}
              <select
                value={context}
                onChange={(event) =>
                  setContext(event.target.value as PracticeContext)
                }
                className="mt-1 block w-full rounded-xl border border-white/10 bg-slate-950 px-3 py-2 text-white"
              >
                <option value="home">home</option>
                <option value="school">school</option>
                <option value="outside">outside</option>
              </select>
            </label>
            <label className="text-sm text-slate-300">
              {pick("Tuổi", "年龄")}
              <input
                type="number"
                min={2}
                max={18}
                value={childAge}
                onChange={(event) => setChildAge(Number(event.target.value))}
                className="mt-1 block w-full rounded-xl border border-white/10 bg-slate-950 px-3 py-2 text-white"
              />
            </label>
            <label className="text-sm text-slate-300">
              Lesson ID
              <input
                value={lessonId}
                onChange={(event) => setLessonId(event.target.value)}
                className="mt-1 block w-full rounded-xl border border-white/10 bg-slate-950 px-3 py-2 text-white"
                placeholder="optional"
              />
            </label>
          </div>
        </div>

        <div className="rounded-3xl border border-cyan-400/20 bg-slate-900 p-5">
          <p className="text-sm font-semibold text-cyan-300">
            {pick("Câu hiện tại", "当前句子")}
          </p>
          <p className="mt-3 min-h-16 text-2xl font-semibold leading-9 text-white">
            {currentSentence || pick("Chưa có câu", "暂无句子")}
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={isRecording ? stopRecording : () => void startRecording()}
              disabled={!currentSentence || isProcessing}
              className={`rounded-2xl px-5 py-3 text-sm font-semibold disabled:opacity-50 ${
                isRecording
                  ? "bg-rose-500 text-white"
                  : "bg-indigo-500 text-white"
              }`}
            >
              {isRecording
                ? pick("Dừng và kiểm tra", "停止并测试")
                : pick("Bắt đầu ghi âm", "开始录音")}
            </button>
            <label className="cursor-pointer rounded-2xl border border-white/15 px-5 py-3 text-sm font-semibold text-slate-200 hover:bg-white/10">
              {pick("Chọn file audio", "选择音频文件")}
              <input
                type="file"
                accept="audio/*"
                className="sr-only"
                onChange={chooseAudio}
                disabled={!currentSentence || isRecording || isProcessing}
              />
            </label>
          </div>
          <div className="mt-5 border-t border-white/10 pt-5">
            <label className="text-sm text-slate-300">
              Raw ASR replay
              <input
                value={rawReplay}
                onChange={(event) => setRawReplay(event.target.value)}
                className="mt-2 block w-full rounded-xl border border-white/10 bg-slate-950 px-3 py-2 text-white"
                placeholder={pick("Dán câu ASR đã nhận", "粘贴 ASR 结果")}
              />
            </label>
            <button
              type="button"
              onClick={() => void runTextReplay()}
              disabled={!rawReplay.trim() || !currentSentence || isProcessing}
              className="mt-3 rounded-xl border border-cyan-300/30 bg-cyan-300/10 px-4 py-2 text-sm font-semibold text-cyan-100 disabled:opacity-50"
            >
              {pick("Chạy lại matcher", "重新运行修复层")}
            </button>
          </div>
          {isProcessing ? (
            <p className="mt-4 text-sm text-cyan-200" role="status">
              {pick("Đang nhận dạng…", "正在识别…")}
            </p>
          ) : null}
        </div>
      </section>

      {error ? (
        <div className="rounded-2xl border border-rose-400/30 bg-rose-400/10 p-4 text-sm text-rose-100" role="alert">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="rounded-2xl border border-cyan-400/30 bg-cyan-400/10 p-4 text-sm text-cyan-100" role="status">
          {notice}
        </div>
      ) : null}

      <section className="rounded-3xl border border-white/10 bg-slate-900 p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-white">
              {pick("Kết quả", "测试结果")}
            </h2>
            <p className="mt-1 text-sm text-slate-400">
              {results.length} test · {stats.matched} matched · {stats.approved} approved · {stats.rejected} rejected
            </p>
          </div>
          <button
            type="button"
            onClick={exportCsv}
            disabled={results.length === 0}
            className="rounded-xl border border-emerald-300/30 bg-emerald-300/10 px-4 py-2 text-sm font-semibold text-emerald-100 disabled:opacity-50"
          >
            {pick("Xuất CSV", "导出 CSV")}
          </button>
        </div>

        <div className="mt-5 grid gap-4">
          {results.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-white/15 p-6 text-center text-sm text-slate-400">
              {pick("Chưa có lượt kiểm tra.", "暂无测试记录。")}
            </p>
          ) : (
            results.map((result) => (
              <article
                key={result.localId}
                className="rounded-2xl border border-white/10 bg-slate-950/70 p-4 [content-visibility:auto]"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold text-white">
                      {result.expectedText}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      {new Date(result.testedAt).toLocaleString()} · {result.mode}
                    </p>
                  </div>
                  <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${badgeClass(result)}`}>
                    {result.matchedExpected
                      ? pick("Khớp", "匹配")
                      : pick("Chưa khớp", "未匹配")}
                  </span>
                </div>
                <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-slate-500">Raw ASR</dt>
                    <dd className="mt-1 text-slate-100">{result.rawAsr}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Corrected</dt>
                    <dd className="mt-1 text-slate-100">{result.correctedText}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Strategy</dt>
                    <dd className="mt-1 text-slate-300">
                      {result.repair.strategy ?? "none"} · score {result.repair.score ?? "—"} · margin {result.repair.margin ?? "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Latency</dt>
                    <dd className="mt-1 text-slate-300">
                      ASR {result.asr.latencyMs} ms · repair {result.repair.latencyMs} ms · total {result.totalMs} ms
                    </dd>
                  </div>
                </dl>
                {result.qualityIssue ? (
                  <p className="mt-3 text-sm text-amber-200">
                    Quality: {result.qualityIssue}
                  </p>
                ) : null}
                <div className="mt-4 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setVerdict(result.localId, "approved")}
                    className="rounded-lg border border-emerald-400/30 px-3 py-1.5 text-xs font-semibold text-emerald-200 hover:bg-emerald-400/10"
                  >
                    {pick("Đánh dấu đúng", "标记正确")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setVerdict(result.localId, "rejected")}
                    className="rounded-lg border border-rose-400/30 px-3 py-1.5 text-xs font-semibold text-rose-200 hover:bg-rose-400/10"
                  >
                    {pick("Đánh dấu sai", "标记错误")}
                  </button>
                </div>
              </article>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
