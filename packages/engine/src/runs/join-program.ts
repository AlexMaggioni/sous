// The program `sous join` opens: the step's own program, on the run's account, in the session's
// folder, with the step's model, effort, mode, system text and MCP servers. The cli runs it in the
// person's terminal. MCP servers that a script passed inline are not in the session's record, so
// the person's program opens without them.

import { sep } from "node:path";
import { createHarness, type Harness } from "@sous-run/harnesses";
import { runAccounts } from "../accounts.js";
import { envFor, harnessName, isHarness, lookupMcpServers, lookupSettings, stepModel } from "../agents.js";
import { programLookup } from "../programs.js";
import { toMcpServer } from "../steps/answer.js";
import { loadConfig, loadSecrets, type HomePaths } from "./home.js";
import type { JoinTarget } from "./join.js";
import { loadRecord } from "./records.js";
import { Refusal } from "./refusal.js";

/** How to open a step's session by hand. */
export interface JoinProgram {
  /** The program's name, such as Claude Code. */
  name: string;
  path: string;
  args: string[];
  env: Record<string, string | undefined>;
  cwd: string;
  /** What the step had that the person's program opens without. */
  notes: string[];
}

/**
 * The program and its arguments for the person to step into `target`'s session. `write` saves a
 * text in a private file and gives its path, for an MCP config that holds secrets. `env` is the
 * person's environment, which the program opens with, on the run's account. A program sous cannot
 * find is refused with no_program.
 */
export function joinProgram(paths: HomePaths, target: JoinTarget, write: (name: string, text: string) => string, env: NodeJS.ProcessEnv): JoinProgram {
  const { session } = target;
  const harness = session.backendId;
  if (!isHarness(harness)) {
    throw new Refusal("no_program", `the session of "${target.step}" runs on ${harness}, which sous cannot open by hand.`, "Join a step that runs on Claude Code or Codex.", null);
  }
  const config = loadConfig(paths);
  const program: Harness = createHarness(harness, programLookup(config)(harness));
  const found = program.find();
  if (!("path" in found)) {
    throw new Refusal("no_program", `sous found no ${harnessName(harness)} to open the session of "${target.step}" in: ${found.problem}`, "Install it, or set its path in ~/.sous/config.json.", "sous doctor");
  }
  const record = loadRecord(paths, target.runId);
  const account = record?.accounts ? runAccounts(paths, record.accounts)[harness] : undefined;
  const opened = envFor(harness, account, env);
  const notes: string[] = [];
  const mcpServers = [];
  if (session.mcp?.length && record) {
    const mcp = lookupMcpServers(lookupSettings(paths, record.projectDir, config, opened), { ...opened, ...loadSecrets(paths) });
    for (const name of session.mcp) {
      const server = mcp.find(name, harness)?.server;
      const converted = server && toMcpServer(server);
      if (converted && !("problem" in converted)) mcpServers.push(converted);
      else notes.push(`The MCP server "${name}" the step had is no longer in the config, so the session opens without it.`);
    }
  }
  const model = stepModel(target.model ?? session.model);
  const join = {
    sessionId: session.sessionId,
    cwd: session.cwd,
    ...(model ? { model } : {}),
    ...(session.effort ? { effort: session.effort } : {}),
    ...(session.mode ? { mode: session.mode } : {}),
    ...(session.instructions ? { instructions: session.instructions } : {}),
    ...(mcpServers.length ? { mcpServers } : {}),
  };
  const args = program.joinArgs(join, write);
  // Claude Code asks whether to trust a folder it has not opened by hand, and its No closes it.
  // The run's scratch folder and its worktrees are folders sous made under its home.
  if (harness === "claude" && session.cwd.startsWith(`${paths.home}${sep}`)) {
    notes.push("Claude Code may ask whether you trust this folder. sous made it for the run, so answer yes. No closes Claude Code.");
  }
  return { name: harnessName(harness), path: found.path, args: args.args, env: opened, cwd: session.cwd, notes: [...notes, ...args.notes] };
}
