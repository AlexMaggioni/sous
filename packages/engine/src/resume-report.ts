// A resumed run's report, in two parts that `sous show --json` prints side by side. The resume
// report holds each call's decision, replayed, live or failed, and their counts. The replay
// eligibility sums it up: the prefix the admission predicted, the prefix that replayed, the first
// call that did not replay, and what differs between the source run and this one. The manager
// starts a report when it admits a source, hands it each decision the engine makes, and saves
// both parts. workflow.ts builds the engine's own resume report with `buildResumeReport`.
//
// Internal: not exported from index.ts.

import { isRunEnvironmentIdentity } from "./resume-identity.js";
import type { PreparedResume } from "./resume.js";
import type { RunEnvironmentIdentity } from "./run-environment.js";
import type { PersistedRunState } from "./runs/persistence/run-persistence.js";
import { cloneFrozenStrictJson } from "./strict-json.js";
import type {
  JournalEntry,
  WorkflowReplayEligibility,
  WorkflowReplayFirstNonReplay,
  WorkflowReplayOperationalChange,
  WorkflowReplayProvenanceChange,
  WorkflowResumeCallDecision,
  WorkflowResumeReport,
  WorkflowRunLimits,
} from "./workflow-result.js";

/** How many of a run's own journal rows run from index 0 with no gap: the prefix a continued run replays. */
export function journalPrefix(entries: readonly JournalEntry[], runId: string): number {
  const indexes = new Set(entries.filter((entry) => entry.scope === undefined || entry.scope === runId).map((entry) => entry.index));
  let index = 0;
  while (indexes.has(index)) index++;
  return index;
}

/** What the report reads from the resumed run, once, when it starts. */
export interface ResumingRun {
  runtime: { engineVersion: string; node: string; v8: string; inputsFormat: number };
  environment?: RunEnvironmentIdentity;
  limits?: WorkflowRunLimits;
}

/** A resumed run's report. Each decision replaces the decision of the same index. */
export interface ResumeReporting {
  /** Take the engine's decision for a call, and rebuild both parts. */
  decide(decision: WorkflowResumeCallDecision): void;
  /** The calls decided so far, by index, with their counts. */
  report(): WorkflowResumeReport;
  /** The summary of the report and of what differs from the source run. */
  eligibility(): WorkflowReplayEligibility;
}

/** The part of the replay eligibility that is fixed when the run starts. */
interface EligibilityPlan {
  sourceRunId: string;
  strategy: WorkflowReplayEligibility["strategy"];
  disabledReason?: Extract<WorkflowReplayEligibility, { strategy: "live" }>["disabledReason"];
  predictedReplayablePrefix: number;
  initialFirstNonReplay?: WorkflowReplayFirstNonReplay;
  sourceEngineVersion?: string;
  currentEngineVersion: string;
  engineVersionComparison: WorkflowReplayEligibility["engineVersionComparison"];
  sourceInputsFormat?: number;
  currentInputsFormat: number;
  provenanceChanges: WorkflowReplayProvenanceChange[];
  operationalChanges: WorkflowReplayOperationalChange[];
}

/**
 * Start the report of a run that resumes `source` under `plan`. The report has no decision yet.
 * `predictedReplayablePrefix` is the number of calls, from call 0, the source rows can replay.
 */
