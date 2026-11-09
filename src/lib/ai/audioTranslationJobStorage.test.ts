import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type RequestListener } from "node:http";
import { test, type TestContext } from "node:test";
import { S3Client } from "@aws-sdk/client-s3";
import { loadJobAudio, removeJobAudio, type JobAudio } from "./audioTranslationJobStorage";

const r2Global = globalThis as typeof globalThis & { __aiSpeakingR2Client?: S3Client };
const environment = ["CLOUDFLARE_R2_ACCOUNT_ID", "CLOUDFLARE_R2_ACCESS_KEY_ID", "CLOUDFLARE_R2_SECRET_ACCESS_KEY", "CLOUDFLARE_R2_BUCKET"] as const;
const content = Buffer.from("disposable job audio");
const sha256 = createHash("sha256").update(content).digest("hex");
function audio(id: string): JobAudio {
  return { key: `${id.repeat(64)}-${sha256}.bin`, sha256, bytes: content.length, name: "speech.wav", mime: "audio/wav", backend: "r2" };
}

async function r2Server(t: TestContext, handler: RequestListener) {
  const saved = environment.map(key => [key, process.env[key]] as const);
  const originalClient = r2Global.__aiSpeakingR2Client;
  process.env.CLOUDFLARE_R2_ACCOUNT_ID = "test-account";
  process.env.CLOUDFLARE_R2_ACCESS_KEY_ID = "test-access";
  process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY = "test-secret";
  process.env.CLOUDFLARE_R2_BUCKET = "test-bucket";
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new S3Client({
    region: "auto", endpoint: `http://127.0.0.1:${address.port}`, forcePathStyle: true, maxAttempts: 1,
    credentials: { accessKeyId: "test-access", secretAccessKey: "test-secret" },
  });
  r2Global.__aiSpeakingR2Client = client;
  t.after(async () => {
    client.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (originalClient) r2Global.__aiSpeakingR2Client = originalClient;
    else delete r2Global.__aiSpeakingR2Client;
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("job R2 reads preserve integrity checks and completed inputs can be deleted", async t => {
  let deletes = 0;
  let corrupt = false;
  await r2Server(t, (request, response) => {
    if (request.method === "GET") {
      response.end(corrupt ? Buffer.alloc(content.length) : content);
    } else {
      deletes++;
      response.setHeader("content-type", "application/xml");
      response.end('<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"/>');
    }
  });
  const stored = audio("a");
  const loaded = await loadJobAudio(stored);
  assert.deepEqual(Buffer.from(await loaded.arrayBuffer()), content);
  assert.equal(loaded.type, "audio/wav");
  corrupt = true;
  await assert.rejects(loadJobAudio(stored), /job_audio_integrity/);
  await removeJobAudio(stored);
  assert.equal(deletes, 1);
});

test("job R2 deadlines abort stalled headers, response bodies and deletes", { timeout: 12_000 }, async t => {
  const requested = new Set<string>();
  let closed = 0;
  await r2Server(t, (request, response) => {
    response.once("close", () => { closed++; });
    if (request.method === "POST") {
      requested.add("delete");
      return;
    }
    if (request.url?.includes(audio("b").key)) {
      requested.add("body");
      response.writeHead(200, { "content-type": "application/octet-stream", "content-length": content.length });
      response.write(content.subarray(0, 1));
      return;
    }
    requested.add("headers");
  });
  const startedAt = Date.now();
  const results = await Promise.allSettled([loadJobAudio(audio("a")), loadJobAudio(audio("b")), removeJobAudio(audio("c"))]);
  assert.deepEqual([...requested].sort(), ["body", "delete", "headers"]);
  assert.ok(results.every(result => result.status === "rejected"), "all stalled operations must abort");
  assert.ok(Date.now() - startedAt < 8_000, "storage must stop within its five-second deadline");
  // Abort must close the HTTP operations, so a timed-out read cannot retain a worker socket.
  for (let i = 0; closed < 3 && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(closed, 3);
});
