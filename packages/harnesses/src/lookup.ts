// Finding an installed program and reading its version. Ported from sous's programs.ts.
// The order is the adapter's own variable, the caller's path, PATH, then the usual folders.
// On PATH it skips wrapper scripts, such as a launcher that picks an account, since the adapter
// needs the program itself. An official npm launcher counts as the program.

import { execFile } from "node:child_process";
import { accessSync, closeSync, constants, openSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import type { FindOptions, Found } from "./types.js";

export interface ProgramInfo {
  name: string;
  command: string;
  /** The variable read first. */
  variable: string;
  /** Part of the real path of the official npm launcher, a node script. */
  launcher: string;
  install: string;
}

function usualDirs(): string[] {
  return [join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
}

const expand = (path: string) => resolve(path.replace(/^~(?=$|\/)/, homedir()));

/** "program" for a native file or an official launcher, "wrapper" for another script. */
function inspectFile(path: string, launcher: string): "program" | "wrapper" | undefined {
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

export function findProgram(info: ProgramInfo, options: FindOptions = {}): Found {
  const env = options.env ?? process.env;
  // A path the user gave is taken as is, also a script, but it has to exist.
  const given: Array<["variable" | "config", string, string | undefined]> = [
    ["variable", info.variable, env[info.variable]],
    ["config", options.setting ?? "The configured path", options.path],
  ];
  for (const [source, where, value] of given) {
    if (!value) continue;
    const path = expand(value);
    if (inspectFile(path, info.launcher)) return { path, source, skipped: [], others: [] };
    return { skipped: [], problem: `${where} is ${value}, which is not a program file. Point it at ${info.name}, or remove it.` };
  }

  const pathDirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const extra = options.usualDirs ?? usualDirs();
  const skipped: string[] = [];
  const seen = new Set<string>();
  let found: Extract<Found, { path: string }> | undefined;
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
    found = { path, source: i < pathDirs.length ? "path" : "usual folder", skipped, others: [] };
  }
  if (found) return found;
  const wrappers = skipped.length
    ? ` It passed over ${skipped.join(", ")}, ${skipped.length === 1 ? "a wrapper script" : "wrapper scripts"}, since the adapter needs the program itself.`
    : "";
  return {
    skipped,
    problem: `${info.name} is not installed: no ${info.command} program on PATH or in ${extra.join(", ")}.${wrappers} Install it with \`${info.install}\`, or ${options.setting ? `set ${options.setting}` : "give its path"}.`,
  };
}

function sameFile(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

const versions = new Map<string, Promise<string | undefined>>();

/** The program's version from `--version`, such as 2.1.330, cached by file and change time. */
export function programVersion(path: string, timeoutMs = 20_000): Promise<string | undefined> {
  let key: string;
  try {
    key = `${realpathSync(path)}:${statSync(path).mtimeMs}`;
  } catch {
    return Promise.resolve(undefined);
  }
  let version = versions.get(key);
  if (!version) {
    version = new Promise((done) => {
      execFile(path, ["--version"], { encoding: "utf8", timeout: timeoutMs }, (error, out) => {
        done(error ? undefined : /\d+\.\d+\.\d+[0-9A-Za-z.+-]*/.exec(out)?.[0]);
      });
    });
    versions.set(key, version);
  }
  return version;
}

/** Compares two dotted versions by their numbers. Negative when a is older. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}
