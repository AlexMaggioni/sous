// `sous tell`: a message to a running agent step, which it reads after its current tool call. tellStep
// checks the step, writes the request and signals the worker. The worker sends the message
// through the steering board and writes a receipt in each call's activity, which tellResult waits for.

import { randomUUID } from "node:crypto";
import { EXEC_MODEL } from "../code-steps.js";
import { recordAction, type Who } from "./actions.js";
import type { HomePaths } from "./home.js";
import { readActivity, requestTell, TELL_RECEIPTS, type TellOutcome } from "./records.js";
import { Refusal, word } from "./refusal.js";
import { runDetail, runningCalls, type RunningStep } from "./run.js";
import { stepCalls } from "./step-view.js";

/** One call a tell went to: the step's name in the log, the call's number as sous step --call
 *  counts it, its run or nested run, and its call index when the state has one. */
export interface ToldCall {
  step: string;
  call: number;
  scope: string;
  label: string;
  callIndex?: number;
}

/** A tell the worker was sent. */
export interface TellSent {
  runId: string;
  id: string;
  /** The step as the caller named it. */
  step: string;
  text: string;
  /** Set when the caller named one call with --call. */
  call?: number;
  calls: ToldCall[];
}

/** What became of a tell at one call: read, not read yet, or not delivered and why. */
export type CallDelivery = "pending" | TellOutcome;

export interface TellResult {
  /** Delivered when a call read it, pending while a call has not yet. */
  delivery: "delivered" | "pending";
  /** Each call told: the step's name in the log, its number as sous step --call counts it, and what became of the tell. */
  calls: Array<{ step: string; call: number; delivery: CallDelivery }>;
  notes: string[];
}

/** How often tellResult reads the activity for the receipts. */
const POLL_MS = 100;

/** The call runs now, by its call index, or by its label when the state has no index. */
const runs = (running: RunningStep[], call: { scope: string; label: string; callIndex?: number }) =>
  running.some((now) => now.scope === call.scope && (call.callIndex === undefined ? now.label === call.label : now.callIndex === call.callIndex));

/**
 * Send a message to a running agent step. The step is its name in the log or its label, as sous
 * step finds it, so a name several nested runs share covers the calls of each. Every running call
 * of it gets the message, or the `call`th of its calls, counted from 1 in start order as sous step
 * --call counts them. Refusals, in this order, write nothing: no_such_run, no_such_step for a step or
 * call the run never had, step_not_running when the call does not run now, and
 * step_takes_no_message for a code step. Then the request goes to the worker, and events.jsonl
 * gets one line, whatever the number of calls.
 */
export function tellStep(paths: HomePaths, runId: string, tell: { step: string; text: string; call?: number }, who: Who): TellSent {
  const { step, text } = tell;
  const detail = runDetail(paths, runId);
  const { record } = detail;
  const id = record.runId;
  const show = `sous show ${id} --json`;
  const found = stepCalls(detail, step);
  if (!found) throw new Refusal("no_such_step", `run ${id} has no step "${step}".`, "Name one of the run's steps, as sous show lists them.", show);
  const { name, label } = found;
  let numbered = found.calls.map(({ agent, scope }, i) => ({ agent, scope, call: i + 1 }));
  if (tell.call !== undefined) {
    numbered = numbered.filter(({ call }) => call === tell.call);
    if (!numbered.length) throw new Refusal("no_such_step", `step "${step}" of run ${id} made ${found.calls.length} calls, so it has no call ${tell.call}.`, `Give --call from 1 to ${found.calls.length}.`, show);
  }
  // The calls that run now, as stopStep finds them, so a step between two turns or in a retry counts.
  const now = runningCalls(paths, id);
  const running = numbered.filter(({ agent, scope }) => runs(now, { scope, label, ...(agent.callIndex === undefined ? {} : { callIndex: agent.callIndex }) }));
  if (!running.length) {
    const resume = detail.resume.ok;
    const change = resume ? "Resume the run with the message as a note for this step." : "Tell a step that runs now. sous show lists the run's steps.";
    throw new Refusal("step_not_running", `"${step}" does not run now in ${id}.`, change, resume ? `sous resume ${id} --note ${word(text)} --step ${word(name)} --json` : show);
  }
  if (running.some(({ agent }) => agent.model === EXEC_MODEL)) {
    throw new Refusal("step_takes_no_message", `"${step}" is a code step, and a code step takes no message.`, "Stop the step, or tell an agent step.", `sous stop ${id} --step ${word(name)} --json`);
  }
  const calls: ToldCall[] = running.map(({ agent, scope, call }) => ({ step: name, call, scope, label, ...(agent.callIndex === undefined ? {} : { callIndex: agent.callIndex }) }));
  const sent: TellSent = { runId: id, id: randomUUID(), step, text, ...(tell.call === undefined ? {} : { call: tell.call }), calls };
  requestTell(paths, id, { id: sent.id, step, text, calls: calls.map(({ step: _step, call: _call, ...rest }) => rest) });
  try {
    process.kill(record.pid!, "SIGUSR2");
  } catch {
    // The worker ended since the check. The next worker drops the request.
    throw new Refusal("step_not_running", `"${step}" does not run now in ${id}: the run's worker ended.`, "Tell a step that runs now.", show);
  }
  recordAction(paths, { act: "tell", ...who, runId: id, step, text });
  return sent;
}

