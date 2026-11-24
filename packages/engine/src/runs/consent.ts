// What an agent may do for the person. A workflow with startedBy "people" starts only from the
// person's own terminal, or from a schedule the person added.

import type { ResolvedWorkflow } from "../workflows/dir.js";
import { workflowExtras } from "../workflows/meta.js";
import { parseWorkflowScript } from "../workflows/script.js";
import type { Through, Who } from "./actions.js";
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
