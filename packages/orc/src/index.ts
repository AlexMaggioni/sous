// orc as a library: the pieces the command line is made of, for tests and for other tools.
// The runs themselves live in @orchestrator/engine.

export {
  defaultHarness,
  HARNESSES,
  harnessHomes,
  lookupAgents,
  lookupMcpServers,
  lookupSettings,
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
export { runExecSpec, type ExecContext, type ExecResult } from "./exec.js";
export { host } from "./host.js";
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
export { claudeMeta, createOrcRunner, type OrcRunnerOptions } from "./runner.js";
export { main } from "./cli.js";
