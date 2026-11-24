// Where Claude Code is, which version the SDK needs, and the environment a step runs in.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { compareVersions, programVersion, type ProgramInfo } from "../lookup.js";
import type { Account } from "../types.js";

export const CLAUDE: ProgramInfo = {
  name: "Claude Code",
  command: "claude",
  variable: "CLAUDE_CODE_EXECUTABLE",
  launcher: "/@anthropic-ai/claude-code/",
  install: "npm install -g @anthropic-ai/claude-code",
};

let floor: string | undefined;

/** The oldest Claude Code the SDK works with: its own claudeCodeVersion. */
function claudeFloor(): string {
  if (floor) return floor;
  const entry = createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk");
  const pkg = JSON.parse(readFileSync(join(dirname(entry), "package.json"), "utf8")) as { version: string; claudeCodeVersion: string };
  floor = pkg.claudeCodeVersion;
  return floor;
}

export async function claudeVersion(path: string): Promise<{ version?: string; problem?: string }> {
  const version = await programVersion(path);
  if (!version) return { problem: `${path} --version printed no version. Check that it is Claude Code.` };
  const needed = claudeFloor();
  if (compareVersions(version, needed) < 0) {
    return { version, problem: `Claude Code ${version} is older than ${needed}, which the adapter needs. Update it with \`${CLAUDE.install}\` or \`claude update\`.` };
  }
  return { version };
}

/** Claude Code's folder variable and login token in env. */
export function claudeLogin(env: Record<string, string | undefined> = process.env) {
  const value = env.CLAUDE_CONFIG_DIR || undefined;
  const token = env.CLAUDE_CODE_OAUTH_TOKEN || undefined;
  return { variable: "CLAUDE_CONFIG_DIR", ...(value ? { value } : {}), folder: value ?? join(homedir(), ".claude"), ...(token ? { token } : {}) };
}

/** Where Claude Code looks for skills and its settings file in env. */
export function claudePlaces(env: Record<string, string | undefined> = process.env) {
  const folder = env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return { skills: join(folder, "skills"), settings: join(folder, "settings.json") };
}

/**
 * The environment of one step. It starts from the caller's, since it replaces the whole
 * environment, then puts the step on its account.
 */
export function claudeEnv(account: Account | undefined, base: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  if (!account) return env;
  put(env, "CLAUDE_CONFIG_DIR", account.folder);
  put(env, "CLAUDE_CODE_OAUTH_TOKEN", account.token);
  // Claude Code takes these over a login token, so a named login removes them.
  if (account.named) {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  return env;
}

function put(env: Record<string, string | undefined>, name: string, value: string | undefined) {
  if (value === undefined || value === "") delete env[name];
  else env[name] = value;
}
