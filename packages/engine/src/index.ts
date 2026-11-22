// @orchestrator/engine, the lifted Pi engine. It runs each agent step through the steps
// module, which uses @orchestrator/harnesses. Tests and the dry run inject an AgentRunner
// instead.

// ── Engine entry ──
export {
  runWorkflow,
  parseWorkflowScript,
  isStepFailedPause,
  workflowMayUseDefaultModel,
  hashCheckpointInputs,
  hashWorkflowAdmissionRouting,
  resolveWorkflowRunLimits,
  CALL_PATH_FORMAT,
  CALL_INPUTS_FORMAT,
  CHECKPOINT_INPUTS_FORMAT,
  type EngineRunResult,
  type WorkflowRunLimitOptions,
  type WorkflowRunOptions,
  type WorkflowCallbackContext,
  type WorkflowAgentAttemptControl,
  type WorkflowAgentOptions,
  type AgentOptions,
  type CheckpointOptions,
  type CheckpointCallContext,
  type SharedRuntime,
} from "./workflow.js";
export { assertExplicitCheckpointDecision, assertExplicitCheckpointProvenance } from "./checkpoint-provenance.js";

// ── Run manager + persistence ──
export {
  WorkflowManager,
  type WorkflowManagerOptions,
  type ExecOptions,
  type ManagedRun,
  type WorkflowAgentCallCancellation,
  type WorkflowContinuationRefusalReason,
  type WorkflowContinuationStart,
  type PersistedRunStopResult,
} from "./workflow-manager.js";
export {
  MAX_WORKFLOW_SETUP_RESPONSES,
  MAX_WORKFLOW_PREPARATION_BYTES,
  type WorkflowPreparation,
} from "./workflow-preparation.js";
export {
  createRunPersistence,
  generateRunId,
  type RunPersistence,
  type RunLease,
  type RunLeaseOwner,
  type RunStatus,
  type PersistedRunState,
  type WorkflowScriptOrigin,
  type WorkflowScriptRevision,
  type PersistedAgentState,
  type PersistedResumeFormat,
  type PersistedResumeCandidate,
  type PersistedResumeCallBlocker,
  type PersistedCheckpointInjection,
  type PersistedResumeSeed,
  type PersistedRunAdmission,
  type PersistedRunLineageTombstone,
  type FsLayer,
  type RunPersistenceOptions,
} from "./runs/persistence/run-persistence.js";
export {
  RESUME_FALLBACK_REASONS,
  RESUME_DISABLED_REASONS,
  RESUME_CALL_LIVE_REASONS,
  RESUME_CALL_FAILED_REASONS,
  type PreparedResume,
  type PreparedContinuation,
  type ContinuationCandidate,
} from "./resume.js";
export {
  RUN_EVENT_MAX_RECORD_BYTES,
  RUN_EVENT_READ_LIMIT_DEFAULT,
  RUN_EVENT_READ_LIMIT_MAX,
  RunEventLogError,
  withRunEvents,
  type AppendRunEventInput,
  type ReadRunEventsOptions,
  type ReadRunEventsResult,
  type RunEventLogErrorCode,
  type RunEventPersistence,
  type RunEventStream,
  type WatchRunEventsOptions,
} from "./runs/persistence/run-event-persistence.js";

// ── Isolation mode ──
export {
  runIsolation,
  createReplayRunner,
  RECORDING_UNUSABLE_REASONS,
  REPLAY_DIVERGENCE_KINDS,
  type RunIsolationOptions,
  type IsolationRunResult,
  type ReplayRunnerOptions,
  type ResolvedIsolationTarget,
  type IsolationTarget,
  type ReplayRunner,
  type ReplayObservation,
  type ReplayReport,
  type ReplayCallReport,
  type ReplayDivergenceEvent,
} from "./isolation.js";

// ── Errors: the shared seam contract (re-exported) + engine-local helpers ──
export {
  WorkflowError,
  WorkflowErrorCode,
  isWorkflowError,
  isProviderUsageLimit,
  isAuthRequired,
  wrapError,
  isAbortError,
  type WorkflowErrorOptions,
  type AuthErrorContext,
  type CheckpointContext,
  type ProviderUsageLimitContext,
} from "./errors.js";

// ── Config caps ──
export {
  MAX_AGENTS_PER_RUN,
  MAX_CONCURRENCY,
  MAX_AGENT_RETRIES,
  AGENTS_DIR,
} from "./config.js";

