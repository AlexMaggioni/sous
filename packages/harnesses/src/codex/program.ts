// Where Codex is, which versions the adapter speaks to, and the environment a step runs in.

import { homedir } from "node:os";
import { join } from "node:path";
import { programVersion, type ProgramInfo } from "../lookup.js";
import type { Account } from "../types.js";

export const CODEX: ProgramInfo = {
  name: "Codex",
  command: "codex",
  variable: "CODEX_PATH",
  launcher: "/@openai/codex/bin/codex.js",
  install: "npm install -g @openai/codex",
};

/**
 * The Codex releases the adapter was checked against, by minor line. The app-server protocol
 * changes between minor releases, and src/codex/generated/ comes from the newest line here.
 */
const SUPPORTED = ["0.169"];

export async function codexVersion(path: string): Promise<{ version?: string; problem?: string }> {
  const version = await programVersion(path);
  if (!version) return { problem: `${path} --version printed no version. Check that it is Codex.` };
  const line = version.split(".").slice(0, 2).join(".");
  if (!SUPPORTED.includes(line)) {
    const needed = SUPPORTED.map((minor) => `${minor}.x`).join(" or ");
    const newest = SUPPORTED[SUPPORTED.length - 1];
    return {
      version,
      problem: `Codex ${version} is not a version the adapter supports. It needs ${needed}. Install it with \`${CODEX.install}@${newest}\`.`,
    };
  }
  return { version };
}

/** Codex's folder variable in env. Codex has no login token. */
export function codexLogin(env: Record<string, string | undefined> = process.env) {
  const value = env.CODEX_HOME || undefined;
  return { variable: "CODEX_HOME", ...(value ? { value } : {}), folder: value ?? join(homedir(), ".codex") };
}

/** Where Codex looks for user skills. Codex reads ~/.agents/skills whatever CODEX_HOME says. */
export function codexPlaces() {
  return { skills: join(homedir(), ".agents", "skills") };
}

/** The environment of one step: the caller's, with CODEX_HOME set to the account's folder or removed. */
export function codexEnv(account: Account | undefined, base: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  if (!account) return env;
  if (account.folder) env.CODEX_HOME = account.folder;
  else delete env.CODEX_HOME;
  return env;
}
