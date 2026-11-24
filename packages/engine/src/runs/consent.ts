// What an agent may do for the person. A workflow with startedBy "people" starts only from the
// person's own terminal, or from a schedule the person added. A question for people takes only
// the person's answer, typed or passed on with --by person.

import type { ResolvedWorkflow } from "../workflows/dir.js";
import { workflowExtras } from "../workflows/meta.js";
import { parseWorkflowScript } from "../workflows/script.js";
import type { Through, Who } from "./actions.js";
import { answerCalls, answerCommand, type Question } from "./inbox.js";
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

/**
 * Refuse an answer the caller may not give, with question_for_people. It allows, in this order:
 * the person, typed or passed on with --by person; nothing else for a breakpoint; anyone for a
 * question whose author set answeredBy "anyone"; anyone for a people question of a run started
 * with --let-agent-answer. `record` is the root run's, so the consent covers its nested runs.
 */
export function mayAnswer(question: Question, record: Pick<RunRecord, "letAgentAnswer">, who: Who): void {
  if (who.by === "person") return;
  if (question.breakpoint) {
    const change = `Give the person the breakpoint. Pass on their decision with --by person: ${answerCommand(question, "approve")}, ${answerCommand(question, "send-back", '"note"')} or sous stop ${question.runId}.`;
    throw new Refusal("question_for_people", `${question.id} is a breakpoint, so only the person decides it.`, change, answerCalls(question, who)[0]!);
  }
  if (question.answeredBy === "anyone" || record.letAgentAnswer) return;
  const change = "Ask the person, then pass on their answer with --by person.";
  throw new Refusal("question_for_people", `${question.id} is for the person to answer.`, change, answerCalls(question, who)[0]!);
}

/**
 * The person's consent that agents answer a run's people questions, as the record keeps it.
 * Only the person gives it, typed or passed on with --by person: anything else is refused with
 * needs_person and `command` with --by person.
 */
export function letAgentAnswerBy(who: Who, command: string): NonNullable<RunRecord["letAgentAnswer"]> {
  if (who.by !== "person") {
    const change = "Ask the person whether agents may answer this run's questions, then pass on their yes with --by person.";
    throw new Refusal("needs_person", "Only the person lets agents answer a run's questions.", change, `${command} --by person --json`);
  }
  return { by: who.by, through: who.through, at: new Date().toISOString() };
}
