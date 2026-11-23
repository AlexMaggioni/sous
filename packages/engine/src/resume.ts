import type {
  AgentSessionRecord,
  ResumePolicy,
  WorkflowCallRecord,
  WorkflowResumeDisabledReason,
} from "./workflow-result.js";

/** One interrupted root agent occurrence that may be continued at its live boundary. */
export interface ContinuationCandidate {
  readonly callIndex: number;
  readonly hash: string;
  readonly inputsHash?: string;
  /** Input fingerprint format used by the interrupted source call. Missing means current format. */
  readonly inputsFormat?: number;
  readonly sessionRef: AgentSessionRecord;
  readonly recordedCwd: string;
}

/** Manager-prepared continuation candidates for one resumed execution. */
export interface PreparedContinuation {
  readonly candidatesByIndex: ReadonlyMap<number, ContinuationCandidate>;
}

/** Validates legacy diagnostic provenance for recording tests and migration tooling.
 * Never use this helper to decide whether a journal result may replay. */
export function validateResumeSafetyMarker(
  record: WorkflowCallRecord,
  legacyResume: boolean,
): boolean {
  if (record.kind !== "agent") return record.resumeSafety === undefined;
  if (
    record.resumeSafety !== undefined &&
    record.resumeSafety !== "declared-read-only" &&
    record.resumeSafety !== "isolated-worktree"
  ) {
    return false;
  }
  if (record.origin === "journal-replay") {
    if (record.outcome !== "result" || legacyResume) return record.resumeSafety === undefined;
    if (record.replay === undefined) return false;
    const sourceSafety = record.replay.sourceResumeSafety;
    if (sourceSafety === undefined) return record.resumeSafety === undefined;
    if (sourceSafety !== record.resumeSafety) return false;
  }
  if (record.resumeSafety === undefined) return true;
  if (record.resumeSafety === "declared-read-only") {
    return record.isolation === undefined && record.worktree === undefined;
  }
  if (record.isolation !== "worktree") return false;
  return (
    (record.origin === "runner" && record.worktree === true) ||
    (record.origin === "journal-replay" &&
      record.replay?.sourceResumeSafety === "isolated-worktree")
  );
}

/** Manager-prepared, engine-internal execution input. */
export type PreparedResume =
  | {
      /** Every call runs live. */
      strategy: "live";
      sourceRunId: string;
      requestedPolicy: ResumePolicy;
      disabledReason: WorkflowResumeDisabledReason;
    }
  | {
      /** The calls pair by occurrence with the rows in the run's `resumeRows`. */
      strategy: "occurrence-v1";
      sourceRunId: string;
      requestedPolicy: ResumePolicy;
    };
