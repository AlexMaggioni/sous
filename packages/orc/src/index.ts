// orc as a library: the pieces the command line is made of, for tests and for other tools.

export {
  HARNESSES,
  harnessHomes,
  lookupAgents,
  lookupMcpServers,
  missingAgent,
  parseJsonc,
  planStep,
  registryOf,
  routeHarness,
  rulesyncFolders,
  type AgentLookup,
  type FoundAgent,
  type Harness,
  type LookupSettings,
  type McpLookup,
  type StepPlan,
} from "./agents.js";
export { checkWorkflow, type CheckResult } from "./check.js";
export { cronMatches, nextRun, parseCron, type Cron } from "./cron.js";
export { daemonMain, daemonPid, loadSchedules, prune, resumeTime, saveSchedules, tick, type Schedule, type TickDeps } from "./daemon.js";
export { runExecSpec, type ExecContext, type ExecResult } from "./exec.js";
export {
  defaultHarness,
  ensureHome,
  findProjectDir,
  homePaths,
  loadConfig,
  loadSecrets,
  lookupSettings,
  orcHome,
  workflowDirs,
  type HomePaths,
  type OrcConfig,
  type Place,
} from "./home.js";
export {
  listQuestions,
  normalizeAnswer,
  questionId,
  readAnswer,
  readQuestion,
  removeQuestion,
  removeRunQuestions,
  writeAnswer,
  writeQuestion,
  type Answer,
  type Question,
} from "./inbox.js";
export {
  accountsForRun,
  addAccount,
  applyAccounts,
  currentAccount,
  limitNotice,
  listAccounts,
  parseAccountName,
  removeAccount,
  useAccount,
  type AccountRow,
  type RunAccount,
  type UseResult,
} from "./accounts.js";
export { checkInputs, workflowExtras, type InputSpec, type WorkflowExtras } from "./inputs.js";
export { createRun, InputProblems, logFile, resolveWorkflow, spawnWorker, type CreateRunRequest, type ResolvedWorkflow } from "./launch.js";
export { notify } from "./notify.js";
export { gcWorktrees, isGitRepo, isPlace, PLACES, preparePlace, type GcResult, type PreparedPlace } from "./places.js";
export { findRecord, listRecords, loadRecord, processAlive, saveRecord, updateRecord, type RunRecord } from "./records.js";
export { claudeMeta, createOrcRunner, type OrcRunnerOptions } from "./runner.js";
export { SlotPool, type Priority, type SlotInfo } from "./slots.js";
export { managerFor, runWorker, workerMain, type WorkerOptions } from "./worker.js";
export { main } from "./cli.js";
