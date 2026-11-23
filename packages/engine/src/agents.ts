// Where orc finds an agent, and the MCP servers an agent names. Each agent is looked up on its
// own. rulesync comes first: the project's .rulesync folder, then the user's global rulesync
// folder. Then each harness's own folders: Claude Code and Codex, the project's before the home
// folder's. orc only reads these folders. `rulesync generate` writes the harnesses'
// files for the user's own sessions.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { createHarness, type Account, type HarnessId } from "@orchestrator/harnesses";
import type { McpServerConfig } from "./steps/mcp-config.js";
import { parseDurationSeconds } from "./duration.js";
import type { StepAsk, StepRoute } from "./steps/agent-runner.js";
import { loadConfig, type HomePaths, type OrcConfig } from "./runs/home.js";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";

export const HARNESSES = ["claude", "codex"] as const satisfies readonly HarnessId[];

/** The block of a rulesync agent that holds one harness's settings. */
const RULESYNC_BLOCK: Record<HarnessId, string> = { claude: "claudecode", codex: "codexcli" };
const HARNESS_NAME: Record<HarnessId, string> = { claude: "Claude Code", codex: "Codex" };

export const isHarness = (value: unknown): value is HarnessId => typeof value === "string" && (HARNESSES as readonly string[]).includes(value);
export const harnessName = (harness: HarnessId) => HARNESS_NAME[harness];

export interface HarnessSettings {
  model?: string;
  effort?: string;
  tools?: string[];
  disallowedTools?: string[];
  skills?: string[];
  mcp?: string[];
}

export interface FoundAgent {
  name: string;
  file: string;
  /** "rulesync", or the harness whose folder holds the file. */
  from: "rulesync" | HarnessId;
  scope: "project" | "global";
  /** The harness a step runs on when it names none. */
  harness: HarnessId;
  description?: string;
  prompt: string;
  isolation?: "worktree";
  timeout?: string;
  /** Settings for every harness. A harness's block replaces each one it sets. */
  common: HarnessSettings;
  blocks: Partial<Record<HarnessId, HarnessSettings>>;
}

export interface AgentProblem {
  name: string;
  files: string[];
  message: string;
}

export interface LookupSettings {
  projectDir: string;
  /** The folder that holds the user's global .rulesync folder. */
  rulesyncGlobal?: string;
  defaultHarness: HarnessId;
  /** Model for an agent whose harness block names none, when it is on that harness. */
  defaultModel?: string;
  env?: Record<string, string | undefined>;
}

/** The configured default harness, else the default model's harness, else Claude Code. */
export function defaultHarness(config: OrcConfig): HarnessId {
  if (isHarness(config.defaultHarness)) return config.defaultHarness;
  return config.defaultModel?.includes("/") ? routeHarness(config.defaultModel)! : "claude";
}

/** What the agent and MCP lookups need for a project. */
export function lookupSettings(paths: HomePaths, projectDir: string, config: OrcConfig = loadConfig(paths), env: Record<string, string | undefined> = process.env): LookupSettings {
  const global = config.rulesyncGlobal?.replace(/^~(?=$|\/)/, homedir());
  return {
    projectDir,
    ...(global ? { rulesyncGlobal: resolve(global) } : {}),
    defaultHarness: defaultHarness(config),
    ...(config.defaultModel ? { defaultModel: config.defaultModel } : {}),
    env,
  };
}

export interface AgentLookup {
  settings: LookupSettings;
  agents: Map<string, FoundAgent>;
  /** Names that can't be used as they are, with what to change. */
  problems: Map<string, AgentProblem>;
}

/** A harness's login in env. Only its adapter names the variables. */
export function loginOf(harness: HarnessId, env: Record<string, string | undefined> = process.env) {
  return createHarness(harness).login(env);
}

/** env with the account on it, for the program started outside a step. */
export function envFor(harness: HarnessId, account: Account | undefined, base: Record<string, string | undefined> = process.env) {
  return createHarness(harness).env(account, base);
}

/** The home folder of each harness, moved by the same variables the harnesses read. */
export function harnessHomes(env: Record<string, string | undefined> = process.env) {
  const claude = loginOf("claude", env);
  return {
    claude: resolve(claude.folder),
    claudeJson: claude.value ? join(claude.value, ".claude.json") : join(homedir(), ".claude.json"),
    codex: resolve(loginOf("codex", env).folder),
  };
}

