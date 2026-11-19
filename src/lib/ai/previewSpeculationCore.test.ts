import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationRequest, ConversationResponse } from "@/types/conversation";
import {
  createPreviewSpeculation,
  previewSpeculationConfig,
  type PreviewSpeculationDeps,
  type SpeculationConfig,
  type SpeculationStore,
} from "./previewSpeculationCore";

/** In-memory Redis with the same TTL semantics, on a fake clock. */
function memoryStore(clock: { now: number }) {
  const entries = new Map<string, { value: string; expiresAt: number }>();
  const live = (key: string) => {
    const entry = entries.get(key);
    if (entry && entry.expiresAt <= clock.now) entries.delete(key);
    return entries.get(key);
  };
  const store: SpeculationStore = {
    async get(key) { return live(key)?.value ?? null; },
    async set(key, value, ttlMs) { entries.set(key, { value, expiresAt: clock.now + ttlMs }); },
    async setIfAbsent(key, value, ttlMs) {
      if (live(key)) return false;
      entries.set(key, { value, expiresAt: clock.now + ttlMs });
      return true;
    },
    async replaceIf(key, expected, value, ttlMs) {
      if (live(key)?.value !== expected) return false;
      entries.set(key, { value, expiresAt: clock.now + ttlMs });
      return true;
    },
  };
  return { store, entries };
}

function fakeResult(input: ConversationRequest): ConversationResponse {
  return {
    requestId: input.requestId,
    clientId: input.clientId,
    conversationId: "conv_speculative",
    sessionId: "sess_speculative",
    context: input.context,
    vietnameseText: input.sourceText ?? "",
    englishText: input.targetLanguage === "en" ? `EN(${input.sourceText})` : "",
    targetLanguage: input.targetLanguage,
    translatedText: input.targetLanguage === "en" ? undefined : `${input.targetLanguage}(${input.sourceText})`,
    audioUrl: "/api/audio/stream?node=3001&text=x",
    promptVersion: "test",
    processingMode: "ai",
    textSource: "deepinfra",
    audioSource: "cache",
    asrMode: input.asrMode ?? "android_streaming",
    latency: { asrMs: 0, llmMs: 900, ttsMs: 300, timeToFirstAudioMs: 1200 },
  };
}

type Harness = ReturnType<typeof harness>;

function harness(overrides: Partial<PreviewSpeculationDeps> = {}, settings: Partial<SpeculationConfig> = {}) {
  const clock = { now: 1_000_000 };
  const { store, entries } = memoryStore(clock);
  const pipelineCalls: ConversationRequest[] = [];
  const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const config: SpeculationConfig = { enabled: true, debounceMs: 0, maxWaitMs: 2_500, maxConcurrent: 8, pollMs: 40, ...settings };
  let ids = 0;
  const deps: PreviewSpeculationDeps = {
    store,
    runPipeline: async (input) => { pipelineCalls.push(input); return fakeResult(input); },
    transcribe: async (input) => input.sourceText?.trim() ?? "",
    config: () => config,
    isLoadTestClient: (clientId) => clientId.startsWith("web_k6_"),
    log: (_level, event, fields) => { events.push({ event, fields }); },
    flights: new Map(),
    // Sleeping advances the fake clock, so waits never take real time.
    sleep: async (ms) => { clock.now += ms; },
    now: () => clock.now,
    createId: (prefix) => `${prefix}_final${++ids}`,
    ...overrides,
  };
  return { speculation: createPreviewSpeculation(deps), deps, clock, store, entries, pipelineCalls, events, config };
}

const preview = (text: string, extra: Record<string, unknown> = {}) => ({
  requestId: "req_preview", clientId: "ios_test", context: "home" as const, childAge: 8,
  sourceText: text, targetLanguage: "en" as const, ...extra,
});

const finalTurn = (text: string, extra: Partial<ConversationRequest> = {}) => ({
  requestId: "req_final", clientId: "ios_test", context: "home" as const, childAge: 8,
  targetLanguage: "en" as const, sourceText: text, asrMode: "android_streaming" as const,
  benchmark: { device: "mobile" as const, utteranceDurationMs: 2_000 }, ...extra,
});

const eventNames = (h: Harness) => h.events.map((entry) => entry.event);
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("the final turn reuses the translation started from its last preview", async () => {
  const h = harness();
  await h.speculation.speculate(preview("Bông hoa"));

  const result = await h.speculation.takeForTurn(finalTurn("Bông hoa"));

  assert.equal(h.pipelineCalls.length, 1);
  assert.equal(h.pipelineCalls[0].sourceText, "Bông hoa");
  assert.equal(result?.englishText, "EN(Bông hoa)");
  // Per-request fields come from the final request, never from the speculation.
  assert.equal(result?.requestId, "req_final");
  assert.match(result?.conversationId ?? "", /^conv_final\d+$/);
  assert.match(result?.sessionId ?? "", /^sess_final\d+$/);
  assert.equal(result?.benchmark?.utteranceDurationMs, 2_000);
  assert.equal(result?.benchmark?.previewSpeculationUsed, true);
  assert.ok(eventNames(h).includes("preview_speculation_used"));
});

