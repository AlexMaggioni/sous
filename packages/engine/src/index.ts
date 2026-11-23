// @orchestrator/engine runs saved workflows. It runs each agent step through the steps module,
// which uses @orchestrator/harnesses. This entry exports only the names orc imports.

// ── Runs: the orc home, run records, questions, schedules, the reads and the requests ──
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
export { answerValue, breakpointValue, normalizeAnswer, readQuestion, type AnswerKind } from "./runs/inbox.js";
export { cronMatches, nextRun, parseCron } from "./runs/cron.js";
export { InputProblems, logFile, startWorker } from "./runs/launch.js";
export { workerMain } from "./runs/worker.js";
export { busyWorktrees, daemonMain, daemonPid, fileSchedules, loadSchedules, saveSchedules, unfinishedRuns, type Schedule } from "./runs/service.js";
export {
  answerQuestion,
  discardRun,
  findQuestion,
  listRuns,
  pauseRun,
  pruneRuns,
  readLogFrom,
  readRun,
  rerunRun,
  resumeRun,
  runDetail,
  runQuestions,
  startRun,
  stopRun,
  stopStep,
  waitForRun,
  type RunDetail,
  type RunQuestion,
  type RunView,
} from "./runs/run.js";
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
