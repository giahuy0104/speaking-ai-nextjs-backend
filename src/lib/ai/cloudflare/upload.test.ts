import assert from "node:assert/strict";
import test from "node:test";
import { readBoundedAudioFormData } from "./upload";
import { clientAbortSignal } from "./abortDiagnostics";
import { getFailureDiagnostics } from "./providerError";

test("valid multipart is preserved including base64-encoded audio parts", async () => {
  const body = '--test\r\nContent-Disposition: form-data; name="audio"; filename="test.wav"\r\nContent-Type: audio/wav\r\nContent-Transfer-Encoding: base64\r\n\r\nYWJj\r\n--test--\r\n';
  const request = new Request("http://localhost/test", { method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=test" }, body });
  const form = await readBoundedAudioFormData(request, 1024, request.signal);
  const audio = form.get("audio") as File;
  assert.equal(await audio.text(), "abc");
});

test("streamed body larger than its reserved byte limit is rejected before provider admission", async () => {
  const data = new FormData(); data.set("audio", new File([new Uint8Array(2048)], "test.wav"));
  const request = new Request("http://localhost/test", { method: "POST", body: data });
  await assert.rejects(readBoundedAudioFormData(request, 1024, request.signal), { status: 413 });
});

test("a stalled upload is cancelled and its reader is released", async () => {
  let cancelled = false;
  const request = new Request("http://localhost/test", { method: "POST",
    headers: { "Content-Type": "multipart/form-data; boundary=test" },
    body: new ReadableStream({ cancel() { cancelled = true; } }), duplex: "half",
  } as RequestInit & { duplex: "half" });
  const controller = new AbortController();
  const parsing = readBoundedAudioFormData(request, 1024, controller.signal);
  controller.abort();
  await assert.rejects(parsing, { reason: "cancelled" });
  assert.equal(cancelled, true);
});

test("a body parser rejection racing client disconnect retains client cancellation provenance", async () => {
  const client = new AbortController(); clientAbortSignal(client.signal);
  // Emulate the body parser rejecting before its withSignal rejection settles.
  const request = { url: "http://localhost/test", headers: new Headers({ "content-type": "multipart/form-data" }),
    body: { getReader() {
      client.abort();
      return { read: async () => ({ done: true, value: undefined }), cancel: async () => {} };
    } } } as unknown as Request;
  await assert.rejects(readBoundedAudioFormData(request, 1024, client.signal), error => {
    assert.equal((error as { reason: string }).reason, "cancelled");
    assert.deepEqual(getFailureDiagnostics(error), { failureSource: "client", abortCause: "client_disconnect" });
    return true;
  });
});

test("an aborted request whose body was detached is not mislabeled as an empty upload", async () => {
  const client = new AbortController(); clientAbortSignal(client.signal); client.abort();
  const request = new Request("http://localhost/test", { method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=test" } });
  await assert.rejects(readBoundedAudioFormData(request, 1024, client.signal), error => {
    assert.equal((error as { status: number }).status, 499);
    assert.deepEqual(getFailureDiagnostics(error), { failureSource: "client", abortCause: "client_disconnect" });
    return true;
  });
});
