// @sous-run/engine runs saved workflows. It runs each agent step through the steps module,
// which uses @sous-run/harnesses. This entry exports only the names sous imports.

// ── Runs: the sous home, run records, questions, schedules, the reads and the requests ──
export {
  ensureHome,
  findProjectDir,
  homePaths,
  homeWriteProblem,
  knownProjects,
  loadConfig,
  rememberProject,
  type HomePaths,
  type Place,
} from "./runs/home.js";
export { listRecords, loadRecord, scopePath, scopePrefix, type RunRecord } from "./runs/records.js";
export { hint, questionView, type Reply } from "./runs/inbox.js";
export { answerCalls, joinName, mayStart } from "./runs/consent.js";
export { Refusal, word } from "./runs/refusal.js";
export { recordAction, traceCall, type Through, type Who } from "./runs/actions.js";
export { approveCall, approveWorkflows } from "./runs/approval-check.js";
export { seedApprovals } from "./runs/approvals.js";
export { cronMatches, nextRun, parseCron } from "./runs/cron.js";
export { InputProblems, workerProcess, type Launcher } from "./runs/launch.js";
export { daemonLog, logFile, runStamps } from "./runs/store.js";
export { workerMain } from "./runs/worker.js";
export { daemonMain, daemonPid, fileSchedules, loadSchedules, saveSchedules, type Schedule } from "./runs/service.js";
export {
  answerCallsFor,
  answerQuestion,
  discardRun,
  findQuestion,
  gcRuns,
  listRuns,
  pauseRun,
  pruneRuns,
  readLog,
  readRun,
  rerunRun,
  resumeRun,
  runActions,
  runDetail,
  runPreview,
  runQuestions,
  shortRun,
  startRun,
  stopRun,
  stopStep,
  waitForRun,
  workerRuns,
  type Failure,
  type RunDetail,
  type RunQuestion,
  type RunView,
} from "./runs/run.js";
export { removeAccount, useAccount, waitingRuns } from "./runs/run-accounts.js";
export { isAgentCall, logAfter, stepView, type StepView } from "./runs/step-view.js";
export { runTexts } from "./runs/run-texts.js";
export { tellResult, tellStep } from "./runs/tell.js";
export { askedWords, joinQuestion, joinTarget, leaveSession, takeSession, type JoinTarget } from "./runs/join.js";
export { joinProgram } from "./runs/join-program.js";
export { resumeWithNote } from "./runs/resume-note.js";
export { homeStatus, sinceWindow, statusLine, type HomeStatus } from "./runs/status.js";
export { isPlace } from "./places/places.js";

// ── Saved workflows: the folders that hold them, the check and the dry run ──
export { projectWorkflows, resolveWorkflow } from "./workflows/dir.js";
export { checkWorkflow } from "./workflows/check.js";
export { isRequired, type InputSpec } from "./workflows/meta.js";
export { workflowDiff, workflowOutline, type OutlineApproval, type WorkflowOutline } from "./workflows/outline.js";
export { dryRun, type Answers } from "./workflows/dry-run.js";
export { innerFlows, workflowFlow } from "./workflows/flow.js";

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
} from "./accounts.js";
export { HARNESSES, harnessName, isHarness, listAgents, loginOf } from "./agents.js";
export { checkPrograms, installHook, installSkill, removeHook, setupTokenProgram, skillPlaces, type ProgramReport, type SkillPlace } from "./programs.js";

// ── The catalog and the removals of the page sous serve opens ──
export { agentPage } from "./catalog/agent-page.js";
export { listMcpServers, mcpPage } from "./catalog/mcp.js";
export { listSkills, skillPage } from "./catalog/skills.js";
export { removeRun, trashWorkflow } from "./runs/remove.js";
