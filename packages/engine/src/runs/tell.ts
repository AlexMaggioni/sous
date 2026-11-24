// `sous tell`: a message to a running agent step, which it reads after its current tool call. tellStep
// checks the step, writes the request and signals the worker. The worker sends the message
// through the steering board and writes a receipt in each call's activity, which tellResult waits for.

import { randomUUID } from "node:crypto";
import type { SteerOutcome } from "@sous/harnesses";
import { EXEC_MODEL } from "../code-steps.js";
import { recordAction, type Who } from "./actions.js";
import type { HomePaths } from "./home.js";
import { processAlive, readActivity, requestTell, scopePrefix, TELL_RECEIPTS } from "./records.js";
import { Refusal } from "./refusal.js";
import { runDetail } from "./run.js";

/** One call a tell went to: its number among the calls of the step, from 1, its run or nested run,
 *  and its call index when the state has one. */
export interface ToldCall {
  call: number;
  scope: string;
  label: string;
  callIndex?: number;
}

/** A tell the worker was sent. */
export interface TellSent {
  runId: string;
  id: string;
  step: string;
  text: string;
  /** Set when the caller named one call with --call. */
  call?: number;
  calls: ToldCall[];
}

/** What became of a tell, for each call: read, not read yet, or not delivered and why. */
export type CallDelivery = "delivered" | "pending" | Exclude<SteerOutcome, "delivered">;

export interface TellResult {
  /** Delivered when a call read it, pending while a call has not yet. */
  delivery: "delivered" | "pending";
  calls: Array<ToldCall & { delivery: CallDelivery }>;
  notes: string[];
}

/** A word as one shell word, in single quotes when it needs them. */
const word = (text: string) => (/^[\w./-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`);

/** How often tellResult reads the activity for the receipts. */
const POLL_MS = 100;

/**
 * Send a message to a running agent step. The step is the name sous log gives it, or the label of
 * a step of a nested run, as sous step takes it. Every running call of it gets the message, or the
 * `call`th of its calls, counted from 1 in start order. Refusals, in this order, write nothing:
 * no_such_run, no_such_step for a step or call the run never had, step_not_running when the call
 * does not run now, and step_takes_no_message for a code step. Then the request goes to the
 * worker, and events.jsonl gets one line, whatever the number of calls.
 */
export function tellStep(paths: HomePaths, runId: string, tell: { step: string; text: string; call?: number }, who: Who): TellSent {
  const { step, text } = tell;
  const detail = runDetail(paths, runId);
  const { record } = detail;
  const id = record.runId;
  const scopeOf = (agent: { scope?: unknown }) => (typeof agent.scope === "string" ? agent.scope : id);
  let named = detail.steps.filter((agent) => `${scopePrefix(id, scopeOf(agent), record.nested)}${agent.label}` === step);
  if (!named.length) {
    // A label of a nested run, as sous step finds it: the top-level run's first, else the first nested one.
    const labeled = detail.steps.filter((agent) => agent.label === step);
    const scopes = [...new Set(labeled.map(scopeOf))];
    const scope = scopes.includes(id) ? id : scopes[0];
    named = labeled.filter((agent) => scopeOf(agent) === scope);
  }
  const show = `sous show ${id} --json`;
  if (!named.length) throw new Refusal("no_such_step", `run ${id} has no step "${step}".`, "Name one of the run's steps, as sous show lists them.", show);
  let numbered = named.map((agent, i) => ({ agent, call: i + 1 }));
  if (tell.call !== undefined) {
    numbered = numbered.filter(({ call }) => call === tell.call);
    if (!numbered.length) throw new Refusal("no_such_step", `step "${step}" of run ${id} made ${named.length} calls, so it has no call ${tell.call}.`, `Give --call from 1 to ${named.length}.`, show);
  }
  const running = processAlive(record.pid) ? numbered.filter(({ agent }) => agent.status === "running") : [];
  if (!running.length) {
    const resume = detail.resume.ok;
    const change = resume ? "Resume the run with the message as a note, and the step reads it when it runs again." : "Tell a step that runs now. sous show lists the run's steps.";
    throw new Refusal("step_not_running", `"${step}" does not run now in ${id}.`, change, resume ? `sous resume ${id} --note ${word(text)} --json` : show);
  }
  if (running.some(({ agent }) => agent.model === EXEC_MODEL)) {
    throw new Refusal("step_takes_no_message", `"${step}" is a code step, and a code step takes no message.`, "Stop the step, or tell an agent step.", `sous stop ${id} --step ${word(step)} --json`);
  }
  const calls: ToldCall[] = running.map(({ agent, call }) => ({ call, scope: scopeOf(agent), label: agent.label, ...(agent.callIndex === undefined ? {} : { callIndex: agent.callIndex }) }));
  const sent: TellSent = { runId: id, id: randomUUID(), step, text, ...(tell.call === undefined ? {} : { call: tell.call }), calls };
  requestTell(paths, id, { id: sent.id, step, text, calls: calls.map(({ call: _call, ...rest }) => rest) });
  try {
    process.kill(record.pid!, "SIGUSR2");
  } catch {
    // The worker ended since the check. The next worker drops the request.
    throw new Refusal("step_not_running", `"${step}" does not run now in ${id}: the run's worker ended.`, "Tell a step that runs now.", show);
  }
  recordAction(paths, { act: "tell", ...who, runId: id, step, text });
  return sent;
}

