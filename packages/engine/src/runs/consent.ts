// What an agent may do for the person. A workflow with startedBy "people" starts only from the
// person's own terminal, or from a schedule the person added.

import type { ResolvedWorkflow } from "../workflows/dir.js";
import type { Who } from "./actions.js";
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