// ---- reading files ----

const strings = (value: unknown): string[] | undefined => {
  if (typeof value === "string") {
    const items = value.split(",").map((item) => item.trim()).filter(Boolean);
    return items.length ? items : undefined;
  }
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return undefined;
};

/** Server names from a list of names, or from an object keyed by name. */
const serverNames = (value: unknown): string[] | undefined => {
  if (Array.isArray(value)) {
    return value.flatMap((item) => (typeof item === "string" ? [item] : item && typeof item === "object" ? Object.keys(item) : []));
  }
  if (value && typeof value === "object") return Object.keys(value);
  return undefined;
};

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function compact(settings: HarnessSettings): HarnessSettings {
  return Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined)) as HarnessSettings;
}

/** Top-level `key: value` lines, for a harness's file whose frontmatter strict YAML rejects,
 *  such as a description with a colon in it, which Claude Code accepts. */
function looseFrontmatter(yaml: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const line of yaml.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (!match || !match[2]) continue;
    const value = match[2].trim();
    out[match[1]!] = value.startsWith("[") && value.endsWith("]")
      ? value.slice(1, -1).split(",").map((item) => item.trim().replace(/^["']|["']$/g, "")).filter(Boolean)
      : value.replace(/^["']|["']$/g, "");
  }
  return out;
}

function splitFrontmatter(content: string, file: string, loose = false): { data: Record<string, unknown>; body: string } {
  const match = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(content);
  if (!match) return { data: {}, body: content.trim() };
  let data: unknown;
  try {
    data = parseYaml(match[1]!);
  } catch (error) {
    if (!loose) throw new Error(`${file}: the frontmatter is not valid YAML: ${(error as Error).message}`);
    data = looseFrontmatter(match[1]!);
  }
  return { data: record(data), body: (match[2] ?? "").trim() };
}

/** Claude Code's own fields, in a .claude/agents file or a rulesync claudecode block. */
function claudeSettings(data: Record<string, unknown>): HarnessSettings {
  const model = text(data.model);
  return compact({
    model: model === "inherit" ? undefined : model,
    effort: text(data.effort),
    tools: strings(data.tools),
    disallowedTools: strings(data.disallowedTools),
    skills: strings(data.skills),
    mcp: serverNames(data.mcpServers),
  });
}

/** Codex's own fields, in a .codex/agents file or a rulesync codexcli block. */
function codexSettings(data: Record<string, unknown>): HarnessSettings {
  return compact({
    model: text(data.model),
    effort: text(data.model_reasoning_effort),
    skills: strings(data.skills),
    mcp: serverNames(data.mcpServers),
  });
}

function files(dir: string, ext: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => extname(name) === ext)
      .sort()
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

type Parsed = Omit<FoundAgent, "scope">;

function readRulesyncAgent(file: string, defaultHarness: HarnessId): Parsed {
  const { data, body } = splitFrontmatter(readFileSync(file, "utf8"), file);
  const orc = record(data.orc);
  if (orc.harness !== undefined && !isHarness(orc.harness)) {
    throw new Error(`${file}: orc.harness is "${String(orc.harness)}". Use one of ${HARNESSES.join(", ")}.`);
  }
  const blocks: Partial<Record<HarnessId, HarnessSettings>> = {};
  for (const harness of HARNESSES) {
    const block = data[RULESYNC_BLOCK[harness]];
    if (block === undefined) continue;
    const fields = record(block);
    blocks[harness] = harness === "claude" ? claudeSettings(fields) : codexSettings(fields);
  }
  const claude = record(data.claudecode);
  return {
    name: text(data.name) ?? basename(file, ".md"),
    file,
    from: "rulesync",
    harness: isHarness(orc.harness) ? orc.harness : defaultHarness,
    ...(text(data.description) ? { description: text(data.description) } : {}),
    prompt: body,
    ...(data.isolation === "worktree" || claude.isolation === "worktree" ? { isolation: "worktree" as const } : {}),
    ...(data.timeout !== undefined ? { timeout: String(data.timeout) } : {}),
    common: compact({
      effort: text(data.effort),
      tools: strings(data.tools),
      disallowedTools: strings(data.disallowedTools),
      skills: strings(data.skills),
      mcp: serverNames(data.mcpServers) ?? strings(data.mcp),
    }),
    blocks,
  };
}

function readClaudeAgent(file: string): Parsed {
  const { data, body } = splitFrontmatter(readFileSync(file, "utf8"), file, true);
  return {
    name: text(data.name) ?? basename(file, ".md"),
    file,
    from: "claude",
    harness: "claude",
    ...(text(data.description) ? { description: text(data.description) } : {}),
    prompt: body,
    ...(data.isolation === "worktree" ? { isolation: "worktree" as const } : {}),
    common: {},
    blocks: { claude: claudeSettings(data) },
  };
}

function readCodexAgent(file: string): Parsed {
  let data: Record<string, unknown>;
  try {
    data = record(parseToml(readFileSync(file, "utf8")));
  } catch (error) {
    throw new Error(`${file}: not valid TOML: ${(error as Error).message}`);
  }
  return {
    name: text(data.name) ?? basename(file, ".toml"),
    file,
    from: "codex",
    harness: "codex",
    ...(text(data.description) ? { description: text(data.description) } : {}),
    prompt: typeof data.developer_instructions === "string" ? data.developer_instructions.trim() : "",
    common: {},
    blocks: { codex: codexSettings(data) },
  };
}

/** The agents in one folder, by name. A file that doesn't parse is a problem for its name. */
function readFolder(paths: string[], read: (file: string) => Parsed, problems: Map<string, AgentProblem>): Map<string, Parsed> {
  const out = new Map<string, Parsed>();
  for (const file of paths) {
    try {
      const agent = read(file);
      if (!out.has(agent.name)) out.set(agent.name, agent);
    } catch (error) {
      const name = basename(file, extname(file));
      if (!problems.has(name)) problems.set(name, { name, files: [file], message: (error as Error).message });
    }
  }
  return out;
}

export function rulesyncFolders(settings: Pick<LookupSettings, "projectDir" | "rulesyncGlobal">) {
  return {
    project: join(settings.projectDir, ".rulesync"),
    ...(settings.rulesyncGlobal ? { global: join(resolve(settings.rulesyncGlobal), ".rulesync") } : {}),
  };
}

const moveHint = (name: string) => `Move it to rulesync, as .rulesync/subagents/${name}.md in the project or in the global rulesync folder, so one file serves every harness.`;

/** Every agent orc can find for a project, and the names that can't be used as they are. */
export function lookupAgents(settings: LookupSettings): AgentLookup {
  const env = settings.env ?? process.env;
  const homes = harnessHomes(env);
  const problems = new Map<string, AgentProblem>();
  const agents = new Map<string, FoundAgent>();
  const rulesync = rulesyncFolders(settings);

  const rulesyncLevels: Array<[FoundAgent["scope"], string | undefined]> = [
    ["project", rulesync.project],
    ["global", rulesync.global],
  ];
  for (const [scope, root] of rulesyncLevels) {
    if (!root) continue;
    const found = readFolder(files(join(root, "subagents"), ".md"), (file) => readRulesyncAgent(file, settings.defaultHarness), problems);
    for (const [name, agent] of found) if (!agents.has(name) && !problems.has(name)) agents.set(name, { ...agent, scope });
  }

  // The harnesses' own folders. The project's folders come first. When an agent is in both
  // harnesses' folders of the same level, the default harness's copy wins.
  const p = settings.projectDir;
  const levels: Array<[FoundAgent["scope"], Array<[HarnessId, string[], (file: string) => Parsed]>]> = [
    ["project", [
      ["claude", files(join(p, ".claude", "agents"), ".md"), readClaudeAgent],
      ["codex", files(join(p, ".codex", "agents"), ".toml"), readCodexAgent],
    ]],
    ["global", [
      ["claude", files(join(homes.claude, "agents"), ".md"), readClaudeAgent],
      ["codex", files(join(homes.codex, "agents"), ".toml"), readCodexAgent],
    ]],
  ];
  const settled = new Set([...agents.keys(), ...problems.keys()]);
  for (const [scope, folders] of levels) {
    const byName = new Map<string, Parsed[]>();
    for (const [, paths, read] of folders) {
      for (const [name, agent] of readFolder(paths, read, problems)) {
        if (settled.has(name)) continue;
        byName.set(name, [...(byName.get(name) ?? []), agent]);
      }
    }
    for (const [name, copies] of byName) {
      if (problems.has(name)) continue;
      const chosen = copies.find((copy) => copy.harness === settings.defaultHarness) ?? copies[0]!;
      agents.set(name, { ...chosen, scope });
    }
    for (const name of byName.keys()) settled.add(name);
  }
  return { settings, agents, problems };
}

// ---- harness choice ----

/** Harnesses orc ran before. A model that names one is refused, so it never runs elsewhere. */
const REMOVED_HARNESSES = ["pi", "opencode"];

/** Why a model spec can't run, when it names a harness orc no longer runs. */
export function removedHarness(spec: string | undefined): string | undefined {
  const first = spec?.split("/")[0]?.toLowerCase();
  if (!first || !REMOVED_HARNESSES.includes(first)) return undefined;
  return `model "${spec}" names the harness "${first}", which orc no longer runs. Use one of ${HARNESSES.join(", ")}.`;
}

/** The harness a model spec routes to. */
export function routeHarness(spec: string | undefined, env: Record<string, string | undefined> = process.env): HarnessId | undefined {
  if (spec === undefined) return undefined;
  const first = spec.split("/")[0]!.toLowerCase();
  if (isHarness(first)) return first;
  const configured = env.AGENTPRISM_DEFAULT_BACKEND?.toLowerCase();
  return isHarness(configured) ? configured : "claude";
}

/** The settings an agent runs with on a harness: its own block over its common settings. */
export function settingsFor(agent: FoundAgent, harness: HarnessId): HarnessSettings {
  return { ...agent.common, ...(agent.blocks[harness] ?? {}) };
}

/** The model spec for a harness: the block's model, else the run's model when it is on that
 *  harness, else the harness alone, which runs the harness's own default model. */
export function modelFor(harness: HarnessId, model: string | undefined, fallback?: string, env: Record<string, string | undefined> = process.env): string {
  if (model) return `${harness}/${model}`;
  if (fallback && routeHarness(fallback, env) === harness) return fallback;
  return harness;
}

/**
 * The model a harness takes: the spec without its harness. A harness alone gives none. An agent
 * file whose model names its harness, such as `model: claude/haiku`, gives the spec
 * claude/claude/haiku, which the journal and the run record keep, so the harness is dropped twice.
 */
export function stepModel(spec: string | undefined): string | undefined {
  if (!spec) return undefined;
  const [first, ...rest] = spec.split("/");
  if (!isHarness(first!.toLowerCase())) return spec;
  const model = rest[0]?.toLowerCase() === first!.toLowerCase() ? rest.slice(1) : rest;
  return model.length ? model.join("/") : undefined;
}

/** The spec with its harness, such as claude/haiku, for the step's record. */
export function withHarness(harness: HarnessId, id: string): string {
  return isHarness(id.split("/")[0]!.toLowerCase()) ? id : `${harness}/${id}`;
}

/**
 * An agent's definition, as its default harness block gives it. A workflow script names an agent
 * with `agent("audit this dir", { agentType: "security-auditor" })`, and routeStep turns the
 * agent's default block into a definition only to hash it.
 *
 * Bound: `tools` (allowlist), `disallowedTools` (denylist), `model`, and the
 * markdown body (`prompt`). `skills`, `mcp`, `effort` and `timeout` are defaults that
 * a step's own values replace. Wired: `isolation` ("worktree") → createWorktree().
 */
export interface AgentDefinition {
  /** Stable identity used as the `agentType` value. */
  name: string;
  /** One-line summary (for discoverability in the tool guideline). */
  description?: string;
  /** Allowlist of coding-tool names the subagent may use. Undefined = all. */
  tools?: string[];
  /** Denylist of coding-tool names, applied after the allowlist. */
  disallowedTools?: string[];
  /** Model spec: optional registered harness prefix plus a verbatim id, or a backend-only name. */
  model?: string;
  /** Isolation mode. When "worktree", agents using this type run in a git worktree. */
  isolation?: "worktree";
  /** Default skills for this agent. A step's list replaces them. */
  skills?: string[];
  /** Default MCP server names (from the host's servers file). A step's list replaces them. */
  mcp?: string[];
  /** Default reasoning effort. */
  effort?: string;
  /** Default time limit for one attempt, such as "10m". */
  timeout?: string;
  /** Markdown body, prepended to the subagent's task as role guidance. */
  prompt: string;
  /** Where the definition was loaded from (project wins over user). */
  source: "project" | "user";
}

/**
 * A stable identity string for a resolved definition, folded into the resume
 * call-hash so editing an agent `.md` invalidates that call's cached result.
 *
 * Keep the serialization as it is: it is part of each agent call's resume hash,
 * so a change would make every old journal miss.
 */
export function agentDefinitionKey(def: AgentDefinition | undefined): string | null {
  if (!def) return null;
  return JSON.stringify({
    tools: def.tools ?? null,
    disallowedTools: def.disallowedTools ?? null,
    model: def.model ?? null,
    isolation: def.isolation ?? null,
    // Only when set, so older journals keep replaying.
    ...(def.skills ? { skills: def.skills } : {}),
    ...(def.effort ? { effort: def.effort } : {}),
    prompt: def.prompt,
  });
}

/** An agent as the engine sees it. With no model in its block, the run's model applies. */
export function definitionOf(agent: FoundAgent): AgentDefinition {
  const settings = settingsFor(agent, agent.harness);
  return {
    name: agent.name,
    ...(agent.description ? { description: agent.description } : {}),
    ...(settings.tools ? { tools: settings.tools } : {}),
    ...(settings.disallowedTools ? { disallowedTools: settings.disallowedTools } : {}),
    ...(settings.model ? { model: modelFor(agent.harness, settings.model) } : {}),
    ...(agent.isolation ? { isolation: agent.isolation } : {}),
    ...(settings.skills ? { skills: settings.skills } : {}),
    ...(settings.mcp ? { mcp: settings.mcp } : {}),
    ...(settings.effort ? { effort: settings.effort } : {}),
    ...(agent.timeout ? { timeout: agent.timeout } : {}),
    prompt: agent.prompt,
    source: agent.scope === "project" ? "project" : "user",
  };
}

export function missingAgent(lookup: AgentLookup, name: string): string {
  const global = lookup.settings.rulesyncGlobal
    ? `the global rulesync folder (${lookup.settings.rulesyncGlobal}/.rulesync/subagents/)`
    : "the global rulesync folder (none is set: rulesyncGlobal in ~/.orchestrator/config.json)";
  return `no agent "${name}". orc looks in .rulesync/subagents/, then ${global}, then .claude/agents/ and .codex/agents/ in the project and in the home folder.`;
}

export function wrongHarness(agent: FoundAgent, harness: HarnessId): string {
  const from = agent.from as HarnessId;
  return `agent "${agent.name}" comes from ${agent.file}, a ${HARNESS_NAME[from]} folder, so it runs only on ${HARNESS_NAME[from]}, and this step sends it to ${HARNESS_NAME[harness]}. ${moveHint(agent.name)}`;
}

/** The values a step set itself, apart from its agent's. */
export interface StepGiven {
  model?: string;
  effort?: string;
  skills?: string[];
  mcp?: string[];
}

export interface StepPlan {
  agent: FoundAgent;
  harness: HarnessId;
  model: string;
  effort?: string;
  tools?: string[];
  disallowedTools?: string[];
  skills?: string[];
  mcp?: string[];
}

/**
 * How a step that names an agent runs. A step that names a harness alone as its model, such as
 * "codex", gets the model of the agent's block for that harness. An agent from a harness's own
 * folder runs only on that harness. `fallback` is the run's model, for a block with none.
 */
export function planStep(lookup: AgentLookup, name: string, given: StepGiven = {}, fallback?: string): { plan: StepPlan } | { problem: string } {
  const agent = lookup.agents.get(name);
  if (!agent) return { problem: lookup.problems.get(name)?.message ?? missingAgent(lookup, name) };
  const env = lookup.settings.env ?? process.env;
  const harness = given.model ? routeHarness(given.model, env)! : agent.harness;
  if (agent.from !== "rulesync" && agent.from !== harness) return { problem: wrongHarness(agent, harness) };
  const settings = settingsFor(agent, harness);
  const bare = given.model !== undefined && given.model.toLowerCase() === harness;
  const model = given.model && !bare ? given.model : modelFor(harness, settings.model, fallback ?? lookup.settings.defaultModel, env);
  return {
    plan: {
      agent,
      harness,
      model,
      ...(given.effort ?? settings.effort ? { effort: given.effort ?? settings.effort } : {}),
      ...(settings.tools ? { tools: settings.tools } : {}),
      ...(settings.disallowedTools ? { disallowedTools: settings.disallowedTools } : {}),
      ...(given.skills ?? settings.skills ? { skills: given.skills ?? settings.skills } : {}),
      ...(given.mcp ?? settings.mcp ? { mcp: given.mcp ?? settings.mcp } : {}),
    },
  };
}

/** What a step runs with, once it is routed. */
export interface RoutePlan {
  harness: HarnessId;
  /** The model spec, such as claude/haiku, or a harness alone. */
  model?: string;
  effort?: string;
  skills?: string[];
  mcp?: string[];
  tools?: string[];
  disallowedTools?: string[];
  timeoutMs?: number;
}

/** A time limit in milliseconds, such as 600000 for "10m". */
function millis(value: number | string | undefined): number | undefined {
  const seconds = parseDurationSeconds(value);
  return seconds === undefined ? undefined : Math.round(seconds * 1000);
}

/** The values the step set itself, apart from its agent's. */
const givenOf = (ask: StepAsk): StepGiven => ({
  ...(ask.model === undefined ? {} : { model: ask.model }),
  ...(ask.effort === undefined ? {} : { effort: ask.effort }),
  ...(ask.skills === undefined ? {} : { skills: [...ask.skills] }),
  ...(ask.mcp === undefined ? {} : { mcp: [...ask.mcp] }),
});

/**
 * Where a step goes. The model it asks for is its own, else its agent's on the agent's default
 * harness, else the run's. That model and the agent key go into the call hash, so both keep
 * the format they had before routing moved here. The key covers the default harness's block
 * only. The route never throws: a step that cannot run gets a problem, which the runner
 * refuses when it runs the step.
 */
export function routeStep(lookup: AgentLookup | undefined, ask: StepAsk): StepRoute {
  const found = ask.agentType ? lookup?.agents.get(ask.agentType) : undefined;
  const def = found && definitionOf(found);
  const requested = ask.model ?? def?.model ?? ask.runModel;
  const isolation = ask.isolation ?? def?.isolation;
  const frozen: StepRoute = {
    ...(requested === undefined ? {} : { requested }),
    agentKey: agentDefinitionKey(def),
    ...(isolation === undefined ? {} : { isolation }),
    ...(def ? { prompt: def.prompt } : {}),
  };
  const removed = removedHarness(requested);
  if (removed) return { ...frozen, problem: removed };
  const timeoutMs = millis(ask.timeout ?? found?.timeout);
  const timed = timeoutMs === undefined ? {} : { timeoutMs };
  if (ask.agentType && lookup) {
    const planned = planStep(lookup, ask.agentType, givenOf(ask), requested);
    if ("problem" in planned) return { ...frozen, problem: planned.problem };
    const { agent: _agent, ...plan } = planned.plan;
    return { ...frozen, plan: { ...plan, ...timed } };
  }
  const env = lookup?.settings.env ?? process.env;
  return {
    ...frozen,
    plan: {
      harness: routeHarness(requested, env) ?? lookup?.settings.defaultHarness ?? "claude",
      ...(requested ? { model: requested } : {}),
      ...(ask.effort === undefined ? {} : { effort: ask.effort }),
      ...(ask.skills === undefined ? {} : { skills: [...ask.skills] }),
      ...(ask.mcp === undefined ? {} : { mcp: [...ask.mcp] }),
      ...timed,
    },
  };
}

// ---- MCP servers ----

/** JSON with comments and trailing commas, as rulesync's mcp.jsonc allows. */
export function parseJsonc(source: string): unknown {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== '"') j += source[j] === "\\" ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
    } else if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 2;
    } else {
      out += ch;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

function readConfig(file: string, parse: (source: string) => unknown): Record<string, unknown> | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return record(parse(readFileSync(file, "utf8")));
  } catch (error) {
    throw new Error(`${file} does not parse: ${(error as Error).message}`);
  }
}

function expand(value: string, vars: Record<string, string | undefined>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => vars[name] ?? "");
}