/** Each call's receipt so far, from the run's activity. */
function receipts(paths: HomePaths, sent: TellSent): CallDelivery[] {
  const lines = readActivity(paths, sent.runId).filter((line) => line.kind === "tell" && line.id === sent.id);
  const outcomes = Object.entries(TELL_RECEIPTS) as Array<[SteerOutcome, string]>;
  return sent.calls.map((call) => {
    const line = lines.find((line) => line.scope === call.scope && (call.callIndex === undefined ? line.label === call.label : line.callIndex === call.callIndex));
    return (line && outcomes.find(([, text]) => text === line.text)?.[0]) ?? "pending";
  });
}

/**
 * Wait up to waitMs for the worker's receipts. The tell is delivered when a call read it, and
 * pending while a call it went to has not read it yet. When no call got it, a turn that took no
 * message gives turn_not_steerable, with the same tell as its call, and a call that ended gives
 * step_not_running.
 */
export async function tellResult(paths: HomePaths, sent: TellSent, wait: { waitMs: number; sleep: (ms: number) => Promise<void> }): Promise<TellResult> {
  const until = Date.now() + wait.waitMs;
  let got = receipts(paths, sent);
  while (got.includes("pending") && Date.now() < until) {
    await wait.sleep(Math.min(POLL_MS, Math.max(0, until - Date.now())));
    got = receipts(paths, sent);
  }
  const { runId, step, text } = sent;
  const notes: string[] = [];
  const again = `sous tell ${runId} --step ${word(step)}${sent.call === undefined ? "" : ` --call ${sent.call}`} ${word(text)} --json`;
  if (!got.includes("delivered") && !got.includes("pending")) {
    if (got.includes("not_steerable")) throw new Refusal("turn_not_steerable", `"${step}" is in a turn that takes no message now, such as a compact.`, "Tell it again in a moment, once the turn goes on.", again);
    throw new Refusal("step_not_running", `"${step}" ended before it read the message.`, "Tell a step that runs now.", `sous show ${runId} --json`);
  }
  if (got.includes("pending")) notes.push(`The step reads the message after its current tool call. sous step ${runId} ${word(step)} shows it once read.`);
  const missed = sent.calls.filter((_, i) => got[i] === "ended" || got[i] === "not_steerable").map(({ call }) => call);
  if (missed.length) notes.push(`Call${missed.length > 1 ? "s" : ""} ${missed.join(", ")} did not get the message.`);
  if (sent.calls.length > 1) notes.push(`"${step}" has ${sent.calls.length} running calls, and the message went to each. Add --call n to tell one of them.`);
  return { delivery: got.includes("pending") ? "pending" : "delivered", calls: sent.calls.map((call, i) => ({ ...call, delivery: got[i]! })), notes };
}
