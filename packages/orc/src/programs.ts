// The installed Claude Code and Codex that orc's agent steps run on. orc ships no copy of its
// own. It looks in this order: the adapter's own variable (CLAUDE_CODE_EXECUTABLE, CODEX_PATH),
// claudePath or codexPath in config.json, the folders on PATH, then the usual install folders.
// On PATH it skips wrapper scripts, such as a launcher that picks an account, since the adapters
// need the program itself. An official npm launcher counts as the program.

import { execFileSync } from "node:child_process";
import { accessSync, closeSync, constants, openSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

export const PROGRAMS = ["claude", "codex"] as const;
export type Program = (typeof PROGRAMS)[number];

export const isProgram = (value: unknown): value is Program => typeof value === "string" && (PROGRAMS as readonly string[]).includes(value);

interface ProgramInfo {
  name: string;
  command: string;
  /** The variable the adapter reads first. */
  variable: string;
  /** The key in config.json. */
  key: "claudePath" | "codexPath";
  /** Part of the real path of the official npm launcher, a node script. */
  launcher: string;
  install: string;
}

export const PROGRAM_INFO: Record<Program, ProgramInfo> = {
  claude: {
    name: "Claude Code",
    command: "claude",
    variable: "CLAUDE_CODE_EXECUTABLE",
    key: "claudePath",
    launcher: "/@anthropic-ai/claude-code/",
    install: "npm install -g @anthropic-ai/claude-code",
  },
  codex: {
    name: "Codex",
    command: "codex",
    variable: "CODEX_PATH",
    key: "codexPath",
    launcher: "/@openai/codex/bin/codex.js",
    install: "npm install -g @openai/codex",
  },
};

export interface FoundProgram {
  program: Program;
  /** The path the adapter runs, kept as found so an update behind a link applies. */
  path: string;
  source: "variable" | "config" | "path" | "usual folder";
  /** Wrapper scripts passed over on the way. */
  skipped: string[];
  /** Other copies further down PATH or in the usual folders, which orc does not use. */
  others: string[];
}

export interface MissingProgram {
  program: Program;
  problem: string;
  skipped: string[];
}

export type ProgramLookup = FoundProgram | MissingProgram;

export interface FindOptions {
  env?: Record<string, string | undefined>;
  config?: { claudePath?: string; codexPath?: string };
  /** Looked at after PATH. Default ~/.local/bin, /opt/homebrew/bin and /usr/local/bin. */
  usualDirs?: string[];
}

export function usualDirs(): string[] {
  return [join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
}

const expand = (path: string) => resolve(path.replace(/^~(?=$|\/)/, homedir()));

/** "program" for a native file or an official launcher, "wrapper" for another script. */
export function inspectFile(path: string, launcher: string): "program" | "wrapper" | undefined {
  try {
    if (!statSync(path).isFile()) return undefined;
    accessSync(path, constants.X_OK);
  } catch {
    return undefined;
  }
  const head = Buffer.alloc(2);
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    readSync(fd, head, 0, 2, 0);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (head.toString("latin1") !== "#!") return "program";
  try {
    return realpathSync(path).replace(/\\/g, "/").includes(launcher) ? "program" : "wrapper";
  } catch {
    return "wrapper";
  }
}

export function findProgram(program: Program, options: FindOptions = {}): ProgramLookup {
  const info = PROGRAM_INFO[program];
  const env = options.env ?? process.env;
  // A path the user gave is taken as is, also a script, but it has to exist.
  const given: Array<[FoundProgram["source"], string, string | undefined]> = [
    ["variable", info.variable, env[info.variable]],
    ["config", `${info.key} in config.json`, options.config?.[info.key]],
  ];
  for (const [source, where, value] of given) {
    if (!value) continue;
    const path = expand(value);
    if (inspectFile(path, info.launcher)) return { program, path, source, skipped: [], others: [] };
    return { program, skipped: [], problem: `${where} is ${value}, which is not a program file. Point it at ${info.name}, or remove it.` };
  }

  const pathDirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const extra = options.usualDirs ?? usualDirs();
  const skipped: string[] = [];
  const seen = new Set<string>();
  let found: FoundProgram | undefined;
  for (const [i, dir] of [...pathDirs, ...extra].entries()) {
    const path = join(resolve(dir), info.command);
    if (seen.has(path)) continue;
    seen.add(path);
    const kind = inspectFile(path, info.launcher);
    if (kind === "wrapper" && !found) skipped.push(path);
    if (kind !== "program") continue;
    if (found) {
      if (!sameFile(found.path, path)) found.others.push(path);
      continue;
    }
    found = { program, path, source: i < pathDirs.length ? "path" : "usual folder", skipped, others: [] };
  }
  if (found) return found;
  const wrappers = skipped.length
    ? ` It passed over ${skipped.join(", ")}, ${skipped.length === 1 ? "a wrapper script" : "wrapper scripts"}, since the adapter needs the program itself.`
    : "";
  return {
    program,
    skipped,
    problem: `${info.name} is not installed: no ${info.command} program on PATH or in ${extra.join(", ")}.${wrappers} Install it with \`${info.install}\`, or set ${info.key} in ~/.orchestrator/config.json.`,
  };
}

function sameFile(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

const versions = new Map<string, string | undefined>();

/** The program's version from `--version`, such as 2.1.329, cached by file and change time. */
export function programVersion(path: string, timeoutMs = 20_000): string | undefined {
  let key = path;
  try {
    key = `${realpathSync(path)}:${statSync(path).mtimeMs}`;
  } catch {
    return undefined;
  }
  if (versions.has(key)) return versions.get(key);
  let version: string | undefined;
  try {
    const out = execFileSync(path, ["--version"], { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "ignore"] });
    version = /\d+\.\d+\.\d+[0-9A-Za-z.+-]*/.exec(out)?.[0];
  } catch {
    version = undefined;
  }
  versions.set(key, version);
  return version;
}

/** The folder Claude Code keeps its account and settings in for orc's steps. */
export function claudeFolder(env: Record<string, string | undefined> = process.env): string {
  return env.CLAUDE_CONFIG_DIR ? expand(env.CLAUDE_CONFIG_DIR) : join(homedir(), ".claude");
}

/** The folder Codex keeps its account and settings in for orc's steps. */
export function codexFolder(env: Record<string, string | undefined> = process.env): string {
  return env.CODEX_HOME ? expand(env.CODEX_HOME) : join(homedir(), ".codex");
}
