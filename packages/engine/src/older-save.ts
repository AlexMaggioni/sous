// A run saved by older code still shows, and never resumes or seeds a new run. This module tells
// such a save by the shapes only older code wrote, so the readers of those shapes can go.

import { assertExplicitCheckpointProvenance } from "./checkpoint-provenance.js";
import { WorkflowError, WorkflowErrorCode } from "./errors.js";
import { isNestedScope } from "./resume-identity.js";
import type { PersistedRunState } from "./runs/persistence/run-persistence.js";
import { CALL_INPUTS_FORMAT } from "./workflow.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** The checkpoint answers older code saved with no explicit decision, or a retired policy. */
function provenanceProblem(state: PersistedRunState): string | undefined {
  try {
    assertExplicitCheckpointProvenance(state);
    return undefined;
  } catch {
    return "it holds a checkpoint answer with no explicit decision";
  }
}

/** A row with a budget field, which only an engine that counted a budget wrote. */
function hasBudget(call: unknown): boolean {
  return isRecord(call) && (Object.hasOwn(call, "budgetDebit") || (isRecord(call.replay) && Object.hasOwn(call.replay, "logicalBudgetDebit")));
}

/** A replay row with the resume safety marker of the last release. Today's reader rejects it, so
 * a resume with a new script would run the step again. */
function hasResumeMarker(call: unknown): boolean {
  return isRecord(call) && isRecord(call.replay) && Object.hasOwn(call.replay, "sourceResumeSafety");
}

/**
 * What marks the state as saved by older code, or undefined when today's code can resume it. A
 * field that is merely missing does not count: today's code reads a state without it.
 */
export function olderSave(state: PersistedRunState): string | undefined {
  const provenance = provenanceProblem(state);
  if (provenance) return provenance;
  if (state.executionMode) return "it ran in the isolation mode of an older engine";
  const inputsFormat = state.runtime?.inputsFormat;
  if (inputsFormat !== undefined && inputsFormat !== CALL_INPUTS_FORMAT) return `its steps were hashed with inputs format ${inputsFormat}`;
  const journal = [...list(state.journal), ...list(state.nestedJournal)];
  const calls = list(state.calls);
  const own = (scope: unknown) => scope === undefined || scope === state.runId || isNestedScope(scope, state.runId);
  // Engine 0.23 saved some root rows under the id of the run it came from.
  if ([...journal, ...calls].some((row) => isRecord(row) && !own(row.scope))) return "its rows sit under another run's id, as engine 0.23 saved them";
  const withCalls = new Set(calls.map((call) => (isRecord(call) ? call.scope ?? state.runId : undefined)));
  if (journal.some((entry) => isRecord(entry) && !withCalls.has(entry.scope ?? state.runId))) return "it saved steps with no call rows";
  const seed: Record<string, unknown> = isRecord(state.resumeSeed) ? state.resumeSeed : {};
  if (list(seed.checkpointInjections).length > 0) return "its seed holds an injected checkpoint answer";
  const seedCalls = [...list(seed.candidates), ...list(seed.callBlockers)].map((row) => (isRecord(row) ? row.call : undefined));
  if ([...calls, ...seedCalls].some(hasBudget) || list(seed.candidates).some((row) => isRecord(row) && Object.hasOwn(row, "logicalBudgetDebit"))) {
    return "it holds the budget fields of an older engine";
  }
  if ([...calls, ...seedCalls].some(hasResumeMarker)) return "it holds the resume safety marker of an older engine";
  return undefined;
}

/** Throw when older code saved the run. `use` names what the caller wanted, such as "resume". */
export function assertCurrentSave(state: PersistedRunState, use: string): void {
  const why = olderSave(state);
  if (why === undefined) return;
  throw new WorkflowError(
    `older-save: ${state.runId} was saved by older code (${why}), so it cannot ${use}; start a fresh run`,
    WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
    { recoverable: false },
  );
}