// ── Model routing / tiers ──
export {
  parseModelRoutingFromMeta,
  resolveModelForPhase,
  type ModelRoute,
  type ModelRoutingConfig,
} from "./model-routing.js";
export {
  buildDefaultTierConfig,
  loadModelTierConfig,
  saveModelTierConfig,
  resolveTierModel,
  sortedTierNames,
  getModelTierConfigPath,
  type ModelTierConfig,
} from "./model-tier-config.js";

// ── Agent registry (parameterized agents dir) ──
export {
  loadAgentRegistry,
  agentDirsFromOption,
  resolveAgentType,
  parseAgentDefinition,
  applyToolPolicy,
  agentDefinitionKey,
  listAgentTypes,
} from "./agent-registry.js";

// ── Orchestrator additions (code steps, questions, breakpoints, choices) ──
export {
  EXEC_RESULT_SCHEMA,
  DEFAULT_MAX_NESTING_DEPTH,
  parseDurationSeconds,
  orchestratorRunExtras,
  type ExecKind,
} from "./orchestrator-globals.js";

// ── Workflow directory view (folders of versioned workflow scripts) ──
export {
  openWorkflowDir,
  type WorkflowDir,
  type WorkflowDirEntry,
  type OpenWorkflowDirOptions,
} from "./workflow-dir.js";

// ── Frontmatter parser (engine-local; replaces Pi's parseFrontmatter) ──
export { parseFrontmatter } from "./frontmatter.js";

// ── Stand-in values for a dry run ──
export { fabricateFromSchema } from "./fabricate.js";

// ── Snapshot model + headless text rendering ──
export {
  preview,
  renderWorkflowText,
  renderWorkflowLines,
  createWorkflowSnapshot,
  recomputeWorkflowSnapshot,
  statusIcon,
  shorten,
  type WorkflowSnapshot,
  type WorkflowAgentSnapshot,
  type WorkflowAgentStatus,
  type WorkflowDisplay,
  type WorkflowDisplayOptions,
  type ThemeLike,
} from "./display.js";

export {
  MAX_OBSERVABILITY_SCALAR_BYTES,
  MAX_STRUCTURED_STATUS_BYTES,
  createWorkflowLogTail,
  matchesLabelGlob,
  normalizeInspectionOptions,
  projectRunEventForPersistence,
  projectWorkflowRunStatus,
  type RunObservabilitySource,
} from "./run-observability.js";
export { redactText, truncateUtf8 } from "./redact.js";
export {
  AGENT_PROGRESS_HEARTBEAT_MS,
  AGENT_PROGRESS_MIN_INTERVAL_MS,
  type WorkflowAgentActivity,
  type WorkflowAgentActivityBase,
} from "./agent-live-observability.js";

// ── Structured run-event contract ──
export {
  RUN_EVENT_LOG_VERSION,
  type EngineRunEvent,
  type EngineRunEventName,
  type EngineRunEventPayloadMap,
  type PersistableEngineRunEvent,
  type PersistedRunAgentEndPayload,
  type PersistedRunAuthPausedPayload,
  type PersistedRunCallRecord,
  type PersistedRunCallRecordPayload,
  type PersistedRunCheckpointPausedPayload,
  type PersistedRunCompletePayload,
  type PersistedRunCompleteSummary,
  type PersistedRunErrorPayload,
  type PersistedRunEvent,
  type PersistedRunJournalEntry,
  type PersistedRunJournalPayload,
  type PersistedRunPausedPayload,
  type PersistedRunRequestedPausedPayload,
  type PersistedRunUnreasonedPausedPayload,
  type PersistedRunUsageLimitPausedPayload,
  type RunAgentEndEvent,
  type RunAgentEndPayload,
  type RunAgentEventEvent,
  type RunAgentEventPayload,
  type RunAgentHistoryEvent,
  type RunAgentHistoryPayload,
  type RunAgentProgressEvent,
  type RunAgentProgressPayload,
  type RunAgentStartEvent,
  type RunAgentStartPayload,
  type RunAgentTranscriptEvent,
  type RunAgentTranscriptPayload,
  type RunAuthPausedPayload,
  type RunCallRecordEvent,
  type RunCallRecordPayload,
  type RunCheckpointPausedPayload,
  type RunCompleteEvent,
  type RunCompletePayload,
  type RunErrorEvent,
  type RunErrorPayload,
  type RunEvent,
  type RunEventCheckpointProjection,
  type RunEventErrorProjection,
  type RunEventLogRecord,
  type RunEventName,
  type RunEventOrigin,
  type RunEventPayload,
  type RunEventValueProjection,
  type RunJournalEvent,
  type RunJournalPayload,
  type RunLogEvent,
  type RunLogPayload,
  type RunRequestedPausedPayload,
  type RunPausedEvent,
  type RunPausedPayload,
  type RunPhaseEvent,
  type RunPhasePayload,
  type RunResumedEvent,
  type RunResumedPayload,
  type RunStoppedEvent,
  type RunStoppedPayload,
  type RunTokenUsageEvent,
  type RunTokenUsagePayload,
  type RunUsageLimitPausedPayload,
} from "./run-events.js";

