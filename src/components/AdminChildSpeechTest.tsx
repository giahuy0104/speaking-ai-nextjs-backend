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

type BatchAudioStatus = "pending" | "running" | "completed" | "failed";

type BatchAudioItem = {
  id: string;
  file: File;
  sentenceIndex: number | null;
  mappingSource: "filename" | "manual" | "order" | null;
  status: BatchAudioStatus;
  error?: string;
};

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

const audioFileCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

function numberedSentenceIndex(fileName: string, sentenceCount: number) {
  const match = /^(?:audio[\s_-]*)?(\d{1,3})(?=[\s_.-]|$)/i.exec(fileName);
  if (!match) return null;
  const oneBasedIndex = Number(match[1]);
  return oneBasedIndex >= 1 && oneBasedIndex <= sentenceCount
    ? oneBasedIndex - 1
    : null;
}

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
  const batchAbortRef = useRef<AbortController | null>(null);
  const [queueText, setQueueText] = useState(defaultSentences);
  const [sentences, setSentences] = useState(() => defaultSentences.split("\n"));
  const [currentIndex, setCurrentIndex] = useState(0);
  const [context, setContext] = useState<PracticeContext>("home");
  const [childAge, setChildAge] = useState(6);
  const [lessonId, setLessonId] = useState("");
  const [rawReplay, setRawReplay] = useState("");
  const [results, setResults] = useState<TestResult[]>([]);
  const [batchAudio, setBatchAudio] = useState<BatchAudioItem[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isBatchProcessing, setIsBatchProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const currentSentence = sentences[currentIndex] ?? "";
  const isBusy = isProcessing || isBatchProcessing;
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
  const batchStats = useMemo(() => {
    let pending = 0;
    let running = 0;
    let completed = 0;
    let failed = 0;
    let unassigned = 0;
    for (const item of batchAudio) {
      if (item.sentenceIndex === null) unassigned += 1;
      if (item.status === "pending") pending += 1;
      if (item.status === "running") running += 1;
      if (item.status === "completed") completed += 1;
      if (item.status === "failed") failed += 1;
    }
    return { pending, running, completed, failed, unassigned };
  }, [batchAudio]);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.onstop = null;
        recorder.stop();
      }
      batchAbortRef.current?.abort();
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
    setBatchAudio([]);
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

  function appendResult(
    response: ChildSpeechTestResponse,
    options: { advanceQueue?: boolean; showNotice?: boolean } = {},
  ) {
    const { advanceQueue = true, showNotice = true } = options;
    const result: TestResult = {
      ...response,
      localId: `${response.requestId}-${Date.now()}`,
      reviewerVerdict: "unreviewed",
    };
    setResults((current) => [result, ...current]);
    setRawReplay(response.rawAsr);
    if (advanceQueue) {
      setCurrentIndex((index) =>
        index < sentences.length - 1 ? index + 1 : index,
      );
    }
    if (showNotice) {
      setNotice(
        response.matchedExpected
          ? pick("Khớp câu dự kiến.", "与目标句子匹配。")
          : pick(
              "Chưa khớp; hãy xem Raw ASR và chiến lược sửa.",
              "未匹配；请检查原始 ASR 和修复策略。",
            ),
      );
    }
  }

  async function requestAudioAnalysis(
    audio: Blob,
    expectedText: string,
    durationMs?: number,
    inputLabel = "Web admin microphone",
    signal?: AbortSignal,
  ) {
    const form = new FormData();
    const extension = audio.type.includes("mp4") ? "m4a" : "webm";
    const uploadFileName =
      audio instanceof File ? audio.name : `child-speech-test.${extension}`;
    form.set("audio", audio, uploadFileName);
    form.set("expectedText", expectedText);
    form.set("context", context);
    form.set("childAge", String(childAge));
    form.set("inputLabel", inputLabel);
    if (lessonId.trim()) form.set("lessonId", lessonId.trim());
    if (durationMs) form.set("utteranceDurationMs", String(durationMs));
    const response = await fetch("/api/admin/child-speech-test", {
      method: "POST",
      body: form,
      signal,
    });
    return parseTestResponse(response);
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
      appendResult(
        await requestAudioAnalysis(
          audio,
          expectedText,
          durationMs,
          inputLabel,
        ),
      );
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
    if (!currentSentence || isBusy || isRecording) return;
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
    if (!currentSentence || !rawReplay.trim() || isBusy) return;
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

  function chooseBatchAudio(event: ChangeEvent<HTMLInputElement>) {
    const selectedFiles = Array.from(event.target.files ?? []).sort((a, b) =>
      audioFileCollator.compare(a.name, b.name),
    );
    event.target.value = "";
    if (selectedFiles.length === 0) return;

    const availableSlots = Math.max(0, 100 - batchAudio.length);
    const acceptedFiles = selectedFiles.slice(0, availableSlots);
    if (acceptedFiles.length === 0) {
      setError(
        pick(
          "Mỗi đợt chỉ được chuẩn bị tối đa 100 file audio.",
          "每批最多只能准备 100 个音频文件。",
        ),
      );
      return;
    }

    const selectedAt = Date.now();
    const newItems = acceptedFiles.map<BatchAudioItem>((file, index) => {
      const sentenceIndex = numberedSentenceIndex(file.name, sentences.length);
      return {
        id: `${selectedAt}-${index}-${file.name}-${file.size}`,
        file,
        sentenceIndex,
        mappingSource: sentenceIndex === null ? null : "filename",
        status: "pending",
      };
    });
    const automaticallyPaired = newItems.filter(
      (item) => item.sentenceIndex !== null,
    ).length;
    setBatchAudio((current) => [...current, ...newItems]);
    setError(
      selectedFiles.length > acceptedFiles.length
        ? pick(
            `Chỉ nhận ${acceptedFiles.length} file còn lại để không vượt quá 100 file.`,
            `仅接收剩余的 ${acceptedFiles.length} 个文件，以免超过 100 个文件。`,
          )
        : null,
    );
    setNotice(
      pick(
        `Đã chọn ${acceptedFiles.length} file; tự ghép ${automaticallyPaired} file theo số ở đầu tên. Hãy kiểm tra trước khi chạy.`,
        `已选择 ${acceptedFiles.length} 个文件；根据文件名前缀自动配对 ${automaticallyPaired} 个。运行前请检查。`,
      ),
    );
  }

  function setBatchSentence(itemId: string, value: string) {
    const sentenceIndex = value === "" ? null : Number(value);
    setBatchAudio((current) =>
      current.map((item) =>
        item.id === itemId
          ? {
              ...item,
              sentenceIndex,
              mappingSource: sentenceIndex === null ? null : "manual",
              status: "pending",
              error: undefined,
            }
          : item,
      ),
    );
  }

  function removeBatchAudio(itemId: string) {
    setBatchAudio((current) =>
      current.filter((item) => item.id !== itemId),
    );
  }

  function pairBatchAudioByOrder() {
    setBatchAudio((current) =>
      current.map((item, index) => {
        if (item.status === "completed") return item;
        const sentenceIndex = index < sentences.length ? index : null;
        return {
          ...item,
          sentenceIndex,
          mappingSource: sentenceIndex === null ? null : "order",
          status: "pending",
          error: undefined,
        };
      }),
    );
    setNotice(
      pick(
        "Đã ghép theo thứ tự tên file đang hiển thị. Hãy kiểm tra từng dòng trước khi chạy.",
        "已按当前显示的文件名顺序配对，运行前请逐行检查。",
      ),
    );
  }

  async function runBatchAudio() {
    if (isBusy || batchAudio.length === 0) return;
    if (batchAudio.some((item) => item.sentenceIndex === null)) {
      setError(
        pick(
          "Còn file chưa được ghép với câu dự kiến. Hãy chọn câu cho các dòng màu vàng.",
          "仍有文件未匹配目标句子，请为黄色行选择句子。",
        ),
      );
      return;
    }

    const candidates = batchAudio.filter(
      (item) => item.status === "pending" || item.status === "failed",
    );
    if (candidates.length === 0) {
      setNotice(
        pick(
          "Tất cả file trong hàng đợi đã được xử lý.",
          "队列中的所有文件均已处理。",
        ),
      );
      return;
    }

    const controller = new AbortController();
    batchAbortRef.current = controller;
    setIsBatchProcessing(true);
    setError(null);
    setNotice(
      pick(
        `Đang xử lý ${candidates.length} file, tối đa 2 file song song…`,
        `正在处理 ${candidates.length} 个文件，最多同时处理 2 个…`,
      ),
    );
    setBatchAudio((current) =>
      current.map((item) =>
        item.status === "failed"
          ? { ...item, status: "pending", error: undefined }
          : item,
      ),
    );

    let cursor = 0;
    let completedCount = 0;
    let failedCount = 0;
    const runWorker = async () => {
      while (!controller.signal.aborted) {
        const candidateIndex = cursor;
        cursor += 1;
        const item = candidates[candidateIndex];
        if (!item) return;

        const sentenceIndex = item.sentenceIndex;
        const expectedText =
          sentenceIndex === null ? "" : sentences[sentenceIndex] ?? "";
        setBatchAudio((current) =>
          current.map((currentItem) =>
            currentItem.id === item.id
              ? { ...currentItem, status: "running", error: undefined }
              : currentItem,
          ),
        );

        try {
          const response = await requestAudioAnalysis(
            item.file,
            expectedText,
            undefined,
            `Batch upload · ${item.file.name}`,
            controller.signal,
          );
          if (disposedRef.current) return;
          appendResult(response, {
            advanceQueue: false,
            showNotice: false,
          });
          completedCount += 1;
          setBatchAudio((current) =>
            current.map((currentItem) =>
              currentItem.id === item.id
                ? { ...currentItem, status: "completed", error: undefined }
                : currentItem,
            ),
          );
        } catch (testError) {
          if (controller.signal.aborted || disposedRef.current) return;
          failedCount += 1;
          const message =
            testError instanceof Error
              ? testError.message
              : pick("Không xử lý được audio.", "无法处理音频。");
          setBatchAudio((current) =>
            current.map((currentItem) =>
              currentItem.id === item.id
                ? { ...currentItem, status: "failed", error: message }
                : currentItem,
            ),
          );
        }
      }
    };

    try {
      await Promise.all(
        Array.from(
          { length: Math.min(2, candidates.length) },
          () => runWorker(),
        ),
      );
      if (!disposedRef.current) {
        setNotice(
          controller.signal.aborted
            ? pick(
                "Đã dừng batch. Các file chưa chạy vẫn còn trong hàng đợi.",
                "批处理已停止，未运行的文件仍保留在队列中。",
              )
            : pick(
                `Hoàn tất batch: ${completedCount} thành công, ${failedCount} lỗi.`,
                `批处理完成：${completedCount} 个成功，${failedCount} 个失败。`,
              ),
        );
      }
    } finally {
      if (!disposedRef.current) setIsBatchProcessing(false);
      if (batchAbortRef.current === controller) batchAbortRef.current = null;
    }
  }

  function stopBatchAudio() {
    batchAbortRef.current?.abort();
    setBatchAudio((current) =>
      current.map((item) =>
        item.status === "running" ? { ...item, status: "pending" } : item,
      ),
    );
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
              disabled={isRecording || isBusy}
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
              disabled={!currentSentence || isBusy}
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
              {pick("Chọn 1 file audio", "选择 1 个音频文件")}
              <input
                type="file"
                accept="audio/*"
                className="sr-only"
                onChange={chooseAudio}
                disabled={!currentSentence || isRecording || isBusy}
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
              disabled={!rawReplay.trim() || !currentSentence || isBusy}
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

      <section className="rounded-3xl border border-indigo-400/25 bg-slate-900 p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-300">
              {pick("Luồng khuyến nghị", "推荐流程")}
            </p>
            <h2 className="mt-2 text-xl font-semibold text-white">
              {pick("Upload nhiều audio một lần", "一次上传多个音频")}
            </h2>
            <ol className="mt-3 grid gap-2 text-sm leading-6 text-slate-300 sm:grid-cols-3">
              <li>
                <strong className="text-white">1.</strong>{" "}
                {pick("Nhập và nạp danh sách câu.", "输入并载入句子列表。")}
              </li>
              <li>
                <strong className="text-white">2.</strong>{" "}
                {pick("Chọn nhiều file và kiểm tra ghép cặp.", "选择多个文件并检查配对。")}
              </li>
              <li>
                <strong className="text-white">3.</strong>{" "}
                {pick("Bấm chạy batch rồi xem kết quả.", "运行批处理并查看结果。")}
              </li>
            </ol>
          </div>
          <div className="flex flex-wrap gap-2">
            <label className="cursor-pointer rounded-xl bg-indigo-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-400">
              {pick("Chọn nhiều audio", "选择多个音频")}
              <input
                type="file"
                accept="audio/*"
                multiple
                className="sr-only"
                onChange={chooseBatchAudio}
                disabled={sentences.length === 0 || isRecording || isBusy}
              />
            </label>
            <button
              type="button"
              onClick={pairBatchAudioByOrder}
              disabled={batchAudio.length === 0 || isBusy}
              className="rounded-xl border border-cyan-300/30 bg-cyan-300/10 px-4 py-2.5 text-sm font-semibold text-cyan-100 disabled:opacity-50"
            >
              {pick("Ghép theo thứ tự", "按顺序配对")}
            </button>
            <button
              type="button"
              onClick={() => setBatchAudio([])}
              disabled={batchAudio.length === 0 || isBusy}
              className="rounded-xl border border-white/15 px-4 py-2.5 text-sm font-semibold text-slate-200 disabled:opacity-50"
            >
              {pick("Xóa hàng đợi", "清空队列")}
            </button>
          </div>
        </div>

        <div className="mt-5 flex flex-col gap-3 rounded-2xl border border-white/10 bg-slate-950/60 p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-slate-300" aria-live="polite">
            {batchAudio.length} audio · {batchStats.completed}{" "}
            {pick("hoàn tất", "已完成")} · {batchStats.running}{" "}
            {pick("đang chạy", "运行中")} · {batchStats.failed}{" "}
            {pick("lỗi", "失败")}
            {batchStats.unassigned > 0
              ? ` · ${batchStats.unassigned} ${pick("chưa ghép câu", "未配对")}`
              : ""}
          </p>
          {isBatchProcessing ? (
            <button
              type="button"
              onClick={stopBatchAudio}
              className="rounded-xl bg-rose-500 px-4 py-2 text-sm font-semibold text-white"
            >
              {pick("Dừng batch", "停止批处理")}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void runBatchAudio()}
              disabled={
                batchAudio.length === 0 ||
                batchStats.unassigned > 0 ||
                batchStats.pending + batchStats.failed === 0 ||
                isProcessing
              }
              className="rounded-xl bg-emerald-500 px-5 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50"
            >
              {pick(
                `Chạy ${batchStats.pending + batchStats.failed} audio`,
                `运行 ${batchStats.pending + batchStats.failed} 个音频`,
              )}
            </button>
          )}
        </div>

        {batchAudio.length === 0 ? (
          <p className="mt-4 rounded-2xl border border-dashed border-white/15 p-6 text-center text-sm text-slate-400">
            {pick(
              "Sau khi nạp danh sách câu, chọn tất cả file audio trong một lần.",
              "载入句子列表后，一次选择所有音频文件。",
            )}
          </p>
        ) : (
          <div className="mt-4 max-h-[34rem] space-y-3 overflow-y-auto pr-1">
            {batchAudio.map((item, index) => (
              <div
                key={item.id}
                className={`grid gap-3 rounded-2xl border p-4 [content-visibility:auto] lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_auto] lg:items-center ${
                  item.sentenceIndex === null
                    ? "border-amber-400/35 bg-amber-400/5"
                    : "border-white/10 bg-slate-950/70"
                }`}
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-white">
                    {index + 1}. {item.file.name}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {(item.file.size / 1024).toFixed(1)} KB
                  </p>
                </div>
                <label className="text-xs text-slate-400">
                  {pick("Câu tương ứng", "对应句子")}
                  <select
                    value={item.sentenceIndex ?? ""}
                    onChange={(event) =>
                      setBatchSentence(item.id, event.target.value)
                    }
                    disabled={isBatchProcessing || item.status === "completed"}
                    className="mt-1 block w-full rounded-xl border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white disabled:opacity-60"
                  >
                    <option value="">
                      {pick("— Chọn câu —", "— 选择句子 —")}
                    </option>
                    {sentences.map((sentence, sentenceIndex) => (
                      <option
                        key={`${sentenceIndex}-${sentence}`}
                        value={sentenceIndex}
                      >
                        {sentenceIndex + 1}. {sentence}
                      </option>
                    ))}
                  </select>
                  {item.error ? (
                    <span className="mt-1 block text-rose-300">{item.error}</span>
                  ) : null}
                  <span
                    className={`mt-1 block ${
                      item.mappingSource === null
                        ? "text-amber-300"
                        : "text-slate-500"
                    }`}
                  >
                    {item.mappingSource === "filename"
                      ? pick(
                          "Tự ghép theo số ở đầu tên file",
                          "根据文件名前缀编号自动配对",
                        )
                      : item.mappingSource === "manual"
                        ? pick("Bạn đã chọn thủ công", "已手动选择")
                        : item.mappingSource === "order"
                          ? pick(
                              "Ghép theo thứ tự hiển thị",
                              "按显示顺序配对",
                            )
                          : pick(
                              "Chưa ghép — cần chọn câu",
                              "未配对 — 需要选择句子",
                            )}
                  </span>
                </label>
                <div className="flex items-center justify-between gap-3 lg:justify-end">
                  <span
                    className={`rounded-full border px-3 py-1 text-xs font-semibold ${
                      item.status === "completed"
                        ? "border-emerald-400/30 text-emerald-200"
                        : item.status === "failed"
                          ? "border-rose-400/30 text-rose-200"
                          : item.status === "running"
                            ? "border-cyan-400/30 text-cyan-200"
                            : "border-white/15 text-slate-300"
                    }`}
                  >
                    {item.status === "completed"
                      ? pick("Xong", "完成")
                      : item.status === "failed"
                        ? pick("Lỗi", "失败")
                        : item.status === "running"
                          ? pick("Đang chạy", "运行中")
                          : pick("Chờ", "等待")}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeBatchAudio(item.id)}
                    disabled={isBatchProcessing}
                    className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-300 disabled:opacity-50"
                    aria-label={pick(
                      `Xóa ${item.file.name}`,
                      `删除 ${item.file.name}`,
                    )}
                  >
                    {pick("Xóa", "删除")}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        <p className="mt-4 text-xs leading-5 text-slate-500">
          {pick(
            "An toàn nhất: đặt tên 01_ten-file.wav, 02_ten-file.wav… để số đầu tên khớp số câu. File không có số sẽ không được tự ghép. Bạn vẫn có thể chọn thủ công hoặc chủ động ghép theo thứ tự. Khi chạy, trình duyệt chỉ xử lý tối đa 2 file song song.",
            "最安全的方式：将文件命名为 01_name.wav、02_name.wav…，使文件名前缀编号与句子编号一致。没有编号的文件不会自动配对；您仍可手动选择或主动按顺序配对。运行时最多同时处理 2 个文件。",
          )}
        </p>
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
