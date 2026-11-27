// One step of a run, for sous step, and the run's events after a seq, for sous log --json. Both
// read only: the step from the run's steps and its saved activity, the events from the engine's
// event log, in a small vocabulary.

import { harnessName, isHarness } from "../agents.js";
import { EXEC_MODEL } from "../code-steps.js";
import type { PersistedRunEvent } from "../run-events.js";
import type { HomePaths } from "./home.js";
import { readActivity, scopePrefix, type ActivityLine } from "./records.js";
import { Refusal, word } from "./refusal.js";
import { runDetail, type RunDetail } from "./run.js";
import { lastEventSeq, readEventsAfter } from "./store.js";

/** One call of a step, as sous step shows it. */
export interface StepView {
  runId: string;
  step: string;
  /** The run the step ran in: the run's id, or a nested run's. */
  scope: string;
  /** Which call of the label this is, from 1, and how many calls it made. */
  call: number;
  calls: number;
  status: string;
  kind: "agent" | "exec";
  model?: string;
  startedAt?: string;
  endedAt?: string;
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
  /** An agent step's session, once its program opened one: its id, its program, the folder it
   *  works in, and the command that steps into it. A turn of a session() handle names the handle. */
  session?: { id: string; program: string; folder: string; join: string; handle?: string };
  /** The last entries of the call's activity, oldest first. */
  activity: ActivityLine[];
  /** How many older entries the tail leaves out. */
  earlier?: number;
  /** Set when the prompt is cut to 2,000 characters. */
  promptCut?: true;
  /** The other runs, this one or nested in it, with a step of the same label under another name in the log. */
  alsoIn?: string[];
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

/** True for a call an agent runs, false for a code step's. Only an agent call takes a message,
 *  from sous tell or a resume's note. */
export const isAgentCall = (call: RunDetail["steps"][number]): boolean => call.model !== EXEC_MODEL;

/** One call of a step, and the run or nested run it ran in. */
interface StepCall {
  agent: RunDetail["steps"][number];
  scope: string;
}

/** The calls of one step of a run, as sous step, sous tell and sous stop --step count them. */
export interface StepCalls {
  /** The step's name in the log, with its nested run's name before the label. */
  name: string;
  label: string;
  /** The step's calls in start order, in every run its name covers. The nth is call n. */
  calls: StepCall[];
  /** The other runs with a step of that label, under another name in the log. */
  others: string[];
}

/**
 * A step of a run, by its name in the log or by its label. A name in the log, such as
 * "sub: impl", covers every nested run with that name, as sous stop --step does, so the calls of
 * two nested runs that share a name count as one step. A label picks the top-level run's step, or,
 * when it has none, the first nested run's. Undefined when the run has no such step.
 */
export function stepCalls(detail: RunDetail, step: string): StepCalls | undefined {
  const id = detail.record.runId;
  const scopeOf = (agent: { scope?: unknown }) => (typeof agent.scope === "string" ? agent.scope : id);
  const nameOf = (agent: { scope?: unknown; label: string }) => `${scopePrefix(id, scopeOf(agent), detail.record.nested)}${agent.label}`;
  const byName = detail.steps.filter((agent) => nameOf(agent) === step);
  const labeled = detail.steps.filter((agent) => agent.label === step);
  const scope = labeled.some((agent) => scopeOf(agent) === id) ? id : labeled.map(scopeOf)[0];
  const chosen = byName.length ? byName : labeled.filter((agent) => scopeOf(agent) === scope);
  if (!chosen.length) return undefined;
  const calls = chosen.map((agent) => ({ agent, scope: scopeOf(agent) }));
  const { label } = chosen[0]!;
  const name = nameOf(chosen[0]!);
  const others = [...new Set(detail.steps.filter((agent) => agent.label === label && nameOf(agent) !== name).map(scopeOf))];
  return { name, label, calls, others };
}

/**
 * One call of a step of a run, by its name in the log or its label, as stepCalls finds it: the
 * last call, or the one `call` names. Calls count across the runs the name covers, in start order.
 * Throws no_such_step when the run has no such step or call.
 */
export function stepView(paths: HomePaths, runId: string, name: string, options: { call?: number; tail?: number; full?: boolean } = {}): StepView {
  const detail = runDetail(paths, runId);
  const id = detail.record.runId;
  const found = stepCalls(detail, name);
  const show = `sous show ${id} --json`;
  if (!found) throw new Refusal("no_such_step", `run ${id} has no step "${name}".`, "Give the label of one of the run's steps, or its name in sous log.", show);
  const { label, calls, others } = found;
  const number = options.call ?? calls.length;
  const chosen = calls[number - 1];
  if (!chosen) throw new Refusal("no_such_step", `step "${name}" of run ${id} made ${calls.length} calls, so it has no call ${number}.`, `Give --call from 1 to ${calls.length}.`, show);
  const { agent: step, scope } = chosen;

  const all = readActivity(paths, id).filter((line) => line.scope === scope && (step.callIndex === undefined ? line.label === label : line.callIndex === step.callIndex));
  const exec = step.model === EXEC_MODEL;
  const last = (kind: string) => all.filter((line) => line.kind === kind).at(-1)?.text;
  const command = exec ? (last("command") ?? specCommand(step.prompt)) : undefined;
  const output = exec ? last("output") : undefined;
  const prompt = exec ? undefined : options.full || step.prompt.length <= PROMPT ? step.prompt : step.prompt.slice(0, PROMPT);
  const tokens = step.tokens ?? step.usage?.total;
  const tail = Math.max(0, options.tail ?? (options.full ? Infinity : TAIL));
  const activity = tail ? all.slice(-tail) : [];
  const opened = step.session;
  // sous join takes the step's last call with a session unless --call names another.
  const lastOpened = calls.map((call, i) => (call.agent.session ? i + 1 : 0)).reduce((a, b) => Math.max(a, b), 0);
  const session = opened && {
    id: opened.sessionId,
    program: isHarness(opened.backendId) ? harnessName(opened.backendId) : opened.backendId,
    folder: opened.cwd,
    join: `sous join ${id} ${word(found.name)}${number === lastOpened ? "" : ` --call ${number}`}`,
    ...(opened.handle ? { handle: opened.handle } : {}),
  };
  return {
    runId: id,
    step: found.name,
    scope,
    call: number,
    calls: calls.length,
    status: step.status,
    kind: exec ? "exec" : "agent",
    ...(exec || !step.model ? {} : { model: step.model }),
    ...(step.startedAt ? { startedAt: step.startedAt } : {}),
    ...(step.endedAt ? { endedAt: step.endedAt } : {}),
    ...(step.startedAt && step.endedAt ? { seconds: secondsOf(step.startedAt, step.endedAt) } : {}),
    ...(tokens ? { tokens } : {}),
    ...(prompt === undefined ? {} : { prompt }),
    // A saved step keeps a preview of its result, not the result.
    ...(step.result === undefined && step.resultPreview === undefined ? {} : { result: step.result ?? step.resultPreview }),
    ...(step.error === undefined ? {} : { failure: step.error }),
    ...(command === undefined ? {} : { command }),
    ...(output === undefined ? {} : { output }),
    ...(session ? { session } : {}),
    activity,
    ...(activity.length < all.length ? { earlier: all.length - activity.length } : {}),
    ...(prompt !== undefined && prompt.length < step.prompt.length ? { promptCut: true as const } : {}),
    ...(others.length ? { alsoIn: others } : {}),
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
      if (event.reason === "checkpoint_required") return { kind: "asks", ...(event.checkpointContext ? { call: event.checkpointContext.callIndex, prompt: brief(event.checkpointContext.prompt) } : {}), ...where };
      return { kind: "paused", ...(event.reason ? { reason: event.reason } : {}), ...where };
    case "callRecord":
      return event.record.kind === "checkpoint" && event.record.origin === "confirm" && event.record.outcome === "result" ? { kind: "answered", call: event.record.index, ...where } : undefined;
    case "resumed":
      return { kind: "resumed", ...where };
    case "asked":
      return { kind: "asks", call: event.callIndex, prompt: brief(event.prompt), ...(event.step ? { step: event.step } : {}), ...where };
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

/** The codes of an event log that is not there yet: a run that never started, or one an older sous saved. */
const NO_LOG = new Set(["RUN_NOT_FOUND", "EVENT_LOG_UNAVAILABLE"]);

/**
 * The run's events after the seq `after`, oldest first, at most `max` of them. `after` in the
 * answer is the seq of the last event given, or the one asked for when none came, and `more` says
 * whether more events wait. A run with no event log yet gives none. An `after` past the log's end
 * gives none, and `last`, the seq of the log's last event. Throws broken_record when the log does
 * not parse.
 */
export function logAfter(paths: HomePaths, runId: string, after: number, max = EVENTS): { events: LogEvent[]; after: number; more: boolean; last?: number } {
  const limit = Math.max(0, max);
  const events: LogEvent[] = [];
  try {
    readEventsAfter(paths, runId, after, ({ event, timestamp, seq }) => {
      const shown = logEvent(runId, event);
      if (shown) events.push({ seq, at: timestamp, ...shown } as LogEvent);
      // One more than the page tells whether more wait.
      return events.length <= limit;
    });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && NO_LOG.has(code)) return { events: [], after, more: false };
    if (code === "CURSOR_AHEAD") return { events: [], after, more: false, last: lastEventSeq(paths, runId) };
    if (code === "CORRUPT_LOG") {
      throw new Refusal("broken_record", `the event log of run ${runId} is broken: ${(error as Error).message}.`, "Read the run's text log, which sous log prints without --json, or start the workflow again.", `sous show ${runId} --json`);
    }
    throw error;
  }
  const page = events.slice(0, limit);
  return { events: page, after: page.at(-1)?.seq ?? after, more: events.length > page.length };
}
