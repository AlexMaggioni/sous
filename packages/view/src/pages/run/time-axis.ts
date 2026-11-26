// The time axis of the Steps view: where it starts and ends, its ticks, and each step's bar on it.
// Pure, so the tests check it with plain numbers.
import type { RunPage, Step } from "../../api/contract.ts";
import { isLive } from "../../status.ts";

/** Tick steps, in seconds: the first that gives 5 ticks or fewer wins. */
const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200].map((s) => s * 1000);

export interface Axis {
  /** When the run started, in ms since the epoch. Every offset counts from here. */
  from: number;
  /** The length of the axis in ms. */
  end: number;
  /** The space between ticks in ms. */
  step: number;
  /** The run goes on, so the axis leaves room for it to grow. */
  open: boolean;
}

/**
 * An axis from `from` to `to`, at least a second long. An open run's axis reaches 15% past now,
 * rounded up to a tick, so a running bar has room to grow before the ticks change.
 */
function timeAxis(from: number, to: number, open: boolean): Axis {
  const span = Math.max(1000, to - from);
  let end = open ? span * 1.15 : span;
  const step = TICK_STEPS.find((t) => end / t <= 5) ?? TICK_STEPS[TICK_STEPS.length - 1]!;
  if (open) end = Math.ceil(end / step) * step;
  return { from, end, step, open };
}

/** The offsets of the ticks after 0, each a step apart, short of the end. */
export function ticksOf(axis: Axis): number[] {
  const out: number[] = [];
  for (let t = axis.step; t < axis.end - 1; t += axis.step) out.push(t);
  return out;
}

/** A bar's left edge and width, in percent of the axis. */
export interface Bar {
  left: number;
  width: number;
}

const ms = (at: string | undefined) => (at === undefined ? undefined : Date.parse(at));

/** The bar from `start` to `stop`, in ms since the epoch, kept inside the axis. No start, no bar. */
export function barOf(axis: Axis, start: number | undefined, stop: number): Bar | null {
  if (start === undefined || Number.isNaN(start)) return null;
  const left = Math.min(Math.max(0, start - axis.from), axis.end);
  const right = Math.min(Math.max(left, stop - axis.from), axis.end);
  return { left: (left / axis.end) * 100, width: ((right - left) / axis.end) * 100 };
}

/** The parts of a run its times come from. */
export type RunTimes = Pick<RunPage, "status" | "startedAt" | "endedAt" | "changedAt" | "steps">;

/** Whether time moves on the run's axis: the run or one of its steps runs now. A run that waits
 *  on the person moves nothing, so its axis stops where it asked and its bars keep their width. */
const ticking = (run: Pick<RunTimes, "status" | "steps">) => run.status === "running" || run.steps.some((step) => step.status === "running");

/**
 * The last moment the run shows. While it runs, that is now. Otherwise it is the latest time the
 * run has, from its end, its last change and its steps, so a paused run stops where it paused and
 * a run that waits on the person stops where it asked.
 */
export function lastMoment(run: RunTimes, now: number): number {
  if (ticking(run)) return now;
  const times = [run.startedAt, run.endedAt, run.changedAt, ...run.steps.flatMap((s) => [s.startedAt, s.endedAt])].map(ms).filter((t): t is number => t !== undefined && !Number.isNaN(t));
  return Math.max(...times);
}

/** The axis of a run's Steps view. */
export function runAxis(run: RunTimes, now: number): Axis {
  return timeAxis(Date.parse(run.startedAt), lastMoment(run, now), ticking(run));
}

/** How long a step ran: its own count, else from its start to its end, or to `until` while it has no end. */
export function stepDuration(step: Pick<Step, "durationMs" | "startedAt" | "endedAt" | "status">, until: number): number | undefined {
  const start = ms(step.startedAt);
  if (!isLive(step.status) && step.durationMs !== undefined) return step.durationMs;
  if (start === undefined) return undefined;
  return Math.max(0, (ms(step.endedAt) ?? until) - start);
}
