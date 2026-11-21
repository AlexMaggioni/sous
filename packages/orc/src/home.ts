// The orc home folder (~/.orchestrator, or $ORC_HOME) and a project's .orchestrator folder.
// A project's agents, workflows and servers win over the home folder's.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import type { McpServerConfig } from "@automatalabs/shared-types";

export type Place = "worktree" | "folder" | "none";

export interface OrcConfig {
  /** Agents running at once across every run on this machine. Code steps don't count. */
  maxAgents: number;
  /** Where a run works when neither the workflow nor the command says. */
  defaultPlace: Place;
  /** Model for agent steps that name none. */
  defaultModel?: string;
  /** Send a macOS notice when a run asks something, pauses or ends. */
  notify: boolean;
  /** How long to keep finished runs. Undefined keeps them all. */
  keepDays?: number;
  /** Retries of a failed step before the run pauses on it, when the step sets none. At most 4. */
  retries: number;
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
    agents: join(home, "agents"),
    workflows: join(home, "workflows"),
    worktrees: join(home, "worktrees"),
    scratch: join(home, "scratch"),
    logs: join(home, "logs"),
    config: join(home, "config.json"),
    secrets: join(home, "secrets.env"),
    mcp: join(home, "mcp.json"),
    schedules: join(home, "schedules.json"),
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

export function workflowDirs(projectDir: string, paths: HomePaths = homePaths()): string[] {
  return [join(projectDir, ".orchestrator", "workflows"), paths.workflows];
}

/** The engine's agentsDir option: the project folder, then the home folder. */
export function agentsDirOption(projectDir: string, paths: HomePaths = homePaths()): string {
  return `${join(projectDir, ".orchestrator", "agents")}${delimiter}${paths.agents}`;
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

interface ServerEntry {
  type?: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/** Replace ${NAME} with the secret or environment value. */
function expand(value: string, vars: Record<string, string | undefined>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => vars[name] ?? "");
}

/**
 * Named MCP servers, from mcp.json in the home folder and in the project's .orchestrator
 * folder. The file maps a name to { command, args, env } or { type: "http", url, headers }.
 */
export function loadMcpServers(projectDir: string, paths: HomePaths = homePaths(), vars: Record<string, string | undefined> = process.env): Record<string, McpServerConfig> {
  const entries = {
    ...readJson<Record<string, ServerEntry>>(paths.mcp, {}),
    ...readJson<Record<string, ServerEntry>>(join(projectDir, ".orchestrator", "mcp.json"), {}),
  };
  const out: Record<string, McpServerConfig> = {};
  for (const [name, entry] of Object.entries(entries)) {
    const pairs = (record: Record<string, string> | undefined) =>
      Object.entries(record ?? {}).map(([key, value]) => ({ name: key, value: expand(String(value), vars) }));
    if (entry.type === "http" || entry.type === "sse") {
      if (!entry.url) throw new Error(`mcp server "${name}" needs a url`);
      out[name] = { type: entry.type, name, url: expand(entry.url, vars), headers: pairs(entry.headers) };
    } else {
      if (!entry.command) throw new Error(`mcp server "${name}" needs a command`);
      out[name] = { name, command: entry.command, args: (entry.args ?? []).map((arg) => expand(arg, vars)), env: pairs(entry.env) };
    }
  }
  return out;
}
