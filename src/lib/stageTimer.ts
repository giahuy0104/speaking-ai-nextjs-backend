/**
 * Measures how long a request spends in each named stage. Time is charged to
 * the stage that was current until the next `enter`, so the per-stage values
 * add up to the elapsed time of the request. A stage entered more than once
 * (e.g. "validation") accumulates.
 */
export type StageTimer = {
  enter(stage: string): void;
  current(): string;
  snapshot(): Record<string, number>;
};

export function createStageTimer(
  initialStage: string,
  now: () => number = () => performance.now(),
): StageTimer {
  const totals = new Map<string, number>();
  let stage = initialStage;
  let stageStartedAt = now();

  function charge(at: number) {
    totals.set(stage, (totals.get(stage) ?? 0) + (at - stageStartedAt));
    stageStartedAt = at;
  }

  return {
    enter(next) {
      if (next === stage) return;
      charge(now());
      stage = next;
    },
    current: () => stage,
    snapshot() {
      const at = now();
      const result: Record<string, number> = {};
      for (const [name, ms] of totals) result[name] = ms;
      result[stage] = (result[stage] ?? 0) + (at - stageStartedAt);
      for (const name of Object.keys(result)) result[name] = Math.round(result[name]);
      return result;
    },
  };
}
