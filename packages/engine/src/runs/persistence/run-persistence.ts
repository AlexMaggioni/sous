/**
 * Workflow run state persistence for pause/resume support.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { AgentHistoryEntry } from "../../steps/agent-history.js";
import type { AgentResultProvenance, AgentUsage } from "../../steps/agent-run.js";
import type {
  AgentSessionRecord,
  JournalEntry,
  WorkflowCallRecord,
  WorkflowCheckpointTaken,
  WorkflowContinuationResult,
  WorkflowReplayEligibility,
  WorkflowResumeReport,
  WorkflowRunFallback,
  WorkflowRunLimits,
} from "../../workflow-result.js";
import type { AuthErrorContext, CheckpointContext } from "../../errors.js";
import { WorkflowErrorCode } from "../../errors.js";
import type { RunEnvironmentIdentity } from "../../run-environment.js";
import { createRunEventLog, type RunEventPersistence } from "./run-event-persistence.js";
import { workflowProjectPaths } from "./project-paths.js";

export type RunStatus = "pending" | "running" | "paused" | "completed" | "failed" | "aborted";

export interface PersistedAgentState {
  id: number;
  label: string;
  phase?: string;
  prompt: string;
  status: "queued" | "running" | "done" | "error" | "skipped";
  result?: unknown;
  /** Persisted display projection of the result. */
  resultPreview?: string;
  error?: string;
  errorCode?: WorkflowErrorCode;
  recoverable?: boolean;
  history?: AgentHistoryEntry[];
  /** The session record captured when this agent's call opened a session; absent
   *  on pre-session-record persisted runs and agents that opened no session. */
  session?: AgentSessionRecord;
  startedAt?: string;
  endedAt?: string;
  /** The model this agent ran on (provider/id), when known. */
  model?: string;
  /** This logical call's aggregate observed token total (provider total or estimate). */
  tokens?: number;
  callIndex?: number;
  scope?: string;
  usage?: AgentUsage;
  provenance?: AgentResultProvenance;
}

export interface PersistedResumeFormat {
  format: "identity-v1";
  /** Captured only after the script has settled AND resume activity is zero, immediately
   *  before the terminal save. It may be absent from a crash snapshot, a non-quiescent
   *  terminal run, or a non-git run without meaningful terminal provenance. Presence,
   *  absence, and value are diagnostic only and never affect journal replay. */
  terminalEnvironment?: RunEnvironmentIdentity;
}

export interface PersistedResumeCandidate {
  sourceRunId: string;
  recordedIndex: number;
  /** Frozen source values; entry.index/call.index remain the source index. */
  entry: JournalEntry;
  call: WorkflowCallRecord;
}

/** A settled non-result occurrence retained in the identity matcher. It can never
 *  replay, but it prevents a result sibling with the same identity from becoming
 *  spuriously unique and is consumed when the current execution reaches it. */
export interface PersistedResumeCallBlocker {
  sourceRunId: string;
  recordedIndex: number;
  call: WorkflowCallRecord;
}

export interface PersistedCheckpointInjection {
  checkpointDecision: "explicit-v1";
  sourceRunId: string;
  recordedIndex: number;
  hash: string;
  path: string;
  /** hashCheckpointInputs() for the source pending checkpoint. */
  inputsHash: string;
  decision: unknown;
}

export interface PersistedResumeSeed {
  format: "identity-v1";
  /** Immediate run named by resumeFromRunId; individual candidates may originate in an
   *  older hop and retain that run ID themselves. */
  sourceRunId: string;
  candidates: PersistedResumeCandidate[];
  callBlockers?: PersistedResumeCallBlocker[];
  checkpointInjections?: PersistedCheckpointInjection[];
}

/** Where a run's script came from: passed inline, or read from the caller's absolute path. */
export type WorkflowScriptOrigin = { kind: "inline" } | { kind: "path"; path: string };

/** One accepted script revision: the continuation generation that first ran the revised text. */
export interface WorkflowScriptRevision {
  generation: number;
  /** SHA-256 of the revised script text. */
  scriptHash: string;
  revisedAt: string;
}

