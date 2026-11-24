// Who did what. Each write adds one line to <home>/events.jsonl, which the monitoring app reads,
// and an answer an agent gives or passes on also tells the person in a notice. With
// SOUS_TRACE_CALLS=1 the cli adds each call to <home>/calls.jsonl too.

import { appendJsonLine, readJsonLines } from "../json-file.js";
import type { HomePaths } from "./home.js";

/** How a call reached sous: from the person's terminal, an agent's shell, a step of a run, or a schedule. */
export type Through =
  | { kind: "person" }
  | { kind: "agent"; program: "claude" | "codex"; session?: string }
  | { kind: "run"; runId: string }
  | { kind: "schedule"; schedule: string };

/** Who decided: the person, an agent, or sous itself on a schedule. */
export type By = "person" | "agent" | "sous";

export interface Who {
  by: By;
  through: Through;
}

/** The writes sous records. */
export type ActionKind =
  | "run" | "rerun" | "resume" | "pause" | "stop" | "stop-step" | "discard" | "prune" | "gc"
  | "answer" | "approve" | "send-back" | "let-agent-answer" | "approve-workflow" | "tell"
  | "schedule-add" | "schedule-remove" | "schedule-enable" | "schedule-disable" | "account-use" | "skill-install" | "hook-install" | "hook-remove";

/** One line of events.jsonl. */
export interface Action {
  at: string;
  act: ActionKind;
  by: By;
  through: Through;
  runId?: string;
  workflow?: string;
  question?: string;
  step?: string;
  value?: unknown;
  text?: string;
  hash?: string;
}

/** The most characters of free text a line keeps. */
const TEXT_MAX = 1_000;

const cut = (text: string) => (text.length > TEXT_MAX ? text.slice(0, TEXT_MAX) : text);

/** Add the action as one line, in one write, so lines from two processes never mix. Free text,
 *  and a value that is text, keep their first 1,000 characters. Returns the line. */
export function recordAction(paths: HomePaths, action: Omit<Action, "at">, now = new Date()): Action {
  const line: Action = { at: now.toISOString(), ...action };
  if (line.text !== undefined) line.text = cut(line.text);
  if (typeof line.value === "string") line.value = cut(line.value);
  appendJsonLine(paths.actions, line);
  return line;
}

/** The recorded actions in order, of one run or one kind when the filter says. */
export function readActions(paths: HomePaths, filter: { runId?: string; act?: ActionKind } = {}): Action[] {
  return readJsonLines<Action>(paths.actions).filter((line) => (filter.runId === undefined || line.runId === filter.runId) && (filter.act === undefined || line.act === filter.act));
}

/** What a noticed action did, in words that follow its doer's name. */
const DID: Partial<Record<ActionKind, (action: Action) => string>> = {
  answer: (action) => `answered ${shown(action.value)} to ${action.question}`,
  approve: (action) => `approved ${action.question}`,
  "send-back": (action) => `sent back ${action.question}${action.text ? ` with "${action.text}"` : ""}`,
  "let-agent-answer": () => "let agents answer the questions",
  "approve-workflow": (action) => `approved the workflow ${action.workflow ?? ""}`.trim(),
};

/** A value as a notice shows it: text as it is, anything else as JSON, both cut short. */
function shown(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

/** The name of what the call came through. */
function nameOf(through: Through): string | undefined {
  if (through.kind === "agent") return through.program === "claude" ? "Claude Code" : "Codex";
  if (through.kind === "run") return `A step of run ${through.runId}`;
  return undefined;
}

/**
 * The notice the person gets for an answer, approval, send back, workflow approval or let agent
 * answer made through an agent or a step of a run. The text says whether the agent decided or
 * passed on the person's word. The person's own decisions, and every other action, get none.
 */
export function noticeOf(action: Action): { title: string; message: string } | undefined {
  const did = DID[action.act];
  const name = nameOf(action.through);
  if (!did || !name) return undefined;
  const where = action.runId ? ` in run ${action.runId}` : "";
  if (action.by === "person") return { title: "sous: your decision was passed on", message: `${name} passed on your decision: it ${did(action)}${where}.` };
  return { title: "sous: an agent decided", message: `${name} ${did(action)}${where}.` };
}

/** Add one call of the cli to calls.jsonl: its words, its exit code, its error code, and where it came from. */
export function traceCall(paths: HomePaths, call: { argv: string[]; exit: number; code?: string; through: Through }): void {
  appendJsonLine(paths.calls, { at: new Date().toISOString(), ...call });
}
