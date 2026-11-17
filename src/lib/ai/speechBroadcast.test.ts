import assert from "node:assert/strict";
import { test } from "node:test";
import { createSpeechBroadcast } from "./speechBroadcast";

async function readAll(stream: ReadableStream<Uint8Array>) {
  const parts: number[] = [];
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) parts.push(...chunk);
  return parts;
}

test("early and late listeners both receive the clip from its first byte", async () => {
  const broadcast = createSpeechBroadcast(1024);
  const early = readAll(broadcast.subscribe());
  broadcast.push(new Uint8Array([1, 2]));
  const late = readAll(broadcast.subscribe());
  broadcast.push(new Uint8Array([3]));
  broadcast.finish();

  assert.deepEqual(await early, [1, 2, 3]);
  assert.deepEqual(await late, [1, 2, 3]);
  assert.deepEqual([...new Uint8Array(await broadcast.completed)], [1, 2, 3]);
  assert.equal(broadcast.live(), false);
});

test("a listener that goes away does not stop the producer or the cached clip", async () => {
  const broadcast = createSpeechBroadcast(1024);
  const reader = broadcast.subscribe().getReader();
  broadcast.push(new Uint8Array([7]));
  assert.deepEqual([...(await reader.read()).value!], [7]);
  await reader.cancel();
  broadcast.push(new Uint8Array([8]));
  broadcast.finish();
  assert.deepEqual([...new Uint8Array(await broadcast.completed)], [7, 8]);
});

test("a failure reaches listeners and the completion; an empty or oversized clip fails", async () => {
  const failing = createSpeechBroadcast(1024);
  const listener = readAll(failing.subscribe());
  failing.push(new Uint8Array([1]));
  assert.equal(failing.started(), true);
  failing.fail(new Error("upstream"));
  await assert.rejects(listener, /upstream/);
  await assert.rejects(failing.completed, /upstream/);

  const empty = createSpeechBroadcast(1024);
  empty.finish();
  await assert.rejects(empty.completed, /speech_empty/);

  const oversized = createSpeechBroadcast(2);
  oversized.push(new Uint8Array([1, 2, 3]));
  await assert.rejects(oversized.completed, /speech_too_large/);
  assert.equal(oversized.live(), false);
});
