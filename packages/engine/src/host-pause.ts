// The pauses the host makes when a run reaches one of its limits: its time limit or its token
// budget. The worker asks for one in two ways. It stops the running steps with a pauseReason, or,
// when no step runs, it pauses the run with the stop as the pause signal's reason. Either way the
// run pauses with that reason, never "requested".
//
// Internal: not exported from index.ts.

import { WorkflowError, WorkflowErrorCode } from "./errors.js";

export const HOST_PAUSE_REASONS = ["time_limit", "budget"] as const;
export type HostPauseReason = (typeof HOST_PAUSE_REASONS)[number];

/** A limit the run reached: why it pauses, and the message its reason gets. */
export interface HostPause {
  pauseReason: HostPauseReason;
  message: string;
}

const isHostPauseReason = (value: unknown): value is HostPauseReason => HOST_PAUSE_REASONS.includes(value as HostPauseReason);

/** The host pause reason an error's details carry, if any. */
export function hostPauseReason(details: unknown): HostPauseReason | undefined {
  const reason = (details as { pauseReason?: unknown } | undefined)?.pauseReason;
  return isHostPauseReason(reason) ? reason : undefined;
}

/** The error a pause request admits nothing new with. A pause the host asked for at a limit, with
 *  that stop as the signal's reason, carries the limit's reason and message. */
export function pauseRequestError(reason: unknown): WorkflowError {
  const stop = reason as Partial<HostPause> | undefined;
  if (typeof stop?.message === "string" && hostPauseReason(stop)) {
    return new WorkflowError(stop.message, WorkflowErrorCode.PAUSE_REQUESTED, { recoverable: false, details: { pauseReason: stop.pauseReason } });
  }
  return new WorkflowError(
    "workflow paused by host request: executing agent calls finished, nothing new was admitted",
    WorkflowErrorCode.PAUSE_REQUESTED,
    { recoverable: false },
  );
}

/** The error a step stopped at a limit threw, so the run pauses on that step with the limit's
 *  reason and never retries it. Undefined for any other error. */
export function hostStopOf(thrown: unknown): WorkflowError | undefined {
  if (!(thrown instanceof WorkflowError) || thrown.code !== WorkflowErrorCode.AGENT_CANCELLED) return undefined;
  return hostPauseReason(thrown.details) ? thrown : undefined;
}

/** The error that stops a step before it starts, because the run reached a limit. */
export function hostStopError(stop: HostPause, agentLabel: string | undefined): WorkflowError {
  return new WorkflowError(stop.message, WorkflowErrorCode.AGENT_CANCELLED, { recoverable: false, agentLabel, details: { pauseReason: stop.pauseReason } });
}
