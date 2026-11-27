import type {
  AgentSessionRecord,
  ResumePolicy,
  WorkflowCallRecord,
  WorkflowResumeDisabledReason,
} from "./workflow-result.js";

/** One interrupted agent call, in the run or a nested run, that may go on in its session. */
export interface ContinuationCandidate {
  readonly callIndex: number;
  readonly hash: string;
  readonly inputsHash?: string;
  readonly sessionRef: AgentSessionRecord;
  readonly recordedCwd: string;
}

/** The manager's continuation candidates for one resumed execution, by continuationKey. */
export interface PreparedContinuation {
  readonly candidates: ReadonlyMap<string, ContinuationCandidate>;
}

/** The key of a call among the candidates: its run's scope and its index there. */
export function continuationKey(scope: string, callIndex: number): string {
  return `${scope}#${callIndex}`;
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
      /** The calls pair by occurrence with the rows of the run's resume. */
      strategy: "occurrence-v1";
      sourceRunId: string;
      requestedPolicy: ResumePolicy;
    };

/** A prepared resume that runs every call live. */
export type LiveResume = Extract<PreparedResume, { strategy: "live" }>;

/** A prepared resume that pairs calls by occurrence with recorded rows. */
export type OccurrenceResume = Extract<PreparedResume, { strategy: "occurrence-v1" }>;