export interface PersistedRunState {
  runId: string;
  workflowName: string;
  /** The text that executes: the admitted script, or the latest accepted revision. */
  script: string;
  /** Recorded at admission; absent on runs created before script origins were tracked. */
  scriptOrigin?: WorkflowScriptOrigin;
  /** Every continuation that ran a revised script, oldest first. */
  scriptRevisions?: WorkflowScriptRevision[];
  args?: unknown;
  /** The persisted args value was not a faithful pre-execution strict-JSON snapshot. */
  argsUnreplayable?: true;
  /** The run's working directory (ExecOptions.cwd) when it overrode the manager cwd —
   *  kept so a resume re-runs in the same directory (e.g. the same worktree). */
  cwd?: string;
  /** The directory the run actually executed in. */
  effectiveCwd?: string;
  runtime?: {
    /** Producing engine package version. Diagnostic only; never an admission gate. */
    engineVersion?: string;
    node: string;
    v8: string;
    pathFormat: number;
    inputsFormat: number;
    checkpointInputsFormat?: number;
  };
  environment?: RunEnvironmentIdentity;
  continuation?: WorkflowContinuationResult;
  resume?: PersistedResumeFormat;
  /** Immediate run named by resumeFromRunId, written once by the engine at admission. */
  readonly resumeSourceRunId?: string;
  resumeSeed?: PersistedResumeSeed;
  resumeReport?: WorkflowResumeReport;
  replayEligibility?: WorkflowReplayEligibility;
  status: RunStatus;
  /** Safe run-level terminal explanation kept on the saved run. */
  reason?: string;
  /** Machine-readable terminal error kept on the saved run. */
  errorCode?: WorkflowErrorCode;
  /** Why a paused run is paused (e.g. "usage_limit", "auth_required",
   *  "checkpoint_required", or "interrupted"). Free-form string — no migration. */
  pauseReason?: string;
  /** Provider reset hint for a usage-limit pause, e.g. "Resets in ~3h" (verbatim). */
  resetHint?: string;
  /** For a usage-limit pause: when the provider's limit resets, as an RFC 3339 instant, from
   *  the error's providerUsageLimitContext. A state saved before it existed has only resetHint. */
  resetAt?: string;
  /** When the run paused. Set once, when it pauses: a later save moves updatedAt, not this. */
  pausedAt?: string;
  /** For an "auth_required" pause (§2.12/§2.13): the structured, NON-SECRET auth surface
   *  (backendId + advertised method ids/types/names). NEVER the intent's secret payload —
   *  no `authenticateMeta`, no `envValues` (Principle 9). Read by the cold re-arm of a resume. */
  authContext?: AuthErrorContext;
  /** For a "checkpoint_required" pause: the structured, NON-SECRET pending checkpoint
   *  surface. Its call index and hash let resume journal the host-supplied decision. */
  checkpointContext?: CheckpointContext;
  phases: string[];
  currentPhase?: string;
  agents: PersistedAgentState[];
  logs: string[];
  result?: unknown;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  durationMs?: number;
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
    cost?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  /** Cached agent results for resume, keyed by deterministic call index. */
  journal?: JournalEntry[];
  /** Cached results of nested runs' calls, each under its child run id (scope). */
  nestedJournal?: JournalEntry[];
  /** Additive terminal observability; absent on legacy runs and when no event occurred. */
  fallbacks?: WorkflowRunFallback[];
  checkpointsTaken?: WorkflowCheckpointTaken[];
  /** Root-scope terminal-call manifest for this execution. */
  calls?: WorkflowCallRecord[];
  callsAllocated?: number;
  limits?: WorkflowRunLimits;
  abortSignaled?: true;
  /** Host-pinned fallback used by otherwise unmodelled agent calls in this run. */
  defaultModel?: string;
  nestedWorkflows?: true;
  legacyResume?: true;
  executionMode?: { kind: "isolation"; baselineRunId: string };
  /** Event-log generation discriminator: 32 lowercase hex characters. New-format journaling
   *  runs mint it with eventSeq: 0. */
  eventStreamId?: string;
  /** Highest successfully appended event seq whose state effects this snapshot reflects.
   *  New-format journaling runs write 0 before their first event. */
  eventSeq?: number;
  /** At least one persistable live event could not be appended. When set, the log is not a
   *  gap-free projection and reads fail with EVENT_LOG_INCOMPLETE. */
  eventLogIncomplete?: true;
}