// ── Convenience re-exports of the shared seam + host-facing result types ──
export type { AgentRunner } from "./steps/agent-runner.js";
export type {
  RunOptions,
  AgentResult,
  AgentRunOptions,
  AgentRunResult,
  AgentUsage,
  AgentResultProvenance,
} from "./steps/agent-run.js";
export type { AgentHistoryEntry } from "./steps/agent-history.js";
export type {
  WorkflowMeta,
  WorkflowMetaPhase,
  JournalEntry,
  JournalCallMetadata,
  WorkflowCallRecord,
  WorkflowLogTail,
  WorkflowRunCallStatus,
  WorkflowRunInspectionOptions,
  WorkflowRunLimits,
  WorkflowRunStatus,
  WorkflowRunStatusTruncation,
  WorkflowRunResult,
  WorkflowRunFallback,
  WorkflowCheckpointSource,
  WorkflowCheckpointTaken,
  ResumePolicy,
  WorkflowResumeStrategy,
  WorkflowResumeMatch,
  WorkflowResumeFallbackReason,
  WorkflowResumeDisabledReason,
  WorkflowResumeCallLiveReason,
  WorkflowResumeCallFailedReason,
  WorkflowResumeSafety,
  WorkflowCallReplayProvenance,
  WorkflowResumeCallDecision,
  WorkflowResumeReport,
  WorkflowReplayOperationalOption,
  WorkflowReplayOperationalChange,
  WorkflowReplayProvenanceField,
  WorkflowReplayProvenanceChange,
  WorkflowReplayFirstNonReplay,
  WorkflowReplayEligibility,
  TokenUsage,
} from "./workflow-result.js";
export type { WorkflowRecordedError } from "./errors.js";

export type { WorkflowRoutingSnapshot } from "./workflow-routing.js";

// ── Runs: the orc home, run records, questions, agent slots and schedules ──
// Only the names orc imports. knownProjects, managerFor, tick and updateRecord are for orc's tests.
export {
  daemonLog,
  ensureHome,
  findProjectDir,
  homePaths,
  knownProjects,
  loadConfig,
  loadSecrets,
  rememberProject,
  workflowDirs,
  type HomePaths,
  type Place,
} from "./runs/home.js";
export { findRecord, listRecords, loadRecord, processAlive, scopePath, updateRecord, type RunRecord } from "./runs/records.js";
export { listQuestions, normalizeAnswer, readQuestion, writeAnswer, type Question } from "./runs/inbox.js";
export { cronMatches, nextRun, parseCron } from "./runs/cron.js";
export { createRun, InputProblems, logFile, resolveWorkflow, startWorker } from "./runs/launch.js";
export { managerFor, runWorker, savedState, workerMain } from "./runs/worker.js";
export { busyWorktrees, daemonMain, daemonPid, fileSchedules, forgetRun, loadSchedules, prune, saveSchedules, tick, unfinishedRuns, type Schedule } from "./runs/service.js";
export { readLogFrom, stateOf, statusWord, waitForRun, withLiveSteps } from "./runs/view.js";
export { answerQuestion, answerValue, breakpointValue, discardRun, findQuestion, pauseRun, rerun, resumeCheck, resumeRun, reuseCheck, stopRun, stopStep, type AnswerKind } from "./runs/control.js";
export { checkInputs, workflowExtras } from "./workflow-inputs.js";
export { gcWorktrees, isGitRepo, isPlace, removeWorktree, runWorktrees } from "./places/places.js";

// ── Accounts, agents and the installed programs ──
export {
  accountLabel,
  addAccount,
  checkNewAccount,
  currentAccount,
  DEFAULT,
  describeAccount,
  folderText,
  limitNotice,
  listAccounts,
  removeAccount,
  useAccount,
} from "./accounts.js";
export {
  HARNESSES,
  harnessName,
  isHarness,
  loginOf,
  lookupAgents,
  lookupMcpServers,
  lookupSettings,
  missingServer,
  planStep,
  removedHarness,
  routeHarness,
  type Harness,
  type McpLookup,
} from "./agents.js";
export { checkPrograms, setupTokenProgram } from "./programs.js";
