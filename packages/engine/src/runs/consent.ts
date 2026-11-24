// What an agent may do for the person. A workflow with startedBy "people" starts only from the
// person's own terminal, or from a schedule the person added. A question for people takes only
// the person's answer, typed or passed on with --by person.

import type { ResolvedWorkflow } from "../workflows/dir.js";
import { workflowExtras } from "../workflows/meta.js";
import { parseWorkflowScript } from "../workflows/script.js";
import type { Through, Who } from "./actions.js";
import type { Question } from "./inbox.js";
import type { RunRecord } from "./records.js";
import { Refusal } from "./refusal.js";

/**
 * Refuse a start of a people workflow through an agent or a step of a run, with started_by_people,
 * no call, and `command` as what the person types. --by person does not change this: the person
 * types the command. A person's terminal and a schedule may start it.
 */
export function mayStart(resolved: Pick<ResolvedWorkflow, "name" | "extras">, who: Who, command: string): void {
  const { through } = who;
  if (resolved.extras.startedBy !== "people" || (through.kind !== "agent" && through.kind !== "run")) return;
  const caller = through.kind === "run" ? `the agent in run ${through.runId}` : through.program === "claude" ? "Claude Code" : "Codex";
  const message = `${resolved.name} is started by people only, so ${caller} cannot start it${who.by === "person" ? ", even with --by person" : ""}.`;
  const change =
    "Give the person the command to type in their own terminal. A person who typed it inside Claude Code or Codex types it again in a plain terminal.";
  throw new Refusal("started_by_people", message, change, null, command);
}

/**
 * The nested lookup of a run, guarded: a run an agent or a step of a run started may not reach a
 * people workflow through workflow() or choose(), also in its resume and its rerun by an agent.
 * `through` is how the run's own start reached sous. A run a person or a schedule started, and an
 * older record with none, reach every workflow.
 */
export function nestedLookup(through: Through | undefined, lookup: (name: string) => string | undefined): (name: string) => string | undefined {
  if (through?.kind !== "agent" && through?.kind !== "run") return lookup;
  return (name) => {
    const script = lookup(name);
    if (script === undefined) return script;
    const extras = workflowExtras(parseWorkflowScript(script).meta);
    mayStart({ name, extras }, { by: "agent", through }, `sous run ${name}`);
    return script;
  };
}

// Answering: who may answer a question, and the calls that answer it. Every reply, refusal and
// worker reads the rule here.

/** Who may answer, as the author said. A breakpoint, and a file that says nothing, is for people. */
export function authorAnsweredBy(question: { answeredBy?: unknown; breakpoint?: boolean }): "people" | "anyone" {
  return question.answeredBy === "anyone" && !question.breakpoint ? "anyone" : "people";
}

/** Who may answer a question as it stands for its run. A run started with --let-agent-answer
 *  opens its people questions to anyone, never its breakpoints. `record` is the root run's. */
export function answeredByFor(question: Pick<Question, "breakpoint" | "answeredBy">, record?: Pick<RunRecord, "letAgentAnswer">): "people" | "anyone" {
  return authorAnsweredBy(question) === "anyone" || (record?.letAgentAnswer && !question.breakpoint) ? "anyone" : "people";
}

/**
 * How a caller's answer calls read: "plain" when it may answer, "by person" for an agent that
 * passes on the person's answer, and "none" for a step of a run, a schedule or the service, which
 * cannot reach the person. With no caller, the calls are the person's.
 */
function callMode(question: Pick<Question, "breakpoint" | "answeredBy">, who: Who | undefined, record?: Pick<RunRecord, "letAgentAnswer">): "plain" | "by person" | "none" {
  if (who === undefined || who.through.kind === "person" || answeredByFor(question, record) === "anyone") return "plain";
  return who.through.kind === "agent" ? "by person" : "none";
}

/** A sous command that answers a question: `answer` with a value, `approve`, or `send-back` with
 *  a note. `byPerson` passes on the person's answer. Every answer call sous prints is built here. */
export function answerCommand(question: Pick<Question, "id">, verb: "answer" | "approve" | "send-back", value?: string, json = false, byPerson = false): string {
  return `sous ${verb} ${question.id}${value === undefined ? "" : ` ${value}`}${byPerson ? " --by person" : ""}${json ? " --json" : ""}`;
}