/** The reason a run's saved state gets when its worker left the run before it ended. */
export function interruptedReason(pid: number | undefined): string {
  return pid === undefined
    ? "Interrupted: the owning process exited before completion (PID unavailable); recovered to a resumable pause."
    : `Interrupted: owning process PID ${pid} exited before completion; recovered to a resumable pause.`;
}

export interface RunPersistence {
  /** Save current run state. */
  save(state: PersistedRunState): void;
  /** Load a persisted run by ID. */
  load(runId: string): PersistedRunState | null;
  /** List all persisted runs. */
  list(): PersistedRunState[];
  /** Delete a persisted run. */
  delete(runId: string): boolean;
  /**
   * Acquire an exclusive cross-process lease for a run. Returns null when another
   * live process owns the run; stale/corrupt lock files are removed and retried.
   */
  acquireRunLease(runId: string): RunLease | null;
  /** Release a lease previously returned by acquireRunLease(). */
  releaseRunLease(lease: RunLease): void;
  /** Read the current cross-process owner without acquiring or mutating the lease. */
  inspectRunLease?(runId: string): RunLeaseOwner | null;
  /** Confirm that a previously acquired lease token still owns the on-disk lock. */
  validateRunLease?(lease: RunLease): boolean;
  /** Get runs directory path. */
  getRunsDir(): string;
}

export interface RunLease {
  runId: string;
  token: string;
  /** PID recorded by a dead lock owner replaced while acquiring this lease. */
  recoveredOwnerPid?: number;
}

export interface RunLeaseOwner {
  runId: string;
  pid: number;
  startedAt: string;
}

interface LockFile {
  runId: string;
  runPath: string;
  pid: number;
  startedAt: string;
  token: string;
}

/**
 * Filesystem operations used by run persistence.
 * Exposed for testing – pass overrides to inject mock implementations.
 */
export type FsLayer = {
  existsSync: typeof existsSync;
  mkdirSync: typeof mkdirSync;
  readdirSync: typeof readdirSync;
  readFileSync: typeof readFileSync;
  renameSync: typeof renameSync;
  unlinkSync: typeof unlinkSync;
  writeFileSync: typeof writeFileSync;
  openSync?: typeof openSync;
  writeSync?: typeof writeSync;
  closeSync?: typeof closeSync;
  truncateSync?: typeof truncateSync;
};

export interface RunPersistenceOptions {
  /** Absolute workflow persistence root; explicit value wins over ORCHESTRATOR_PERSISTENCE_ROOT. */
  persistenceRoot?: string;
}

/** The copy of an inline script that older engines wrote next to the run's state. delete removes it. */
export function inlineScriptFile(runsDir: string, runId: string): string {
  return join(runsDir, `${runId}.script.js`);
}

/**
 * Read a run's saved state, with no store built and nothing written. It tries the primary file,
 * then the legacy one, each before its .bak, so a corrupt primary does not lose the run.
 */
export function loadRunState(
  runsDir: string,
  legacyRunsDir: string,
  runId: string,
  fs: Pick<FsLayer, "existsSync" | "readFileSync"> = { existsSync, readFileSync },
): PersistedRunState | null {
  for (const path of [join(runsDir, `${runId}.json`), join(legacyRunsDir, `${runId}.json`)]) {
    for (const candidate of [path, `${path}.bak`]) {
      let state: PersistedRunState;
      try {
        if (!fs.existsSync(candidate)) continue;
        state = JSON.parse(fs.readFileSync(candidate, "utf-8") as string) as PersistedRunState;
      } catch {
        // corrupt candidate -> fall through to the next candidate
        continue;
      }
      return state;
    }
  }
  return null;
}

