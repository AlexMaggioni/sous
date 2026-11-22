// The pause rule: what a run's saved state, its worker and its open questions mean. One pure
// function, so orc's readers, the worker's end and the service decide the same way.

import type { RunStatus } from "./persistence/run-persistence.js";

/** Why a paused run waits. */
export type PauseReason =
  | "usage_limit" | "auth_required" | "asks" | "requested"
  | "step_failed" | "step_stopped" | "time_limit" | "interrupted" | "other";

/** What a reader sees. RunStatus is the one the state saves. */
export type ViewStatus =
  | "not started" | "starting" | "pending" | "running" | "asks"
  | "paused" | "interrupted" | "completed" | "failed" | "stopped";

export interface RunPause {
  reason: PauseReason;
  /** The saved text when reason is "other". */
  text?: string;
  /** When the provider's limit resets. usage_limit only. */
  resetAt?: Date;
  /** When the service resumes the run by itself. Unset: a person must resume it. */
  resumeAt?: Date;
}

export interface RunFacts {
  state?: { status: RunStatus; pauseReason?: string; resetAt?: string; resetHint?: string; updatedAt: string };
  /** The worker's pid is alive. The worker judges its own run at its end with false. */
  alive: boolean;
  openQuestions: number;
}

/** Why resume or reuse says no. */
export type ResumeRefusal = "running" | "never-started" | "completed" | "stopped";
export type ReuseRefusal = "running" | "paused";

export interface Verdict {
  status: ViewStatus;
  /** What orc list prints, such as "paused: limit". */
  word: string;
  /** The exit code of orc wait when it stops: at open questions, or once the worker is gone. */
  exit?: number;
  /** A worker runs it, or it waits to go on. */
  unfinished: boolean;
  /** Set when the saved state is paused, whatever the worker and the questions. */
  pause?: RunPause;
  resume: { ok: true } | { ok: false; why: ResumeRefusal };
  reuse: { ok: true } | { ok: false; why: ReuseRefusal };
}

/** The service resumes a run this long after its limit resets. */
const RESET_MARGIN_MS = 30_000;
/** With no reset time, the service tries again this long after the pause. */
const NO_HINT_WAIT_MS = 30 * 60 * 1000;

const OK = { ok: true } as const;
const no = <Why extends string>(why: Why) => ({ ok: false, why }) as const;

interface Row {
  /** "alive": the row needs a live worker. "gone": a dead one. "any": either. */
  worker: "alive" | "gone" | "any";
  status: ViewStatus;
  /** "<text>" stands for the saved pause reason. */
  word: string;
  exit?: number;
  unfinished: boolean;
  /** What the saved pause reason means. Paused rows only. */
  pause?: PauseReason;
  resume: Verdict["resume"];
  reuse: Verdict["reuse"];
}

/**
 * What a run's facts mean, one row per case. The answers of an "any" row are for a gone worker.
 * A live worker on such a row still runs or ends the run, so judge holds the wait, resume and
 * reuse for it.
 */
