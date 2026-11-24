// One step of a run, for sous step, and the run's events after a seq, for sous log --json. Both
// read only: the step from the run's steps and its saved activity, the events from the engine's
// event log, in a small vocabulary.

import { EXEC_MODEL } from "../code-steps.js";
import type { PersistedRunEvent } from "../run-events.js";
import type { HomePaths } from "./home.js";
import { readActivity, type ActivityLine } from "./records.js";
import { Refusal } from "./refusal.js";
import { runDetail } from "./run.js";
import { readEventsAfter } from "./store.js";

/** One call of a step, as sous step shows it. */
export interface StepView {
  runId: string;
  step: string;
  /** Which call of the label this is, from 1, and how many calls it made. */
  call: number;
  calls: number;
  status: string;
  kind: "agent" | "exec";
  model?: string;
  startedAt?: string;
  seconds?: number;
  tokens?: number;
  /** An agent step's prompt, cut to 2,000 characters unless full is asked. */
  prompt?: string;
  result?: unknown;
  /** The step's error, when it failed. */
  failure?: string;
  /** A code step's command and the end of its output. */
  command?: string;
  output?: string;
  /** The last entries of the call's activity, oldest first. */
  activity: ActivityLine[];
  /** How many older entries the tail leaves out. */
  earlier?: number;
  /** Set when the prompt is cut to 2,000 characters. */
  promptCut?: true;
}

/** An event of the run's log, in sous's vocabulary. */
export interface LogEvent {
  seq: number;
  at: string;
  kind: "step-start" | "step-end" | "asks" | "answered" | "paused" | "resumed" | "ended" | "tell" | "note";
  /** Set when the event belongs to a nested run. */
  scope?: string;
  [field: string]: unknown;
}

/** How many activity entries a step shows when no tail is asked. */
const TAIL = 20;
/** The most of a prompt a step shows when full is not asked. */
const PROMPT = 2_000;
/** The most events one logAfter call gives when no max is asked. */
const EVENTS = 100;

/** The most of a failure or a question an event of the log holds. sous step shows the whole failure. */
const EVENT_TEXT = 400;
const brief = (text: string) => (text.length > EVENT_TEXT ? `${text.slice(0, EVENT_TEXT - 3)}...` : text);

const secondsOf = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 1000);

/** A code step's command from its saved prompt, the JSON of its spec, for a run with no activity. */
function specCommand(prompt: string): string | undefined {
  try {
    const spec = JSON.parse(prompt) as { command?: string; source?: string; file?: string };
    return spec.command ?? spec.source ?? spec.file;
  } catch {
    return undefined;
  }
}

/**
 * One call of a step of a run, by its label: the last call, or the one `call` names. A label in a
 * nested run is found when the top-level run has no step with it. Throws no_such_step when the
 * run has no such step or call.
 */
