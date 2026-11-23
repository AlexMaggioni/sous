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
