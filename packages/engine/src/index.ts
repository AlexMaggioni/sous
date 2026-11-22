// @orchestrator/engine runs saved workflows. It runs each agent step through the steps module,
// which uses @orchestrator/harnesses. This entry exports only the names orc imports.

// ── Runs: the orc home, run records, questions, schedules and control ──
export {
  daemonLog,
  ensureHome,
  findProjectDir,
  homePaths,
  loadConfig,
  loadSecrets,
  rememberProject,
  workflowDirs,
  type HomePaths,
  type Place,
} from "./runs/home.js";
export { findRecord, listRecords, loadRecord, processAlive, scopePath, type RunRecord } from "./runs/records.js";
export { listQuestions, normalizeAnswer, readQuestion, writeAnswer, type Question } from "./runs/inbox.js";
export { cronMatches, nextRun, parseCron } from "./runs/cron.js";
export { createRun, InputProblems, logFile, startWorker } from "./runs/launch.js";
export { savedState, workerMain } from "./runs/worker.js";
export { busyWorktrees, daemonMain, daemonPid, fileSchedules, loadSchedules, prune, saveSchedules, unfinishedRuns, type Schedule } from "./runs/service.js";
export { readLogFrom, stateOf, verdictOf, waitForRun, withLiveSteps } from "./runs/view.js";
export { answerQuestion, answerValue, breakpointValue, discardRun, findQuestion, pauseRun, rerun, resumeCheck, resumeRun, reuseCheck, stopRun, stopStep, type AnswerKind } from "./runs/control.js";
export type { PersistedRunState } from "./runs/persistence/run-persistence.js";
export { gcWorktrees, isPlace } from "./places/places.js";

// ── Saved workflows: the folders that hold them, their checked meta, the names a script refers to, and the dry run ──
export { openWorkflowDir, resolveWorkflow } from "./workflows/dir.js";
export { checkInputs } from "./workflows/meta.js";
export { readWorkflowScript, type ScriptRefs } from "./workflows/script.js";
export { dryRun, type Answers } from "./workflows/dry-run.js";

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