test("a turn already answered is not answered again by its speculation", async () => {
  const h = harness();
  await h.speculation.speculate(preview("Hoa"));
  assert.ok(await h.speculation.takeForTurn(finalTurn("Hoa")));

  assert.equal(await h.speculation.takeForTurn(finalTurn("Hoa")), null);
});

test("a newer preview supersedes an older one that is still settling", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const h = harness({ sleep: async () => { await gate; } }, { debounceMs: 400 });

  const first = h.speculation.speculate(preview("Bây giờ tôi mệt quá"));
  const second = h.speculation.speculate(preview("Bây giờ tôi mệt quá tôi muốn đi ngủ"));
  await tick();
  release();
  await Promise.all([first, second]);

  assert.deepEqual(h.pipelineCalls.map((call) => call.sourceText), ["Bây giờ tôi mệt quá tôi muốn đi ngủ"]);
  assert.ok(h.events.some((entry) => entry.fields.reason === "superseded"));
});

test("the final request on another backend waits for a speculation that is still running", async () => {
  const h = harness();
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  const previewBackend = createPreviewSpeculation({
    ...h.deps,
    flights: new Map(),
    runPipeline: async (input) => { await finished; return fakeResult(input); },
  });
  // The final request lands on a backend that has no local flight for this turn.
  let polls = 0;
  const finalBackend = createPreviewSpeculation({
    ...h.deps,
    flights: new Map(),
    sleep: async (ms) => {
      h.clock.now += ms;
      if (++polls === 3) finish();
      await tick();
    },
  });

  const running = previewBackend.speculate(preview("Đau bụng"));
  await tick();
  const result = await finalBackend.takeForTurn(finalTurn("Đau bụng"));
  await running;

  assert.equal(result?.englishText, "EN(Đau bụng)");
  assert.ok(polls >= 3);
  assert.equal(h.events.find((entry) => entry.event === "preview_speculation_used")?.fields.origin, "shared");
});

test("the final request stops waiting after maxWaitMs and runs its own pipeline", async () => {
  const h = harness({}, { maxWaitMs: 200 });
  const never = new Promise<ConversationResponse>(() => undefined);
  const previewBackend = createPreviewSpeculation({ ...h.deps, flights: new Map(), runPipeline: () => never });
  void previewBackend.speculate(preview("Máy tính"));
  await tick();

  const startedAt = h.clock.now;
  const result = await h.speculation.takeForTurn(finalTurn("Máy tính"));

  assert.equal(result, null);
  assert.ok(h.clock.now - startedAt >= 200 && h.clock.now - startedAt < 300);
  assert.ok(h.events.some((entry) => entry.fields.reason === "wait_timeout"));
});

test("a local flight that outlives maxWaitMs is a miss too", async () => {
  const never = new Promise<ConversationResponse>(() => undefined);
  const h = harness({ runPipeline: () => never }, { maxWaitMs: 200 });
  void h.speculation.speculate(preview("Máy tính"));
  await tick();

  assert.equal(await h.speculation.takeForTurn(finalTurn("Máy tính")), null);
  assert.ok(h.events.some((entry) => entry.fields.reason === "wait_timeout"));
});

test("a different final transcript is a miss and later previews of that turn are not run", async () => {
  const h = harness();
  await h.speculation.speculate(preview("Bông"));

  assert.equal(await h.speculation.takeForTurn(finalTurn("Bông hoa")), null);
  // A preview trailing the final request (same text) must not start more work.
  await h.speculation.speculate(preview("Bông hoa"));

  assert.deepEqual(h.pipelineCalls.map((call) => call.sourceText), ["Bông"]);
});

test("the same sentence said again a few seconds later gets a new head start", async () => {
  const h = harness();
  await h.speculation.speculate(preview("Hoa"));
  assert.ok(await h.speculation.takeForTurn(finalTurn("Hoa")));

  h.clock.now += 10_000;
  await h.speculation.speculate(preview("Hoa"));
  assert.ok(await h.speculation.takeForTurn(finalTurn("Hoa")));
  assert.equal(h.pipelineCalls.length, 2);
});

test("a repaired or re-punctuated final transcript never reuses the speculation", async () => {
  const h = harness({ transcribe: async () => "Hoa hồng" });
  await h.speculation.speculate(preview("Hoa"));

  assert.equal(await h.speculation.takeForTurn(finalTurn("Hoa")), null);
  assert.ok(h.events.some((entry) => entry.fields.reason === "transcript_changed"));
});

