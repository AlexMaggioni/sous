// A step's `until` as the engine reads it. A script writes "turn" or "done". turns/loop.ts sends
// the object form, which also carries `ask` and the step's limits for the steps module. Nothing
// here does I/O.

import { WorkflowError, WorkflowErrorCode } from "../errors.js";
import type { StepLimits, StepRequest } from "../steps/agent-run.js";

/** How a step ends, with what the steps module reads: ask, and the limits of StepLimits. */
export interface StepUntil extends StepLimits {
  end: "turn" | "done";
  ask?: boolean;
}

export type Until = "turn" | "done" | StepUntil;

const LIMITS = ["maxRepairs", "maxTurns", "turnsLeft"];

/** A step's until as the runner gets it. A step with no until runs one turn. */
export function untilFields(until: Until | undefined): Pick<StepRequest, "untilDone" | "limits"> {
  if (until === undefined || typeof until === "string") return until === "done" ? { untilDone: {} } : {};
  const { end, ask, ...limits } = until;
  return { ...(end === "done" ? { untilDone: ask === undefined ? {} : { ask } } : {}), ...(Object.keys(limits).length ? { limits } : {}) };
}

/** What the call hash holds of a step's until: "done", and ask when it is false. The limits change
 *  no turn the model sees, so they stay out. */
export function untilHash(until: Until | undefined): { until?: "done"; ask?: false } {
  const done = untilFields(until).untilDone;
  return done ? { until: "done", ...(done.ask === false ? { ask: false as const } : {}) } : {};
}

/** Refuses an until that is not "turn", "done" or the object form. */
export function checkUntil(until: unknown): void {
  const refuse = (message: string): never => {
    throw new WorkflowError(message, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false });
  };
  if (until === undefined || until === "turn" || until === "done") return;
  if (until === null || typeof until !== "object" || Array.isArray(until)) refuse('until is "turn" or "done"');
  const { end, ask, ...limits } = until as Record<string, unknown>;
  if (end !== "turn" && end !== "done") refuse('until.end is "turn" or "done"');
  if (ask !== undefined && typeof ask !== "boolean") refuse("until.ask is true or false");
  for (const [name, value] of Object.entries(limits)) {
    if (!LIMITS.includes(name)) refuse(`until takes end, ask, ${LIMITS.join(", ")}, not ${name}`);
    if (!Number.isInteger(value) || (value as number) < 1) refuse(`until.${name} is a whole number of at least 1`);
  }
}
