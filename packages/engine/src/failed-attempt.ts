// What a live agent step does after one of its attempts fails. A code step is an agent step
// here too. The rule reads what stopped the attempt and what it threw, and names the next move.
// It writes nothing. The caller logs, counts the tokens, settles the call, and retries, returns
// or throws.
//
// Internal: not exported from index.ts.

import { WorkflowError, WorkflowErrorCode, wrapError } from "./errors.js";

/** Codes the host already turns into a pause, a stop or a reply. A failed step with one of them does not pause the run on it. */
export const HOST_HANDLED_CODES: ReadonlySet<WorkflowErrorCode> = new Set([
  WorkflowErrorCode.PROVIDER_USAGE_LIMIT,
  WorkflowErrorCode.AUTH_REQUIRED,
  WorkflowErrorCode.CHECKPOINT_REQUIRED,
  WorkflowErrorCode.PAUSE_REQUESTED,
  WorkflowErrorCode.WORKFLOW_ABORTED,
]);

/** The next move after a failed attempt. The first three come before the thrown value is read. */
export type FailedAttempt =
  /** The host stopped this attempt. The run pauses on the step. */
  | { next: "host-stopped"; reason: WorkflowError }
  /** The run stopped. The call settles as interrupted and the error goes up. */
  | { next: "run-stopped" }
  /** A pause is pending. The call settles as interrupted and does not retry now. */
  | { next: "pause-pending" }
  /** The error is recoverable and the step has attempts left. */
  | { next: "retry"; error: WorkflowError }
  /** The last attempt failed, or a retry cannot fix the error, and the host does not handle it. The run pauses on the step. */
  | { next: "pause-run"; error: WorkflowError }
  /** The last attempt failed with a recoverable error the host handles. The step returns null. */
  | { next: "return-null"; error: WorkflowError }
  /** A retry cannot fix the error, and the host handles it. The step throws it. */
  | { next: "throw"; error: WorkflowError };

export function afterFailedAttempt(input: {
  /** The host's reason, when the host stopped this attempt. */
  hostStop: WorkflowError | undefined;
  runStopped: boolean;
  pausePending: boolean;
  thrown: unknown;
  label: string;
  /** This attempt, from 1. */
  attempt: number;
  maxAttempts: number;
}): FailedAttempt {
  if (input.hostStop) return { next: "host-stopped", reason: input.hostStop };
  if (input.runStopped) return { next: "run-stopped" };
  if (input.pausePending) return { next: "pause-pending" };
  const error = wrapError(input.thrown, { agentLabel: input.label });
  if (error.recoverable && input.attempt < input.maxAttempts) return { next: "retry", error };
  if (!HOST_HANDLED_CODES.has(error.code)) return { next: "pause-run", error };
  if (error.recoverable) return { next: "return-null", error };
  return { next: "throw", error };
}