const pairs = (value: unknown, vars: Record<string, string | undefined>) =>
  Object.entries(record(value)).map(([key, item]) => ({ name: key, value: expand(String(item), vars) }));

/** A server in rulesync's or Claude Code's shape: { command, args, env } or { type, url, headers }. */
function serverOf(name: string, entry: Record<string, unknown>, vars: Record<string, string | undefined>, file: string): McpServerConfig {
  const type = typeof entry.type === "string" ? entry.type : undefined;
  const url = typeof entry.url === "string" ? entry.url : typeof entry.httpUrl === "string" ? entry.httpUrl : undefined;
  if (url && type !== "stdio") {
    return { type: type === "sse" ? "sse" : "http", name, url: expand(url, vars), headers: pairs(entry.headers ?? entry.http_headers, vars) };
  }
  if (Array.isArray(entry.command)) {
    // The command may be the program and its arguments in one list.
    const [command, ...args] = entry.command.map(String);
    if (!command) throw new Error(`${file}: MCP server "${name}" has an empty command`);
    return { name, command: expand(command, vars), args: args.map((arg) => expand(arg, vars)), env: pairs(entry.environment ?? entry.env, vars) };
  }
  if (typeof entry.command !== "string") throw new Error(`${file}: MCP server "${name}" needs a command or a url`);
  return {
    name,
    command: expand(entry.command, vars),
    args: (Array.isArray(entry.args) ? entry.args : []).map((arg) => expand(String(arg), vars)),
    env: pairs(entry.env, vars),
  };
}