const ROWS = {
  "asks":                        { worker: "alive", status: "asks",        word: "asks",                  exit: 4, unfinished: true,  resume: no("running"),       reuse: no("running") },
  "starting":                    { worker: "alive", status: "starting",    word: "starting",                       unfinished: true,  resume: no("running"),       reuse: no("running") },
  "not started":                 { worker: "gone",  status: "not started", word: "not started",           exit: 1, unfinished: true,  resume: no("never-started"), reuse: OK },
  "pending":                     { worker: "any",   status: "pending",     word: "pending",               exit: 1, unfinished: true,  resume: OK,                  reuse: no("running") },
  "running":                     { worker: "alive", status: "running",     word: "running",                        unfinished: true,  resume: no("running"),       reuse: no("running") },
  "running, worker gone":        { worker: "gone",  status: "interrupted", word: "interrupted",           exit: 1, unfinished: true,  resume: OK,                  reuse: no("running") },
  "paused, usage_limit":         { worker: "any",   status: "paused",      word: "paused: limit",         exit: 2, unfinished: true,  pause: "usage_limit",   resume: OK, reuse: no("paused") },
  "paused, auth_required":       { worker: "any",   status: "paused",      word: "paused: auth_required", exit: 2, unfinished: true,  pause: "auth_required", resume: OK, reuse: no("paused") },
  "paused, checkpoint_required": { worker: "any",   status: "paused",      word: "paused: asks",          exit: 2, unfinished: true,  pause: "asks",          resume: OK, reuse: no("paused") },
  "paused, requested":           { worker: "any",   status: "paused",      word: "paused",                exit: 2, unfinished: true,  pause: "requested",     resume: OK, reuse: no("paused") },
  "paused, step_failed":         { worker: "any",   status: "paused",      word: "paused: failed step",   exit: 2, unfinished: true,  pause: "step_failed",   resume: OK, reuse: no("paused") },
  "paused, step_stopped":        { worker: "any",   status: "paused",      word: "paused: stopped step",  exit: 2, unfinished: true,  pause: "step_stopped",  resume: OK, reuse: no("paused") },
  "paused, time_limit":          { worker: "any",   status: "paused",      word: "paused: time limit",    exit: 2, unfinished: true,  pause: "time_limit",    resume: OK, reuse: no("paused") },
  "paused, interrupted":         { worker: "any",   status: "interrupted", word: "interrupted",           exit: 2, unfinished: true,  pause: "interrupted",   resume: OK, reuse: no("paused") },
  "paused, other text":          { worker: "any",   status: "paused",      word: "paused: <text>",        exit: 2, unfinished: true,  pause: "other",         resume: OK, reuse: no("paused") },
  "completed":                   { worker: "any",   status: "completed",   word: "completed",             exit: 0, unfinished: false, resume: no("completed"),     reuse: OK },
  "failed":                      { worker: "any",   status: "failed",      word: "failed",                exit: 1, unfinished: false, resume: OK,                  reuse: OK },
  "aborted":                     { worker: "any",   status: "stopped",     word: "stopped",               exit: 3, unfinished: false, resume: no("stopped"),       reuse: OK },
} satisfies Record<string, Row>;

type Key = keyof typeof ROWS;

/** A live worker on a saved state. orc wait goes on, and resume and reuse refuse. */
const WORKER_RUNS: Pick<Row, "exit" | "unfinished" | "resume" | "reuse"> = { unfinished: true, resume: no("running"), reuse: no("running") };

/** What the facts mean. */
export function judge(facts: RunFacts): Verdict {
  const row: Row = ROWS[keyOf(facts)];
  const pause = pauseOf(facts.state);
  const word = row.word.replace("<text>", () => facts.state?.pauseReason ?? "?");
  const { exit, unfinished, resume, reuse } = facts.alive && row.worker === "any" ? WORKER_RUNS : row;
  return { status: row.status, word, ...(exit === undefined ? {} : { exit }), unfinished, ...(pause ? { pause } : {}), resume, reuse };
}

function keyOf({ state, alive, openQuestions }: RunFacts): Key {
  if (alive && openQuestions > 0) return "asks";
  if (!state) return alive ? "starting" : "not started";
  if (state.status === "running") return alive ? "running" : "running, worker gone";
  if (state.status === "paused") return pausedKey(state.pauseReason);
  return state.status;
}

/** The row of a paused state. A reason the table does not name is "other text". */
function pausedKey(reason: string | undefined): Key {
  const key = `paused, ${reason}`;
  return Object.hasOwn(ROWS, key) ? (key as Key) : "paused, other text";
}

/** The pause of a paused state. It reads the state alone. */
function pauseOf(state: RunFacts["state"]): RunPause | undefined {
  if (state?.status !== "paused") return undefined;
  const reason = (ROWS[pausedKey(state.pauseReason)] as Row).pause!;
  if (reason === "other") return { reason, ...(state.pauseReason === undefined ? {} : { text: state.pauseReason }) };
  if (reason !== "usage_limit") return { reason };
  const typed = state.resetAt === undefined ? Number.NaN : Date.parse(state.resetAt);
  const resetAt = Number.isFinite(typed) ? new Date(typed) : parseResetHint(state.resetHint, state.updatedAt);
  const resumeAt = new Date(resetAt ? resetAt.getTime() + RESET_MARGIN_MS : Date.parse(state.updatedAt) + NO_HINT_WAIT_MS);
  return { reason, ...(resetAt ? { resetAt } : {}), resumeAt };
}

/** The reset time in today's two text forms, for states saved before resetAt existed. "in ~2h"
 *  counts from the pause. */
export function parseResetHint(hint: string | undefined, pausedAt: string): Date | undefined {
  const at = hint ? /Resets at (\S+)/.exec(hint) : null;
  const time = at ? Date.parse(at[1]!) : Number.NaN;
  if (Number.isFinite(time)) return new Date(time);
  const hours = hint ? /in ~?(\d+(?:\.\d+)?)\s*h/i.exec(hint) : null;
  if (hours) return new Date(Date.parse(pausedAt) + Number(hours[1]) * 3600_000);
  return undefined;
}