test("transcript validation errors still reach the caller", async () => {
  const h = harness({ transcribe: async () => { throw new Error("ASR_LOW_CONFIDENCE"); } });
  await h.speculation.speculate(preview("Hoa"));

  await assert.rejects(h.speculation.takeForTurn(finalTurn("Hoa")), /ASR_LOW_CONFIDENCE/);
});

test("previews without a target language use the language of the client's last final turn", async () => {
  const h = harness();
  await h.speculation.speculate(preview("Hoa", { targetLanguage: undefined }));
  assert.equal(h.pipelineCalls.length, 0);

  await h.speculation.takeForTurn(finalTurn("Nước cam", { targetLanguage: "zh" }));
  h.clock.now += 5_000;
  await h.speculation.speculate(preview("Bông hoa", { targetLanguage: undefined }));
  const result = await h.speculation.takeForTurn(finalTurn("Bông hoa", { targetLanguage: "zh" }));

  assert.equal(h.pipelineCalls.at(-1)?.targetLanguage, "zh");
  assert.equal(result?.translatedText, "zh(Bông hoa)");
});

test("a speculation in another language, context or age is never reused", async () => {
  const h = harness();
  await h.speculation.speculate(preview("Hoa"));
  assert.equal(await h.speculation.takeForTurn(finalTurn("Hoa", { targetLanguage: "ja" })), null);

  await h.speculation.speculate(preview("Hoa", { context: "school" }));
  assert.equal(await h.speculation.takeForTurn(finalTurn("Hoa", { childAge: 9, context: "school" })), null);
});

test("a failed speculation lets the final request run its own pipeline without waiting", async () => {
  const h = harness({ runPipeline: async () => { throw new Error("LLM_FAILED"); } });
  await h.speculation.speculate(preview("Hoa"));

  assert.equal(await h.speculation.takeForTurn(finalTurn("Hoa")), null);
  assert.ok(eventNames(h).includes("preview_speculation_failed"));
  // Not a timeout: the failed flight settled at once.
  assert.equal(h.events.find((entry) => entry.event === "preview_speculation_missed")?.fields.reason, "no_speculation");
});

test("store errors fail open", async () => {
  const broken: SpeculationStore = {
    get: async () => { throw new Error("cache_unavailable"); },
    set: async () => { throw new Error("cache_unavailable"); },
    setIfAbsent: async () => { throw new Error("cache_unavailable"); },
    replaceIf: async () => { throw new Error("cache_unavailable"); },
  };
  const h = harness({ store: broken });

  await h.speculation.speculate(preview("Hoa"));
  assert.equal(await h.speculation.takeForTurn(finalTurn("Hoa")), null);
  assert.equal(h.pipelineCalls.length, 0);
});

test("disabled config, load-test clients and audio turns never speculate", async () => {
  const disabled = harness({}, { enabled: false });
  await disabled.speculation.speculate(preview("Hoa"));
  assert.equal(await disabled.speculation.takeForTurn(finalTurn("Hoa")), null);
  assert.equal(disabled.pipelineCalls.length, 0);

  const loadTest = harness();
  await loadTest.speculation.speculate(preview("Hoa", { clientId: "web_k6_abc" }));
  assert.equal(loadTest.pipelineCalls.length, 0);

  const audio = harness();
  await audio.speculation.speculate(preview("Hoa"));
  const audioFile = new File([new Uint8Array(4)], "turn.wav");
  assert.equal(await audio.speculation.takeForTurn(finalTurn("Hoa", { audioFile })), null);
});

test("config reads the flag and clamps the timings", () => {
  assert.deepEqual(previewSpeculationConfig({}), { enabled: false, debounceMs: 400, maxWaitMs: 2_500, maxConcurrent: 8, pollMs: 40 });
  const config = previewSpeculationConfig({
    AUDIO_PREVIEW_SPECULATION_ENABLED: " TRUE ",
    AUDIO_PREVIEW_SPECULATION_DEBOUNCE_MS: "99999",
    AUDIO_PREVIEW_SPECULATION_MAX_WAIT_MS: "-5",
    AUDIO_PREVIEW_SPECULATION_MAX_CONCURRENT: "1000",
  });
  assert.deepEqual(config, { enabled: true, debounceMs: 3_000, maxWaitMs: 0, maxConcurrent: 64, pollMs: 40 });
  assert.equal(previewSpeculationConfig({ AUDIO_PREVIEW_SPECULATION_DEBOUNCE_MS: "abc" }).debounceMs, 400);
});

