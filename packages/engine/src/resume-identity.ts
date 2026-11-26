import type { RunEnvironmentIdentity } from "./run-environment.js";

export function resumeOccurrenceKey(sourceRunId: string, recordedIndex: number): string {
  return `${sourceRunId}\u0000${recordedIndex}`;
}

/** A nested run's id. A parent numbers its workflow() calls from 1 in call order. */
export function nestedRunId(parentRunId: string, ordinal: number): string {
  return `${parentRunId}-nested${ordinal}`;
}

/** The root run of a run or nested run id: the id without its nested endings. */
export function rootRunId(scope: string): string {
  return scope.replace(/(-nested[1-9]\d*)+$/, "");
}

/** True when `scope` is the id of a run nested, at any depth, inside `runId`. */
export function isNestedScope(scope: unknown, runId: string): scope is string {
  return typeof scope === "string" && scope.startsWith(runId) && /^(-nested[1-9]\d*)+$/.test(scope.slice(runId.length));
}

export function isRunEnvironmentIdentity(value: unknown): value is RunEnvironmentIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const environment = value as Record<string, unknown>;
  if (typeof environment.git !== "object" || environment.git === null || Array.isArray(environment.git)) {
    return false;
  }
  const git = environment.git as Record<string, unknown>;
  return typeof git.head === "string" && typeof git.dirtyDigest === "string";
}
