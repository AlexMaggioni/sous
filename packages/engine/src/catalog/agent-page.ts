// One agent's page: the file a step of the project runs, as lookupAgents finds it, its settings on
// each harness it can run on, the files of the same name it hides, and the saved workflows whose
// steps name it.

import { resolve, sep } from "node:path";
import type { HarnessId } from "@sous/harnesses";
import { HARNESSES, lookupAgents, lookupSettings, settingsFor, splitFrontmatter, type AgentLookup, type FoundAgent } from "../agents.js";
import { loadConfig, type HomePaths } from "../runs/home.js";
import { readText } from "./files.js";
import type { AgentPage, AgentSettings } from "./types.js";
import { once, savedCalls, stepName } from "./used-by.js";

type Env = Record<string, string | undefined>;

/** Claude Code's permission mode, from the file's frontmatter or its rulesync claudecode block.
 *  The lookup keeps no mode, since a step never sets one. */
function permissionMode(agent: FoundAgent, raw: string): string | undefined {
  if (agent.from === "codex") return undefined;
  const { data } = splitFrontmatter(raw, agent.file, true);
  const block = agent.from === "rulesync" ? data.claudecode : data;
  const mode = block && typeof block === "object" ? (block as Record<string, unknown>).permissionMode : undefined;
  return typeof mode === "string" && mode.trim() ? mode.trim() : undefined;
}

/** One entry per harness the agent runs on: a rulesync agent runs on both, its own harness
 *  first, and one from a harness's folder only on that harness. */
function settingsOf(agent: FoundAgent, raw: string): AgentSettings[] {
  const harnesses: HarnessId[] = agent.from === "rulesync" ? [agent.harness, ...HARNESSES.filter((harness) => harness !== agent.harness)] : [agent.from];
  return harnesses.map((harness) => {
    const { model, effort, tools, disallowedTools, skills, mcp } = settingsFor(agent, harness);
    const mode = harness === "claude" ? permissionMode(agent, raw) : undefined;
    return {
      harness,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(mode ? { mode } : {}),
      tools: tools ?? "all",
      ...(disallowedTools ? { disallowedTools } : {}),
      ...(skills ? { skills } : {}),
      ...(mcp ? { mcp } : {}),
    };
  });
}

/** Where a file that does not parse comes from, read from its path. */
function fromPath(file: string): FoundAgent["from"] {
  if (file.endsWith(".toml")) return "codex";
  return file.split(sep).includes(".rulesync") ? "rulesync" : "claude";
}

/** A page for a name sous can't use as it is: the first broken file and what is wrong. */
function problemPage(lookup: AgentLookup, name: string, usedBy: AgentPage["usedBy"]): AgentPage | undefined {
  const problem = lookup.problems.get(name);
  const file = problem?.files[0];
  if (!problem || !file) return undefined;
  const from = fromPath(file);
  const project = resolve(lookup.settings.projectDir) + sep;
  return {
    name,
    prompt: "",
    raw: readText(file) ?? "",
    file,
    from,
    scope: resolve(file).startsWith(project) ? "project" : "global",
    harness: from === "rulesync" ? lookup.settings.defaultHarness : from,
    settings: [],
    usedBy,
    copies: lookup.files.filter((copy) => copy.name === name && copy.file !== file).map(({ file: other, from: where, scope }) => ({ file: other, from: where, scope })),
    problem: problem.message,
  };
}

/** One agent's page, as a step of the project finds it. Undefined when sous finds no file of
 *  that name. A name whose file does not parse gives a page with `problem` and no settings. */
export function agentPage(paths: HomePaths, projectDir: string, name: string, env?: Env): AgentPage | undefined {
  const lookup = lookupAgents(lookupSettings(paths, projectDir, loadConfig(paths), env));
  const usedBy = once(
    savedCalls(paths, projectDir)
      .filter(({ call }) => call.kind === "agent" && call.agent === name)
      .map(({ workflow, call }) => ({ workflow, step: stepName(call) })),
  );
  const agent = lookup.agents.get(name);
  if (!agent) return problemPage(lookup, name, usedBy);
  const raw = readText(agent.file) ?? "";
  return {
    name,
    ...(agent.description ? { description: agent.description } : {}),
    prompt: agent.prompt,
    raw,
    file: agent.file,
    from: agent.from,
    scope: agent.scope,
    harness: agent.harness,
    settings: settingsOf(agent, raw),
    ...(agent.isolation ? { isolation: agent.isolation } : {}),
    ...(agent.timeout ? { timeout: agent.timeout } : {}),
    usedBy,
    copies: lookup.files.filter((copy) => copy.name === name && copy.file !== agent.file).map(({ file, from, scope }) => ({ file, from, scope })),
  };
}