export function stepView(paths: HomePaths, runId: string, label: string, options: { call?: number; tail?: number; full?: boolean } = {}): StepView {
  const detail = runDetail(paths, runId);
  const id = detail.record.runId;
  const top = detail.steps.filter((step) => step.label === label && (step.scope === undefined || step.scope === id));
  const calls = top.length ? top : detail.steps.filter((step) => step.label === label);
  const show = `sous show ${id} --json`;
  if (!calls.length) throw new Refusal("no_such_step", `run ${id} has no step "${label}".`, "Give the label of one of the run's steps, as sous show lists them.", show);
  const number = options.call ?? calls.length;
  const step = calls[number - 1];
  if (!step) throw new Refusal("no_such_step", `step "${label}" of run ${id} made ${calls.length} calls, so it has no call ${number}.`, `Give --call from 1 to ${calls.length}.`, show);

  const scope = step.scope ?? id;
  const all = readActivity(paths, id).filter((line) => line.scope === scope && (step.callIndex === undefined ? line.label === label : line.callIndex === step.callIndex));
  const exec = step.model === EXEC_MODEL;
  const last = (kind: string) => all.filter((line) => line.kind === kind).at(-1)?.text;
  const command = exec ? (last("command") ?? specCommand(step.prompt)) : undefined;
  const output = exec ? last("output") : undefined;
  const prompt = exec ? undefined : options.full || step.prompt.length <= PROMPT ? step.prompt : step.prompt.slice(0, PROMPT);
  const tokens = step.tokens ?? step.usage?.total;
  const tail = Math.max(0, options.tail ?? TAIL);
  const activity = tail ? all.slice(-tail) : [];
  return {
    runId: id,
    step: label,
    call: number,
    calls: calls.length,
    status: step.status,
    kind: exec ? "exec" : "agent",
    ...(exec || !step.model ? {} : { model: step.model }),
    ...(step.startedAt ? { startedAt: step.startedAt } : {}),
    ...(step.startedAt && step.endedAt ? { seconds: secondsOf(step.startedAt, step.endedAt) } : {}),
    ...(tokens ? { tokens } : {}),
    ...(prompt === undefined ? {} : { prompt }),
    ...(step.result === undefined ? {} : { result: step.result }),
    ...(step.error === undefined ? {} : { failure: step.error }),
    ...(command === undefined ? {} : { command }),
    ...(output === undefined ? {} : { output }),
    activity,
    ...(activity.length < all.length ? { earlier: all.length - activity.length } : {}),
    ...(prompt !== undefined && prompt.length < step.prompt.length ? { promptCut: true as const } : {}),
  };
}

/** The event in sous's vocabulary, or undefined for an event the log leaves out. */
function logEvent(runId: string, event: PersistedRunEvent): Omit<LogEvent, "seq" | "at"> | undefined {
  const where = event.scope && event.scope !== runId ? { scope: event.scope } : {};
  switch (event.type) {
    case "agentStart":
      return { kind: "step-start", step: event.label, call: event.callIndex, ...(event.model ? { model: event.model } : {}), ...where };
    case "agentEnd":
      return { kind: "step-end", step: event.label, call: event.callIndex, status: event.error === undefined ? "done" : "error", ...(event.tokens ? { tokens: event.tokens } : {}), ...(event.error === undefined ? {} : { failure: brief(event.error) }), ...where };
    case "paused":
      if (event.reason === "checkpoint_required") return { kind: "asks", ...(event.checkpointContext?.prompt ? { prompt: brief(event.checkpointContext.prompt) } : {}), ...where };
      return { kind: "paused", ...(event.reason ? { reason: event.reason } : {}), ...where };
    case "callRecord":
      return event.record.kind === "checkpoint" && event.record.origin === "confirm" ? { kind: "answered", call: event.record.index, ...where } : undefined;
    case "resumed":
      return { kind: "resumed", ...where };
    case "complete":
      return { kind: "ended", status: "completed", ...where };
    case "stopped":
      return { kind: "ended", status: "stopped", ...where };
    case "error":
      return { kind: "ended", status: "failed", ...(event.errorRecord.message ? { failure: brief(event.errorRecord.message) } : {}), ...where };
    default:
      return undefined;
  }
}

/**
 * The run's events after the seq `after`, oldest first, at most `max` of them. `after` in the
 * answer is the seq of the last event given, or the one asked for when none came, and `more` says
 * whether more events wait. A run with no event log yet gives none.
 */
export function logAfter(paths: HomePaths, runId: string, after: number, max = EVENTS): { events: LogEvent[]; after: number; more: boolean } {
  const events: LogEvent[] = [];
  try {
    readEventsAfter(paths, runId, after, ({ event, timestamp, seq }) => {
      const shown = logEvent(runId, event);
      if (shown) events.push({ seq, at: timestamp, ...shown } as LogEvent);
    });
  } catch {
    // No event log yet.
  }
  const page = events.slice(0, Math.max(0, max));
  return { events: page, after: page.at(-1)?.seq ?? after, more: events.length > page.length };
}
