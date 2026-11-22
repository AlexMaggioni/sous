// The RunHost orc hands to the engine's runs module: the agent runner, the agent lookup, the
// accounts and the path of orc's cli.js. Step 3 replaces it with the harnesses.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunHost } from "@orchestrator/engine";
import { accountsForRun, applyAccounts, limitNotice } from "./accounts.js";
import { lookupAgents, lookupMcpServers, lookupSettings, registryOf } from "./agents.js";
import { findProgram, PROGRAM_INFO } from "./programs.js";
import { createOrcRunner } from "./runner.js";

/** The built command-line file, which also runs the worker. */
function cliFile(): string {
  const here = fileURLToPath(new URL(".", import.meta.url));
  for (const candidate of [join(here, "cli.js"), join(here, "..", "dist", "cli.js")]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("orc is not built. Run pnpm build in the orchestrator repo.");
}

export const host: RunHost = {
  cliFile,
  accountsForRun: (paths, options) => accountsForRun(paths, process.env, options),
  applyAccounts: (paths, accounts) => applyAccounts(paths, accounts),
  limitNotice,
  agents: (paths, projectDir) => registryOf(lookupAgents(lookupSettings(paths, projectDir))),
  runner: (options) => {
    const settings = lookupSettings(options.paths, options.projectDir, options.config);
    return createOrcRunner({
      cwd: options.cwd,
      ...(options.inner ? { inner: options.inner } : {}),
      ...(options.slots ? { slots: options.slots } : {}),
      agents: lookupAgents(settings),
      mcp: lookupMcpServers(settings, { ...process.env, ...options.secrets }),
      // Code steps also get the project folder, since a run may work elsewhere (a worktree, a scratch folder).
      env: { ...options.secrets, ORC_PROJECT: options.projectDir },
      ...(options.onSlot ? { onSlot: options.onSlot } : {}),
      // A runner from $ORC_AGENT_MODULE or the caller brings its own programs.
      ...(options.inner ? {} : { programs: (program) => findProgram(program, { config: options.config }) }),
      onProgram: ({ program, path, version }) => options.onProgram?.({ program, name: PROGRAM_INFO[program].name, path, ...(version ? { version } : {}) }),
      ...(options.onLimit ? { onLimit: ({ program }) => options.onLimit!({ program }) } : {}),
    });
  },
};
