// The sous home folder (~/.sous, or $SOUS_HOME) and a project's .sous folder.
// A project's workflows win over the home folder's.

import { constants, copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { readStrictJsonFile, writeJsonFile } from "../json-file.js";
import { runFolders } from "./store.js";

export type Place = "worktree" | "folder" | "none";

export interface OrcConfig {
  /** Agents running at once across every run on this machine. Code steps don't count. */
  maxAgents: number;
  /** Where a run works when neither the workflow nor the command says. */
  defaultPlace: Place;
  /** Model for agent steps that name none. */
  defaultModel?: string;
  /** The harness of a rulesync agent that names none in its sous block. sous checks the name. */
  defaultHarness?: string;
  /** The folder that holds the user's global .rulesync folder, such as ~/.aiglobal. */
  rulesyncGlobal?: string;
  /** Send a macOS notice when a run asks something, pauses or ends. */
  notify: boolean;
  /** How long to keep finished runs. Undefined keeps them all. */
  keepDays?: number;
  /** Retries of a failed step before the run pauses on it, when the step sets none. At most 4. */
  retries: number;
  /** The Claude Code program, when sous should not look for it on PATH. */
  claudePath?: string;
  /** The Codex program, when sous should not look for it on PATH. */
  codexPath?: string;
  /** The most tokens one go of a run may spend, when the command gives no --budget. None by default. */
  budgetTokens?: number;
}

const DEFAULT_CONFIG: OrcConfig = { maxAgents: 4, defaultPlace: "worktree", notify: true, retries: 2 };

function sousHome(): string {
  return resolve(process.env.SOUS_HOME ?? join(homedir(), ".sous"));
}

export function homePaths(home = sousHome()) {
  return {
    home,
    runs: join(home, "runs"),
    ...runFolders(home),
    workflows: join(home, "workflows"),
    worktrees: join(home, "worktrees"),
    scratch: join(home, "scratch"),
    config: join(home, "config.json"),
    secrets: join(home, "secrets.env"),
    accounts: join(home, "accounts.json"),
    schedules: join(home, "schedules.json"),
    projects: join(home, "projects.json"),
    /** The person's yes to each workflow file's text, by hash. */
    approvals: join(home, "approvals.json"),
    /** The approved texts, one <hash>.json each. */
    approved: join(home, "approved"),
    /** When sous seeded the approvals at first use. With it there, sous never seeds again. */
    seeded: join(home, "seeded.json"),
    daemonPid: join(home, "daemon.pid"),
    daemonState: join(home, "daemon-state.json"),
    /** Who did what: one line per write. */
    actions: join(home, "events.jsonl"),
    /** Each call of the cli, with SOUS_TRACE_CALLS=1. */
    calls: join(home, "calls.jsonl"),
    /** The saved workflows the person removed from the page sous serve opens. */
    trash: join(home, "trash"),
  };
}

export type HomePaths = ReturnType<typeof homePaths>;

export function ensureHome(paths: HomePaths = homePaths()): HomePaths {
  for (const dir of [paths.runs, ...Object.values(runFolders(paths.home)), paths.worktrees, paths.scratch]) {
    mkdirSync(dir, { recursive: true });
  }
  return paths;
}

/** Why sous can't write to its home, or undefined when a probe file goes in and out. Under the
 *  Codex sandbox the home is often outside the folders it lets a command write. */
export function homeWriteProblem(paths: HomePaths = homePaths()): string | undefined {
  const probe = join(paths.home, `.write-check-${process.pid}`);
  try {
    mkdirSync(paths.home, { recursive: true });
    writeFileSync(probe, "");
    unlinkSync(probe);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

/** The config file as a person reads it, with ~ for the home folder when it is under it. */
export function configName(paths: Pick<HomePaths, "config">): string {
  const home = homedir();
  return paths.config.startsWith(`${home}${sep}`) ? `~${paths.config.slice(home.length)}` : paths.config;
}

export function loadConfig(paths: HomePaths = homePaths()): OrcConfig {
  return { ...DEFAULT_CONFIG, ...readStrictJsonFile<Partial<OrcConfig>>(paths.config, {}) };
}

/** The project a command runs for: the nearest folder up with .sous or .git, else cwd. */
export function findProjectDir(cwd = process.cwd()): string {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ".sous")) || existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(cwd);
    dir = parent;
  }
}

/** The projects where sous ran, whose workflow files the service reads for a schedule. */
export function knownProjects(paths: HomePaths = homePaths()): string[] {
  try {
    return readStrictJsonFile<string[]>(paths.projects, []).filter((dir) => typeof dir === "string");
  } catch {
    return [];
  }
}

export function rememberProject(paths: HomePaths, projectDir: string): void {
  const dir = resolve(projectDir);
  const known = knownProjects(paths);
  if (known.includes(dir) || !existsSync(join(dir, ".sous", "workflows"))) return;
  mkdirSync(paths.home, { recursive: true });
  writeJsonFile(paths.projects, [...known, dir]);
}

export function workflowDirs(projectDir: string, paths: HomePaths = homePaths()): string[] {
  return [join(projectDir, ".sous", "workflows"), paths.workflows];
}

/**
 * Move a file into the home's trash folder, under its own name, or with -2, -3 and on before its
 * extension when the trash has that name. A file in the trash is never replaced. Returns where the
 * file went.
 */
export function moveToTrash(paths: HomePaths, file: string): string {
  mkdirSync(paths.trash, { recursive: true });
  const name = basename(file);
  const dot = name.indexOf(".", 1);
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 1; ; n++) {
    const target = join(paths.trash, n === 1 ? name : `${stem}-${n}${ext}`);
    if (!placeNew(file, target)) continue;
    unlinkSync(file);
    return target;
  }
}

/** Put a copy of the file at target, or return false when target exists. A hard link fails on
 *  another disk, and a copy that refuses an existing target takes over. */
function placeNew(file: string, target: string): boolean {
  try {
    linkSync(file, target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
  }
  try {
    copyFileSync(file, target, constants.COPYFILE_EXCL);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
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
