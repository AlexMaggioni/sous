// One step's turns until the agent says "done". Each turn is one engine agent() call and one
// journal row, in the step's session. The loop reads only what the journal gives back: a turn's
// status, a check command's exit code and output, a join row's answer. So a resume sends the same
// prompts and finds its rows.
//
// "working" sends CONTINUE_PROMPT. "done" runs the checks, and a failed one sends its feedback as
// the next prompt. "question" waits on a join row, then sends CONTINUE_PROMPT. maxTurns counts
// every turn sous sends, report and repair turns included, and is off unless the step sets it.

import { WorkflowError, WorkflowErrorCode, stepLimitError } from "../errors.js";
import { CONTINUE_PROMPT, readStatus } from "./status.js";
import type { StepUntil } from "./until.js";

/** A check function's verdict: true, false, or { ok, feedback }. */
type CheckFn = (result: unknown, round: number) => unknown;
/** A command run as a code step, a function called with the result, or a list run in order. */
export type Check = string | CheckFn | Array<string | CheckFn>;

/** The loop options a step may set. They never reach the engine. */
export interface LoopOptions {
  /** The step's label. The limit error and a check command's label name it. */
  label: string;
  check?: Check;
  maxTurns?: number;
  maxRepairs?: number;
  ask?: boolean;
  /** The step's folder, where a check command runs. */
  cwd?: string;
  phase?: string;
}

export interface LoopDeps {
  /** Sends one turn in the step's session, with the until the steps module reads. */
  send: (prompt: string, until: StepUntil) => Promise<unknown>;
  /** Runs a check command as a code step that may fail, and gives { code, stdout, stderr }.
   *  `step` is the step's label, and `label` the code step's. */
  command: (command: string, options: { step: string; label: string; cwd?: string; phase?: string }) => Promise<unknown>;
  /** Waits on a join row with the agent's question, until the person has stepped in and left. */
  join: (message: string) => Promise<unknown>;
}

/** The names the loop takes off a step's options. */
export const LOOP_KEYS = ["check", "maxTurns", "maxRepairs"] as const;

/** How much of a failed check command's output goes back to the agent: its end. */
const OUTPUT_END = 4000;

function refuse(message: string): never {
  throw new WorkflowError(message, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false });
}

const wholeAtLeastOne = (value: unknown) => Number.isInteger(value) && (value as number) >= 1;

/** Refuses loop options that are not what the step may set. `where` starts each message. */
export function checkLoopOptions(options: Record<string, unknown>, where: string): void {
  if (options.ask !== undefined && typeof options.ask !== "boolean") refuse(`${where}: ask is true or false`);
  if (options.until !== undefined && options.until !== "turn" && options.until !== "done") refuse(`${where}: until is "turn" or "done"`);
  for (const name of ["maxTurns", "maxRepairs"]) {
    if (options[name] !== undefined && !wholeAtLeastOne(options[name])) refuse(`${where}: ${name} is a whole number of at least 1`);
  }
  const check = options.check;
  if (check === undefined) return;
  const one = (value: unknown) => (typeof value === "string" && value.trim() !== "") || typeof value === "function";
  const fits = Array.isArray(check) ? check.length > 0 && check.every(one) : one(check);
  if (!fits) refuse(`${where}: check is a command, a function, or a non-empty list of them`);
}

/**
 * A turn's value as a status. A value that is not one counts as "done" with that value as its
 * result, as a plain answer in a dry run's answers file does. `turns` is how many turns the call
 * sent, report and repair turns included.
 */
function statusOf(value: unknown): { status: string; result: unknown; message: string | null; turns: number } {
  const status = readStatus(value);
  const keys = value !== null && typeof value === "object" ? Object.keys(value) : [];
  const onlyStatus = keys.every((key) => key === "status" || key === "result" || key === "message" || key === "turns");
  if (!status || !onlyStatus) return { status: "done", result: value, message: null, turns: 1 };
  const turns = (value as { turns?: unknown }).turns;
  return { ...status, turns: Number.isInteger(turns) && (turns as number) > 1 ? (turns as number) : 1 };
}

/** Runs the step's turns until "done" and its checks pass, and gives the done result. */
export async function runUntilDone(prompt: string, options: LoopOptions, deps: LoopDeps): Promise<unknown> {
  const checks = options.check === undefined ? [] : Array.isArray(options.check) ? options.check : [options.check];
  let sent = 0;
  let rounds = 0;
  let next = prompt;
  for (;;) {
    if (options.maxTurns !== undefined && sent >= options.maxTurns) throw stepLimitError(options.label, "maxTurns", options.maxTurns);
    const until: StepUntil = {
      end: "done",
      ...(options.ask === undefined ? {} : { ask: options.ask }),
      ...(options.maxRepairs === undefined ? {} : { maxRepairs: options.maxRepairs }),
      ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns, turnsLeft: options.maxTurns - sent }),
    };
    const turn = statusOf(await deps.send(next, until));
    sent += turn.turns;
    if (turn.status === "working") {
      next = CONTINUE_PROMPT;
      continue;
    }
    if (turn.status === "question") {
      await deps.join(turn.message ?? "The agent has a question.");
      next = CONTINUE_PROMPT;
      continue;
    }
    rounds++;
    const feedback = await failedCheck(checks, turn.result, rounds, options, deps);
    if (feedback === undefined) return turn.result;
    next = feedback;
  }
}

/** Runs the checks in order and gives the first failure's feedback, or undefined when all pass. */
async function failedCheck(checks: Array<string | CheckFn>, result: unknown, round: number, options: LoopOptions, deps: LoopDeps): Promise<string | undefined> {
  for (const check of checks) {
    const feedback = typeof check === "string" ? await commandCheck(check, options, deps) : functionCheck(await check(result, round), options.label);
    if (feedback !== undefined) return feedback;
  }
  return undefined;
}

async function commandCheck(command: string, options: LoopOptions, deps: LoopDeps): Promise<string | undefined> {
  const ran = (await deps.command(command, {
    step: options.label,
    label: `${options.label}: check`,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.phase === undefined ? {} : { phase: options.phase }),
  })) as { code?: unknown; stdout?: unknown; stderr?: unknown } | null;
  if (ran?.code === 0) return undefined;
  const output = [ran?.stdout, ran?.stderr].filter((part): part is string => typeof part === "string" && part.trim() !== "").join("\n").trim();
  const end = output.length > OUTPUT_END ? `...${output.slice(-OUTPUT_END)}` : output;
  return `The check \`${command}\` failed with exit code ${String(ran?.code)}${end ? `:\n\n${end}` : "."}\n\nFix it, then finish the task.`;
}

/** A check function's verdict as feedback, or undefined when it passes. */
function functionCheck(verdict: unknown, label: string): string | undefined {
  if (verdict === true) return undefined;
  if (verdict === false) return "A check of your answer did not pass. Look at the task again, then finish it.";
  if (verdict !== null && typeof verdict === "object" && typeof (verdict as { ok?: unknown }).ok === "boolean") {
    const { ok, feedback } = verdict as { ok: boolean; feedback?: unknown };
    if (ok) return undefined;
    if (typeof feedback === "string" && feedback.trim()) return feedback;
    return functionCheck(false, label);
  }
  return refuse(`step "${label}": a check function returns true, false or { ok, feedback }, not ${JSON.stringify(verdict) ?? String(verdict)}`);
}