export function createRunPersistence(
  cwd: string,
  fsOverride?: Partial<FsLayer>,
  options: RunPersistenceOptions = {},
): RunEventPersistence {
  const _existsSync = fsOverride?.existsSync ?? existsSync;
  const _mkdirSync = fsOverride?.mkdirSync ?? mkdirSync;
  const _readdirSync = fsOverride?.readdirSync ?? readdirSync;
  const _readFileSync = fsOverride?.readFileSync ?? readFileSync;
  const _renameSync = fsOverride?.renameSync ?? renameSync;
  const _unlinkSync = fsOverride?.unlinkSync ?? unlinkSync;
  const _writeFileSync = fsOverride?.writeFileSync ?? writeFileSync;

  const { runsDir, legacyRunsDir } = workflowProjectPaths(cwd, { persistenceRoot: options.persistenceRoot });

  const ensureDir = () => {
    if (!_existsSync(runsDir)) {
      _mkdirSync(runsDir, { recursive: true });
    }
  };

  const runPath = (dir: string, runId: string) => join(dir, `${runId}.json`);
  const primaryRunPath = (runId: string) => runPath(runsDir, runId);
  const legacyRunPath = (runId: string) => runPath(legacyRunsDir, runId);
  const lockPath = (dir: string, runId: string) => join(dir, `${runId}.lock`);
  const lineagePath = (dir: string, runId: string) => join(dir, `${runId}.lineage`);
  const inlineScriptPath = (runId: string) => inlineScriptFile(runsDir, runId);
  const primaryLockPath = (runId: string) => lockPath(runsDir, runId);
  const legacyLockPath = (runId: string) => lockPath(legacyRunsDir, runId);
  const candidateRunPaths = (runId: string) => [primaryRunPath(runId), legacyRunPath(runId)];

  const loadState = (runId: string): PersistedRunState | null =>
    loadRunState(runsDir, legacyRunsDir, runId, { existsSync: _existsSync, readFileSync: _readFileSync });
  const events = createRunEventLog(runsDir, loadState, fsOverride);

  const pidIsAlive = (pid: number): boolean => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      if ((err as { code?: string }).code === "EPERM") return true;
      return false;
    }
  };

  const readLockAt = (path: string): LockFile | null => {
    try {
      return JSON.parse(_readFileSync(path, "utf-8")) as LockFile;
    } catch {
      return null;
    }
  };

  const readLock = (runId: string): LockFile | null => readLockAt(primaryLockPath(runId));

  const validLockOwner = (
    value: LockFile | null,
    runId: string,
    expectedRunPath: string,
  ): value is LockFile =>
    value !== null &&
    value.runId === runId &&
    value.runPath === expectedRunPath &&
    Number.isInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.token === "string";

  const removeStaleLegacyLock = (
    runId: string,
  ): { available: boolean; recoveredOwnerPid?: number } => {
    const lock = legacyLockPath(runId);
    const existing = readLockAt(lock);
    const valid = validLockOwner(existing, runId, legacyRunPath(runId));
    if (valid && pidIsAlive(existing.pid)) return { available: false };
    try {
      if (_existsSync(lock)) _unlinkSync(lock);
    } catch {
      return { available: false };
    }
    return {
      available: true,
      ...(valid ? { recoveredOwnerPid: existing.pid } : {}),
    };
  };

  return {
    save(state: PersistedRunState) {
      ensureDir();
      state.updatedAt = new Date().toISOString();
      const path = primaryRunPath(state.runId);
      const json = JSON.stringify(state, null, 2);
      // Atomic write: a crash mid-write can't corrupt the live file (tmp+rename is
      // atomic on the same filesystem). A .bak from the previous good save is the
      // recovery fallback if the primary is somehow truncated.
      _writeFileSync(`${path}.tmp`, json);
      _renameSync(`${path}.tmp`, path);
      try {
        _writeFileSync(`${path}.bak`, json);
      } catch {
        // backup is best-effort; the primary write already succeeded
      }
      try {
        const marker = lineagePath(runsDir, state.runId);
        if (_existsSync(marker)) _unlinkSync(marker);
      } catch {
        // An old engine's deleted-run marker; the live record wins, so cleanup is best-effort.
      }
    },

    load(runId: string): PersistedRunState | null {
      return loadState(runId);
    },

    list(): PersistedRunState[] {
      const byRunId = new Map<string, PersistedRunState>();
      for (const dir of [runsDir, legacyRunsDir]) {
        try {
          if (!_existsSync(dir)) continue;
          const files = _readdirSync(dir).filter((f) => f.endsWith(".json"));
          for (const file of files) {
            try {
              const state = JSON.parse(_readFileSync(join(dir, file), "utf-8")) as PersistedRunState;
              if (!byRunId.has(state.runId)) byRunId.set(state.runId, state);
            } catch {
              // Skip corrupted files
            }
          }
        } catch {
          // Skip unreadable directories; another storage location may still work.
        }
      }
      return [...byRunId.values()].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    },

    delete(runId: string): boolean {
      // The events file goes first, before the state files and the lock.
      events.remove(runId);
      let deleted = false;
      // Files older engines wrote next to the run: a copy of an inline script and a deleted-run marker.
      for (const old of [inlineScriptPath(runId), lineagePath(runsDir, runId), lineagePath(legacyRunsDir, runId)]) {
        try {
          if (_existsSync(old)) _unlinkSync(old);
        } catch {
          // ignore leftover cleanup failures
        }
      }
      for (const path of candidateRunPaths(runId)) {
        try {
          if (_existsSync(path)) {
            _unlinkSync(path);
            deleted = true;
          }
        } catch {
          // ignore per-file cleanup failures
        }
        // Snapshot recovery artifacts follow the primary; the writer lock is always last.
        for (const sidecar of [`${path}.bak`, `${path}.tmp`]) {
          try {
            if (_existsSync(sidecar)) _unlinkSync(sidecar);
          } catch {
            // ignore sidecar cleanup failures
          }
        }
      }
      // Both storage locations are settled before either writer-exclusion file is removed.
      for (const dir of [legacyRunsDir, runsDir]) {
        try {
          const lock = lockPath(dir, runId);
          if (_existsSync(lock)) _unlinkSync(lock);
        } catch {
          // ignore lock cleanup failures
        }
      }
      return deleted;
    },

    acquireRunLease(runId: string): RunLease | null {
      ensureDir();
      const path = primaryRunPath(runId);
      const lock = primaryLockPath(runId);
      const legacy = removeStaleLegacyLock(runId);
      if (!legacy.available) return null;
      let recoveredOwnerPid = legacy.recoveredOwnerPid;
      for (let attempt = 0; attempt < 2; attempt++) {
        const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        const payload: LockFile = {
          runId,
          runPath: path,
          pid: process.pid,
          startedAt: new Date().toISOString(),
          token,
        };
        try {
          _writeFileSync(lock, JSON.stringify(payload, null, 2), { flag: "wx" });
          return {
            runId,
            token,
            ...(recoveredOwnerPid === undefined ? {} : { recoveredOwnerPid }),
          };
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (code !== "EEXIST") throw err;
          const existing = readLock(runId);
          const valid = validLockOwner(existing, runId, path);
          if (valid && pidIsAlive(existing.pid)) {
            return null;
          }
          if (valid) recoveredOwnerPid = existing.pid;
          try {
            _unlinkSync(lock);
          } catch {
            return null;
          }
        }
      }
      return null;
    },

    releaseRunLease(lease: RunLease): void {
      events.forget(lease.runId);
      try {
        const existing = readLock(lease.runId);
        if (existing?.token === lease.token) _unlinkSync(primaryLockPath(lease.runId));
      } catch {
        // Best-effort cleanup only.
      }
    },

    inspectRunLease(runId: string): RunLeaseOwner | null {
      const existing = readLock(runId);
      if (!validLockOwner(existing, runId, primaryRunPath(runId))) return null;
      return {
        runId,
        pid: existing.pid,
        startedAt: existing.startedAt,
      };
    },

    validateRunLease(lease: RunLease): boolean {
      const existing = readLock(lease.runId);
      return validLockOwner(existing, lease.runId, primaryRunPath(lease.runId)) &&
        existing.token === lease.token;
    },

    getRunsDir(): string {
      return runsDir;
    },

    appendEvent: events.appendEvent,
    readEvents: events.readEvents,
  };
}

/**
 * Generate a unique run ID.
 */
export function generateRunId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${timestamp}-${random}`;
}
