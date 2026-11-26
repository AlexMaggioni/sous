import { describe, expect, test } from "vitest";
import type { Step } from "../src/api/contract.ts";
import { tickLabel } from "../src/format.ts";
import { barOf, lastMoment, runAxis, stepDuration, ticksOf, type Axis } from "../src/pages/run/time-axis.ts";

const T0 = Date.UTC(2026, 10, 25, 12, 0, 0);
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();
const step = (more: Partial<Step>) => ({ status: "done", startedAt: iso(0), endedAt: iso(4), ...more }) as Step;
const run = (more: { status?: Step["status"]; endedAt?: string; changedAt?: string; steps?: Step[] } = {}) => ({ status: "done" as const, startedAt: iso(0), endedAt: undefined, changedAt: undefined, steps: [], ...more });

describe("the time axis", () => {
  test("an ended run's axis ends at its last moment, with 5 ticks or fewer", () => {
    const axis = runAxis(run({ endedAt: iso(10) }), T0 + 60_000);
    expect(axis).toEqual({ from: T0, end: 10_000, step: 2_000, open: false });
    expect(ticksOf(axis)).toEqual([2_000, 4_000, 6_000, 8_000]);
  });

  test("a running run's axis reaches 15% past now, rounded up to a tick", () => {
    const axis = runAxis(run({ status: "running" }), T0 + 10_000);
    expect(axis).toEqual({ from: T0, end: 15_000, step: 5_000, open: true });
    expect(ticksOf(axis)).toEqual([5_000, 10_000]);
  });

  test("an axis is at least a second long", () => {
    expect(runAxis(run({ endedAt: iso(0) }), T0).end).toBe(1_000);
  });

  test("ticks read 0s, 30s, 1m, 1m 30s and 1h 05m", () => {
    expect([0, 30_000, 60_000, 90_000, 3_900_000].map(tickLabel)).toEqual(["0s", "30s", "1m", "1m 30s", "1h 05m"]);
  });
});

describe("a step's bar", () => {
  const axis: Axis = { from: T0, end: 10_000, step: 2_000, open: false };

  test("sits at its start and runs to its stop, in percent of the axis", () => {
    expect(barOf(axis, T0 + 2_000, T0 + 6_000)).toEqual({ left: 20, width: 40 });
  });

  test("stays inside the axis", () => {
    expect(barOf(axis, T0 - 1_000, T0 + 20_000)).toEqual({ left: 0, width: 100 });
    expect(barOf(axis, T0 + 5_000, T0 + 1_000)).toEqual({ left: 50, width: 0 });
  });

  test("a step that has not started has no bar", () => {
    expect(barOf(axis, undefined, T0 + 1_000)).toBeNull();
    expect(barOf(axis, Number.NaN, T0 + 1_000)).toBeNull();
  });
});

describe("the last moment a run shows", () => {
  test("is now while the run or a step runs", () => {
    expect(lastMoment(run({ status: "running" }), T0 + 9_000)).toBe(T0 + 9_000);
    expect(lastMoment(run({ status: "paused", steps: [step({ status: "running", endedAt: undefined })] }), T0 + 9_000)).toBe(T0 + 9_000);
  });

  test("is the latest time the run has, so a run that waits on the person stops where it asked", () => {
    const waiting = run({ status: "needs", changedAt: iso(6), steps: [step({ endedAt: iso(4) })] });
    expect(lastMoment(waiting, T0 + 60_000)).toBe(T0 + 6_000);
  });
});

describe("how long a step ran", () => {
  test("an ended step keeps its own count", () => {
    expect(stepDuration(step({ durationMs: 500 }), T0 + 60_000)).toBe(500);
  });

  test("an ended step without a count runs from its start to its end", () => {
    expect(stepDuration(step({}), T0 + 60_000)).toBe(4_000);
  });

  test("a live step counts to now, past a stale count", () => {
    expect(stepDuration(step({ status: "running", endedAt: undefined, durationMs: 500 }), T0 + 3_000)).toBe(3_000);
    expect(stepDuration(step({ status: "needs", endedAt: undefined }), T0 + 7_000)).toBe(7_000);
  });

  test("a step that has not started has no length", () => {
    expect(stepDuration(step({ status: "queued", startedAt: undefined, endedAt: undefined }), T0)).toBeUndefined();
  });
});