interface ServerSource {
  file: string;
  servers: Record<string, unknown>;
}

export interface FoundServer {
  server: McpServerConfig;
  file: string;
}

export interface McpLookup {
  /** The server a step on this harness gets for a name: rulesync's, else the harness's own. */
  find(name: string, harness: HarnessId): FoundServer | undefined;
  /** Where orc looked for a name, for the message when it is nowhere. */
  places(harness: HarnessId): string[];
}

/** rulesync's mcp.jsonc, the project's then the global one, then each harness's own config. */
export function lookupMcpServers(settings: LookupSettings, vars: Record<string, string | undefined> = process.env): McpLookup {
  const env = settings.env ?? process.env;
  const homes = harnessHomes(env);
  const rulesync = rulesyncFolders(settings);
  const p = settings.projectDir;
  const json = (source: string) => JSON.parse(source) as unknown;

  const rulesyncSources: ServerSource[] = [];
  for (const root of [rulesync.project, rulesync.global]) {
    if (!root) continue;
    for (const name of ["mcp.jsonc", ".mcp.json"]) {
      const file = join(root, name);
      const config = readConfig(file, parseJsonc);
      if (config) {
        rulesyncSources.push({ file, servers: record(config.mcpServers) });
        break;
      }
    }
  }

  const own = new Map<HarnessId, ServerSource[]>();
  const claude: ServerSource[] = [];
  const claudeJson = readConfig(homes.claudeJson, json);
  if (claudeJson) claude.push({ file: `${homes.claudeJson} (this project)`, servers: record(record(record(claudeJson.projects)[resolve(p)]).mcpServers) });
  const projectMcp = readConfig(join(p, ".mcp.json"), json);
  if (projectMcp) claude.push({ file: join(p, ".mcp.json"), servers: record(projectMcp.mcpServers) });
  if (claudeJson) claude.push({ file: homes.claudeJson, servers: record(claudeJson.mcpServers) });
  own.set("claude", claude);

  const codex: ServerSource[] = [];
  for (const file of [join(p, ".codex", "config.toml"), join(homes.codex, "config.toml")]) {
    const config = readConfig(file, parseToml);
    if (config) codex.push({ file, servers: record(config.mcp_servers) });
  }
  own.set("codex", codex);

  const search = (harness: HarnessId) => [...rulesyncSources, ...(own.get(harness) ?? [])];
  return {
    find(name, harness) {
      for (const source of search(harness)) {
        const entry = source.servers[name];
        if (entry && typeof entry === "object") return { server: serverOf(name, record(entry), vars, source.file), file: source.file };
      }
      return undefined;
    },
    places(harness) {
      const where = [join(rulesync.project, "mcp.jsonc")];
      if (rulesync.global) where.push(join(rulesync.global, "mcp.jsonc"));
      if (harness === "claude") where.push(join(p, ".mcp.json"), homes.claudeJson);
      if (harness === "codex") where.push(join(p, ".codex", "config.toml"), join(homes.codex, "config.toml"));
      return where;
    },
  };
}

export function missingServer(name: string, harness: HarnessId, mcp: McpLookup): string {
  return `no MCP server "${name}" for ${HARNESS_NAME[harness]}. orc looks in ${mcp.places(harness).join(", ")}. Add it to .rulesync/mcp.jsonc.`;
}