/** Each call's receipt so far, from the run's activity. A call with no call index takes the first
 *  receipt of its label that no other call took. */
function receipts(paths: HomePaths, sent: TellSent): CallDelivery[] {
  const lines = readActivity(paths, sent.runId).filter((line) => line.kind === "tell" && line.id === sent.id);
  const outcomes = Object.entries(TELL_RECEIPTS) as Array<[TellOutcome, string]>;
  const taken = new Set<number>();
  return sent.calls.map((call) => {
    const line = lines.find((line) => !taken.has(line.seq) && line.scope === call.scope && (call.callIndex === undefined ? line.label === call.label : line.callIndex === call.callIndex));
    if (line) taken.add(line.seq);
    return (line && outcomes.find(([, text]) => text === line.text)?.[0]) ?? "pending";
  });
}

/**
 * Wait up to waitMs for the worker's receipts. The tell is delivered when a call read it, and
 * pending while a call that still runs has not read it yet. A call that no longer runs, or whose
 * worker ended, has ended. When no call got it, a call that still runs gives turn_not_steerable,
 * with the same tell as its call: its turn took no message, or it was in no turn, such as while it
 * started, waited for a slot, or waited between two turns. Else the tell gives step_not_running.
 */
export async function tellResult(paths: HomePaths, sent: TellSent, wait: { waitMs: number; sleep: (ms: number) => Promise<void> }): Promise<TellResult> {
  const until = Date.now() + wait.waitMs;
  let got = receipts(paths, sent);
  while (got.includes("pending") && Date.now() < until) {
    await wait.sleep(Math.min(POLL_MS, Math.max(0, until - Date.now())));
    got = receipts(paths, sent);
  }
  const { runId, step, text } = sent;
  const now = runningCalls(paths, runId);
  got = got.map((delivery, i) => (delivery === "pending" && !runs(now, sent.calls[i]!) ? "ended" : delivery));
  const notes: string[] = [];
  const again = `sous tell ${runId} --step ${word(step)}${sent.call === undefined ? "" : ` --call ${sent.call}`} ${word(text)} --json`;
  if (!got.includes("delivered") && !got.includes("pending")) {
    const waiting = sent.calls.filter((call, i) => got[i] !== "ended" && runs(now, call));
    if (waiting.length) {
      const turn = got.includes("not_steerable");
      const why = turn ? "is in a turn that takes no message now, such as a compact" : "is not in a turn that can read a message now, such as while it starts, waits for a slot or waits between two turns";
      // A Codex before 0.169.0 has no turn/steer, so its turns never take a message.
      const codex = turn ? ` A Codex older than 0.169.0 takes no message at all: update Codex, or stop the step and give the message with sous resume ${runId} --note "..." --step ${word(waiting[0]!.step)}.` : "";
      throw new Refusal("turn_not_steerable", `"${step}" ${why}.`, `Tell it again in a moment, once a turn goes on.${codex}`, again);
    }
    throw new Refusal("step_not_running", `"${step}" ended before it read the message.`, "Tell a step that runs now.", `sous show ${runId} --json`);
  }
  const pending = sent.calls.find((_, i) => got[i] === "pending");
  if (pending) notes.push(`The step reads the message after its current tool call. sous step ${runId} ${word(pending.step)} --call ${pending.call} shows it once read.`);
  const missed = sent.calls.filter((_, i) => got[i] !== "delivered" && got[i] !== "pending").map(({ call }) => call);
  if (missed.length) notes.push(`Call${missed.length > 1 ? "s" : ""} ${missed.join(", ")} did not get the message.`);
  if (sent.calls.length > 1) notes.push(`"${step}" has ${sent.calls.length} running calls, and the message went to each. Add --call n to tell one of them.`);
  return { delivery: pending ? "pending" : "delivered", calls: sent.calls.map(({ step, call }, i) => ({ step, call, delivery: got[i]! })), notes };
}
