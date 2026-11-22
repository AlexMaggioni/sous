// What a run needs from the programs, which orc still owns: the agent runner, the agent lookup,
// the accounts and the path of orc's cli.js. orc builds one RunHost and passes it to the worker,
// the service and the commands. Step 3 replaces it with the harnesses.

import type { AgentRunner } from "@orchestrator/shared-types";
import type { AgentRegistry } from "../agent-registry.js";
import type { HomePaths, OrcConfig } from "./home.js";
import type { Program, RunRecord } from "./records.js";
import type { SlotPool } from "./slots.js";

export interface HostRunnerOptions {
  paths: HomePaths;
  /** The run's project, where its agents and MCP servers are looked up. */
  projectDir: string;
  /** Where the run works. */
  cwd: string;
  config: OrcConfig;
  /** The values of secrets.env. */
  secrets: Record<string, string>;
  /** A runner from the caller or $ORC_AGENT_MODULE. It brings its own programs. */
  inner?: AgentRunner;
  /** The agent cap. A dry run passes none. */
  slots?: SlotPool;
  onSlot?: (event: { label?: string; state: "waiting" | "running" }) => void;
  /** The installed program a step runs on. The name is the one people read, such as "Claude Code". */
  onProgram?: (found: { program: Program; name: string; path: string; version?: string }) => void;
  /** A step hit a usage limit. */
  onLimit?: (event: { program: Program }) => void;
}

export interface RunHost {
  /** orc's built cli.js, which runs `orc _worker`. Throws when orc is not built. */
  cliFile(): string;
  /** The account each program's steps use, picked when the run is created. */
  accountsForRun(paths: HomePaths, options: { caller?: boolean; parentRunId?: string }): RunRecord["accounts"];
  /** Point the programs at the run's accounts. Returns what puts them back. */
  applyAccounts(paths: HomePaths, accounts: RunRecord["accounts"]): () => void;
  /** What to tell the user when a step hit a usage limit. */
  limitNotice(paths: HomePaths, record: RunRecord, resetHint: string | undefined): string;
  /** The agents a project's steps can name. */
  agents(paths: HomePaths, projectDir: string): AgentRegistry;
  /** The runner that runs a run's steps. */
  runner(options: HostRunnerOptions): AgentRunner & { dispose(): Promise<void> };
}