/**
 * The --json calls that answer a question, for the caller `who`. A breakpoint has two: approve
 * and send back. An agent gets --by person on a question it may not answer alone, and a step of a
 * run gets none, since only the person answers it.
 */
export function answerCalls(question: Pick<Question, "id" | "kind" | "choices" | "breakpoint" | "answeredBy">, who?: Who, record?: Pick<RunRecord, "letAgentAnswer">): string[] {
  const mode = callMode(question, who, record);
  if (mode === "none") return [];
  const by = mode === "by person";
  if (question.breakpoint) return [answerCommand(question, "approve", undefined, true, by), answerCommand(question, "send-back", '"<note>"', true, by)];
  if (question.kind === "confirm") return [answerCommand(question, "answer", "<yes|no>", true, by)];
  if (question.kind === "select") return [answerCommand(question, "answer", `<${(question.choices ?? []).join("|")}>`, true, by)];
  return [answerCommand(question, "answer", '"<answer>"', true, by)];
}

/** What the caller tried at a breakpoint, so a refusal gives back the same decision. */
export type Tried = { decision: "approve" } | { decision: "send back"; note: string } | { decision: "stop" };

/** Text as one shell word in double quotes. */
const quoted = (text: string) => `"${text.replace(/["\\$`]/g, "\\$&")}"`;

/** The call that passes on the person's decision at a breakpoint, for what the agent tried. */
function decisionCall(question: Question, tried: Tried): string {
  if (tried.decision === "stop") return `sous stop ${question.runId} --json`;
  if (tried.decision === "send back") return answerCommand(question, "send-back", tried.note ? quoted(tried.note) : '"<note>"', true, true);
  return answerCommand(question, "approve", undefined, true, true);
}

/**
 * Refuse an answer the caller may not give, with question_for_people. It allows, in this order:
 * the person, typed or passed on with --by person; nothing else for a breakpoint; anyone for a
 * question open to anyone, by its author or by --let-agent-answer. `record` is the root run's, so
 * the consent covers its nested runs. An agent's refusal calls pass on the person's decision,
 * `tried` at a breakpoint. A step of a run gets no call: only the person answers.
 */
export function mayAnswer(question: Question, record: Pick<RunRecord, "letAgentAnswer">, who: Who, tried: Tried = { decision: "approve" }): void {
  if (who.by === "person") return;
  if (!question.breakpoint && answeredByFor(question, record) === "anyone") return;
  const agent = who.through.kind === "agent";
  if (question.breakpoint) {
    const message = `${question.id} is a breakpoint, so only the person decides it.`;
    if (!agent) {
      const change = `Only the person answers this. The run waits for them. They decide it with sous approve, sous send-back or sous stop.`;
      throw new Refusal("question_for_people", message, change, null);
    }
    const change = `Give the person the breakpoint. Pass on their decision with --by person: ${answerCommand(question, "approve")}, ${answerCommand(question, "send-back", '"note"')} or sous stop ${question.runId}.`;
    throw new Refusal("question_for_people", message, change, decisionCall(question, tried));
  }
  const message = `${question.id} is for the person to answer.`;
  if (!agent) throw new Refusal("question_for_people", message, "Only the person answers this. The run waits for them.", null);
  throw new Refusal("question_for_people", message, "Ask the person, then pass on their answer with --by person.", answerCalls(question, who, record)[0]!);
}

/**
 * The person's consent that agents answer a run's people questions, as the record keeps it, given
 * `at`. Only the person gives it, typed or passed on with --by person: anything else is refused
 * with needs_person, and an agent gets `command` with --by person. A step of a run gets no call.
 */
export function letAgentAnswerBy(who: Who, command: string, at: Date): NonNullable<RunRecord["letAgentAnswer"]> {
  if (who.by !== "person") {
    const message = "Only the person lets agents answer a run's questions.";
    if (who.through.kind !== "agent") throw new Refusal("needs_person", message, `Only the person gives this, with ${command}.`, null);
    const change = "Ask the person whether agents may answer this run's questions, then pass on their yes with --by person.";
    throw new Refusal("needs_person", message, change, `${command} --by person --json`);
  }
  return { by: who.by, through: who.through, at: at.toISOString() };
}
