// The orc home folder (~/.orchestrator, or $ORC_HOME) and a project's .orchestrator folder.
// A project's workflows win over the home folder's. Agents and MCP servers come from rulesync
// and the harnesses' own folders (agents.ts).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isHarness, routeHarness, type Harness, type LookupSettings } from "./agents.js";

export type Place = "worktree" | "folder" | "none";

export interface OrcConfig {
  /** Agents running at once across every run on this machine. Code steps don't count. */
  maxAgents: number;
  /** Where a run works when neither the workflow nor the command says. */
  defaultPlace: Place;
  /** Model for agent steps that name none. */
  defaultModel?: string;
  /** The harness of a rulesync agent that names none in its orc block. */
  defaultHarness?: Harness;
  /** The folder that holds the user's global .rulesync folder, such as ~/.aiglobal. */
  rulesyncGlobal?: string;
  /** Send a macOS notice when a run asks something, pauses or ends. */
  notify: boolean;
  /** How long to keep finished runs. Undefined keeps them all. */
  keepDays?: number;
  /** Retries of a failed step before the run pauses on it, when the step sets none. At most 4. */
  retries: number;
  /** The Claude Code program, when orc should not look for it on PATH. */
  claudePath?: string;
  /** The Codex program, when orc should not look for it on PATH. */
  codexPath?: string;
}

const DEFAULT_CONFIG: OrcConfig = { maxAgents: 4, defaultPlace: "worktree", notify: true, retries: 2 };

export function orcHome(): string {
  return resolve(process.env.ORC_HOME ?? join(homedir(), ".orchestrator"));
}

export function homePaths(home = orcHome()) {
  return {
    home,
    runs: join(home, "runs"),
    records: join(home, "records"),
    inbox: join(home, "inbox"),
    slots: join(home, "slots"),
    queue: join(home, "queue"),
    workflows: join(home, "workflows"),
    worktrees: join(home, "worktrees"),
    scratch: join(home, "scratch"),
    logs: join(home, "logs"),
    config: join(home, "config.json"),
    secrets: join(home, "secrets.env"),
    schedules: join(home, "schedules.json"),
    projects: join(home, "projects.json"),
    daemonPid: join(home, "daemon.pid"),
    daemonState: join(home, "daemon-state.json"),
  };
}

export type HomePaths = ReturnType<typeof homePaths>;

export function ensureHome(paths: HomePaths = homePaths()): HomePaths {
  for (const dir of [paths.runs, paths.records, paths.inbox, paths.slots, paths.queue, paths.worktrees, paths.scratch, paths.logs]) {
    mkdirSync(dir, { recursive: true });
  }
  return paths;
}

function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`);
  }
}

export function loadConfig(paths: HomePaths = homePaths()): OrcConfig {
  return { ...DEFAULT_CONFIG, ...readJson<Partial<OrcConfig>>(paths.config, {}) };
}

/** The project a command runs for: the nearest folder up with .orchestrator or .git, else cwd. */
export function findProjectDir(cwd = process.cwd()): string {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ".orchestrator")) || existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(cwd);
    dir = parent;
  }
}

/** The projects where orc ran, whose workflow files the service reads for a schedule. */
export function knownProjects(paths: HomePaths = homePaths()): string[] {
  try {
    return readJson<string[]>(paths.projects, []).filter((dir) => typeof dir === "string");
  } catch {
    return [];
  }
}

export function rememberProject(paths: HomePaths, projectDir: string): void {
  const dir = resolve(projectDir);
  const known = knownProjects(paths);
  if (known.includes(dir) || !existsSync(join(dir, ".orchestrator", "workflows"))) return;
  mkdirSync(paths.home, { recursive: true });
  const temp = `${paths.projects}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify([...known, dir], null, 2)}\n`);
  renameSync(temp, paths.projects);
}

export function workflowDirs(projectDir: string, paths: HomePaths = homePaths()): string[] {
  return [join(projectDir, ".orchestrator", "workflows"), paths.workflows];
}

/** The configured default harness, else the default model's harness, else Claude Code. */
export function defaultHarness(config: OrcConfig): Harness {
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

/** KEY=VALUE lines from secrets.env. Lines starting with # are skipped. Quotes are removed. */
export function loadSecrets(paths: HomePaths = homePaths()): Record<string, string> {
  if (!existsSync(paths.secrets)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(paths.secrets, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[match[1]!] = value;
  }
  return out;
}