export function startResumeReport(input: {
  plan: PreparedResume;
  source: PersistedRunState;
  run: ResumingRun;
  predictedReplayablePrefix: number;
}): ResumeReporting {
  const { plan, source, run, predictedReplayablePrefix } = input;
  const decisions = new Map<number, WorkflowResumeCallDecision>();
  let report = buildResumeReport(plan, []);
  const fixed = eligibilityPlan(plan, source, run, predictedReplayablePrefix);
  let eligibility = buildReplayEligibility(fixed, report);
  return {
    decide(decision) {
      decisions.set(decision.index, decision);
      report = buildResumeReport(plan, [...decisions.values()]);
      eligibility = buildReplayEligibility(fixed, report);
    },
    report: () => report,
    eligibility: () => eligibility,
  };
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** The resume report of a run: what `plan` says about the run, then its calls by index. */
export function buildResumeReport(
  plan: PreparedResume,
  decisions: readonly WorkflowResumeCallDecision[],
): WorkflowResumeReport {
  const indexes = new Set<number>();
  for (const decision of decisions) {
    if (!isNonNegativeSafeInteger(decision.index) || indexes.has(decision.index)) {
      throw new TypeError("resume decisions must have unique non-negative safe-integer indexes");
    }
    indexes.add(decision.index);
  }
  const calls = [...decisions].sort((left, right) => left.index - right.index);
  const report = {
    strategy: plan.strategy,
    sourceRunId: plan.sourceRunId,
    requestedPolicy: plan.requestedPolicy,
    replayed: calls.filter((decision) => decision.action === "replayed").length,
    live: calls.filter((decision) => decision.action === "live").length,
    failed: calls.filter((decision) => decision.action === "failed").length,
    calls,
    ...(plan.strategy === "live" ? { disabledReason: plan.disabledReason } : {}),
  };
  const cloned = cloneFrozenStrictJson(report);
  if (!cloned.ok) throw new TypeError(`resume report is not strict JSON at ${cloned.path}`);
  return cloned.clone as unknown as WorkflowResumeReport;
}

function displayOperationalValue(value: number | null): string {
  return value === null ? "none" : String(value);
}

function displayProvenanceValue(value: string | null): string {
  return value === null ? "unavailable" : value;
}

function operationalChanges(
  source: PersistedRunState,
  run: ResumingRun,
): WorkflowReplayOperationalChange[] {
  if (!source.limits || !run.limits) return [];
  const options = ["agentRetries", "concurrency"] as const;
  const changes: WorkflowReplayOperationalChange[] = [];
  for (const option of options) {
    const sourceValue = source.limits[option];
    const currentValue = run.limits[option];
    if (sourceValue === currentValue) continue;
    changes.push({
      option,
      source: sourceValue,
      current: currentValue,
      detail:
        `source recorded ${option}=${displayOperationalValue(sourceValue)}; ` +
        `this run: ${displayOperationalValue(currentValue)}`,
    });
  }
  return changes;
}

function provenanceChanges(
  source: PersistedRunState,
  run: ResumingRun,
): WorkflowReplayProvenanceChange[] {
  const changes: WorkflowReplayProvenanceChange[] = [];
  const append = (
    field: WorkflowReplayProvenanceChange["field"],
    sourceValue: string | null,
    currentValue: string | null,
    label: string,
  ): void => {
    if (sourceValue === currentValue) return;
    changes.push({
      field,
      source: sourceValue,
      current: currentValue,
      detail:
        `source recorded ${label}=${displayProvenanceValue(sourceValue)}; ` +
        `this run: ${displayProvenanceValue(currentValue)}`,
    });
  };

  append("runtime.node", source.runtime?.node ?? null, run.runtime.node, "runtime.node");
  append("runtime.v8", source.runtime?.v8 ?? null, run.runtime.v8, "runtime.v8");

  const recordedTerminal = source.resume?.terminalEnvironment;
  const recordedEnvironment = isRunEnvironmentIdentity(recordedTerminal)
    ? recordedTerminal
    : source.environment;
  const sourceEnvironment = isRunEnvironmentIdentity(recordedEnvironment)
    ? recordedEnvironment
    : undefined;
  const currentEnvironment = isRunEnvironmentIdentity(run.environment)
    ? run.environment
    : undefined;
  const sourceKind = sourceEnvironment ? "git" : null;
  const currentKind = currentEnvironment ? "git" : null;
  if (sourceKind !== currentKind) {
    append("environment.identity", sourceKind, currentKind, "environment identity");
  } else if (sourceEnvironment && currentEnvironment) {
    append("environment.git.head", sourceEnvironment.git.head, currentEnvironment.git.head, "git HEAD");
    append(
      "environment.git.dirtyDigest",
      sourceEnvironment.git.dirtyDigest,
      currentEnvironment.git.dirtyDigest,
      "git dirty digest",
    );
  }
  return changes;
}

function eligibilityPlan(
  admission: PreparedResume,
  source: PersistedRunState,
  run: ResumingRun,
  predictedReplayablePrefix: number,
): EligibilityPlan {
  const sourceEngineVersion = typeof source.runtime?.engineVersion === "string"
    ? source.runtime.engineVersion
    : undefined;
  const sourceInputsFormat = Number.isSafeInteger(source.runtime?.inputsFormat)
    ? source.runtime?.inputsFormat
    : undefined;
  const operational = operationalChanges(source, run);
  const provenance = provenanceChanges(source, run);
  let initialFirstNonReplay: WorkflowReplayFirstNonReplay | undefined;
  if (admission.strategy === "live") {
    initialFirstNonReplay = {
      index: 0,
      action: "live",
      reason: admission.disabledReason,
      detail: admission.disabledReason === "cwd-mismatch"
        ? "source effectiveCwd differs from this run"
        : "source status is not terminal",
    };
  } else if (
    predictedReplayablePrefix === 0 ||
    (
      Number.isSafeInteger(source.callsAllocated) &&
      predictedReplayablePrefix < (source.callsAllocated as number)
    )
  ) {
    initialFirstNonReplay = {
      index: predictedReplayablePrefix,
      action: "live",
      reason: "not-recorded",
      detail: `source has no contiguous replayable result at call ${predictedReplayablePrefix}`,
    };
  }
  return {
    sourceRunId: admission.sourceRunId,
    strategy: admission.strategy,
    ...(admission.strategy === "live" ? { disabledReason: admission.disabledReason } : {}),
    predictedReplayablePrefix,
    ...(initialFirstNonReplay === undefined ? {} : { initialFirstNonReplay }),
    ...(sourceEngineVersion === undefined ? {} : { sourceEngineVersion }),
    currentEngineVersion: run.runtime.engineVersion,
    engineVersionComparison: sourceEngineVersion === undefined
      ? "source-unknown"
      : sourceEngineVersion === run.runtime.engineVersion
        ? "same"
        : "different",
    ...(sourceInputsFormat === undefined ? {} : { sourceInputsFormat }),
    currentInputsFormat: run.runtime.inputsFormat,
    provenanceChanges: provenance,
    operationalChanges: operational,
  };
}

function buildReplayEligibility(
  plan: EligibilityPlan,
  report: WorkflowResumeReport,
): WorkflowReplayEligibility {
  const decisions = [...report.calls].sort((left, right) => left.index - right.index);
  const byIndex = new Map(decisions.map((decision) => [decision.index, decision] as const));
  let replayedPrefix = 0;
  while (byIndex.get(replayedPrefix)?.action === "replayed") replayedPrefix++;
  const firstDecision = decisions.find((decision) => decision.action !== "replayed");
  const firstNonReplay: WorkflowReplayFirstNonReplay | undefined = firstDecision
    ? { index: firstDecision.index, action: firstDecision.action, reason: firstDecision.reason }
    : plan.initialFirstNonReplay;
  const summary = {
    sourceRunId: plan.sourceRunId,
    strategy: plan.strategy,
    ...(plan.strategy === "live" ? { disabledReason: plan.disabledReason } : {}),
    predictedReplayablePrefix: plan.predictedReplayablePrefix,
    replayedPrefix,
    replayed: report.replayed,
    live: report.live,
    failed: report.failed,
    ...(firstNonReplay === undefined ? {} : { firstNonReplay }),
    ...(plan.sourceEngineVersion === undefined ? {} : { sourceEngineVersion: plan.sourceEngineVersion }),
    currentEngineVersion: plan.currentEngineVersion,
    engineVersionComparison: plan.engineVersionComparison,
    ...(plan.sourceInputsFormat === undefined ? {} : { sourceInputsFormat: plan.sourceInputsFormat }),
    currentInputsFormat: plan.currentInputsFormat,
    provenanceChanges: plan.provenanceChanges,
    operationalChanges: plan.operationalChanges,
  };
  const captured = cloneFrozenStrictJson(summary);
  if (!captured.ok) throw new TypeError(`replay eligibility is not strict JSON at ${captured.path}`);
  return captured.clone as unknown as WorkflowReplayEligibility;
}
