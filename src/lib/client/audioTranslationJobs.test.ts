import assert from "node:assert/strict";
import test from "node:test";
import { translateAudioWithJobs } from "./audioTranslationJobs";

test("client posts once, follows job states, and returns the completed translation", async () => {
  const original = globalThis.fetch;
  const id = "a".repeat(64); const methods: string[] = []; const states: string[] = [];
  globalThis.fetch = async (_url, init) => {
    methods.push(init?.method || "GET");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-token");
    if (methods.length === 1) return Response.json({ jobId: id, status: "queued", statusUrl: `/api/audio/jobs/${id}`, nextPollMs: 1 }, { status: 202 });
    if (methods.length === 2) return Response.json({ status: "running", nextPollMs: 1 });
    return Response.json({ status: "completed", result: { targetLanguage: "en", englishText: "Hello." } });
  };
  try {
    const result = await translateAudioWithJobs({ audio: new File(["audio"], "speech.wav"), accessToken: "test-token", onJob: job => states.push(job.status) });
    assert.equal(result.englishText, "Hello."); assert.deepEqual(methods, ["POST", "GET", "GET"]); assert.deepEqual(states, ["queued", "running"]);
  } finally { globalThis.fetch = original; }
});

test("client rejects an external status URL before forwarding credentials", async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ jobId: "a".repeat(64), statusUrl: "https://other.example/jobs" }, { status: 202 }); };
  try {
    await assert.rejects(translateAudioWithJobs({ audio: new File(["audio"], "speech.wav"), accessToken: "test-token" }), { status: 502 });
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});
