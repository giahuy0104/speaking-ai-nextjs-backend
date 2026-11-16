import assert from "node:assert/strict";
import test from "node:test";
import { createStageTimer } from "./stageTimer";

function fakeClock(start = 0) {
  let value = start;
  return { now: () => value, advance: (ms: number) => { value += ms; } };
}

test("charges elapsed time to the stage that was current", () => {
  const clock = fakeClock();
  const timer = createStageTimer("upload", clock.now);
  clock.advance(120);
  timer.enter("authentication");
  clock.advance(35);
  timer.enter("asr");
  clock.advance(2_000);

  assert.deepEqual(timer.snapshot(), { upload: 120, authentication: 35, asr: 2_000 });
  assert.equal(timer.current(), "asr");
});

test("a stage entered twice accumulates and re-entering the current stage is a no-op", () => {
  const clock = fakeClock();
  const timer = createStageTimer("validation", clock.now);
  clock.advance(5);
  timer.enter("validation");
  clock.advance(5);
  timer.enter("upload");
  clock.advance(10);
  timer.enter("validation");
  clock.advance(2.4);

  assert.deepEqual(timer.snapshot(), { validation: 12, upload: 10 });
});

test("snapshot does not change the running stage", () => {
  const clock = fakeClock();
  const timer = createStageTimer("asr", clock.now);
  clock.advance(10);
  timer.snapshot();
  clock.advance(10);

  assert.deepEqual(timer.snapshot(), { asr: 20 });
});