test("a backend's finished flight is not reused once another backend served that run", async () => {
  const h = harness();
  // Backend A speculates; the final request lands on backend B and uses the result.
  await h.speculation.speculate(preview("Hoa"));
  const backendB = createPreviewSpeculation({ ...h.deps, flights: new Map() });
  assert.ok(await backendB.takeForTurn(finalTurn("Hoa")));

  // The child says it again 5 s later with no new preview; this final lands on A.
  h.clock.now += 5_000;
  assert.equal(await h.speculation.takeForTurn(finalTurn("Hoa")), null);
  assert.ok(h.events.some((entry) => entry.fields.reason === "no_speculation"));
});

test("a run that finishes after the final request gave up never stores its result", async () => {
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  const h = harness({}, { maxWaitMs: 200 });
  const previewBackend = createPreviewSpeculation({
    ...h.deps,
    flights: new Map(),
    runPipeline: async (input) => { await finished; return fakeResult(input); },
  });
  const running = previewBackend.speculate(preview("Máy tính"));
  await tick();
  assert.equal(await h.speculation.takeForTurn(finalTurn("Máy tính")), null);

  finish();
  await running;

  assert.ok(eventNames(h).includes("preview_speculation_discarded"));
  assert.ok(![...h.entries.values()].some((entry) => entry.value.includes('"state":"ready"')));
});

test("two racing final requests for one run: only one gets the result", async () => {
  const h = harness();
  await h.speculation.speculate(preview("Hoa"));
  const other = createPreviewSpeculation({ ...h.deps, flights: new Map() });

  const results = await Promise.all([
    h.speculation.takeForTurn(finalTurn("Hoa")),
    other.takeForTurn(finalTurn("Hoa")),
  ]);

  assert.equal(results.filter(Boolean).length, 1);
});

test("a stale failed flight on this backend does not hide a valid run stored by another", async () => {
  // Backend A's run of "Hoa" failed and its flight is still remembered locally.
  const h = harness({ runPipeline: async () => { throw new Error("LLM_FAILED"); } });
  await h.speculation.speculate(preview("Hoa"));
  // 5 s later the same words are speculated successfully on backend B.
  h.clock.now += 5_000;
  const backendB = createPreviewSpeculation({ ...h.deps, flights: new Map(), runPipeline: async (input) => fakeResult(input) });
  await backendB.speculate(preview("Hoa"));

  // The final lands on A: Redis, not A's stale flight, decides.
  const result = await h.speculation.takeForTurn(finalTurn("Hoa"));
  assert.equal(result?.englishText, "EN(Hoa)");
});

test("each claim step fails open on its own", async () => {
  for (const broken of ["setIfAbsent", "replaceIf"] as const) {
    const h = harness();
    h.deps.store[broken] = async () => { throw new Error("cache_unavailable"); };
    const speculation = createPreviewSpeculation(h.deps);

    await speculation.speculate(preview("Hoa"));
    assert.equal(await speculation.takeForTurn(finalTurn("Hoa")), null, broken);
    assert.ok(h.events.some((entry) => entry.event === "preview_speculation_store_failed"), broken);
  }
});

test("a synchronous pipeline throw is a failed run, not a stuck pending turn", async () => {
  const h = harness({ runPipeline: () => { throw new Error("boom"); } });
  await h.speculation.speculate(preview("Hoa"));
  const other = createPreviewSpeculation({ ...h.deps, flights: new Map() });
  const startedAt = h.clock.now;

  assert.equal(await other.takeForTurn(finalTurn("Hoa")), null);
  assert.equal(h.clock.now, startedAt, "the final request did not poll for a pending run");
  assert.ok(eventNames(h).includes("preview_speculation_failed"));
});

test("no more than maxConcurrent speculative runs at once on one backend", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started = 0;
  const h = harness({ runPipeline: async (input) => { started += 1; await gate; return fakeResult(input); } }, { maxConcurrent: 2 });

  const runs = ["a", "b", "c"].map((id) => h.speculation.speculate(preview("Hoa", { clientId: `ios_${id}` })));
  await tick();
  await tick();
  assert.equal(started, 2);
  release();
  await Promise.all(runs);
  assert.ok(h.events.some((entry) => entry.fields.reason === "busy"));
});

test("typed text turns never touch the speculation store", async () => {
  const h = harness();
  let calls = 0;
  for (const method of ["get", "set", "setIfAbsent", "replaceIf"] as const) {
    const original = h.deps.store[method] as (...args: never[]) => Promise<unknown>;
    (h.deps.store as Record<string, unknown>)[method] = (...args: never[]) => { calls += 1; return original(...args); };
  }

  assert.equal(await h.speculation.takeForTurn(finalTurn("Hoa", { asrMode: "text" })), null);
  assert.equal(calls, 0);
});
