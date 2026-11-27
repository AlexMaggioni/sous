// What the live tests of phase 3 share: a new sous home and git project in the temp folder, the
// built sous command run on your own logins, a run's agent turns as the run state keeps them, and
// the user messages a program kept in its own session file.
//
// The home and the project are new temporary folders, so a live run never writes under ~/.sous.
// Each program keeps its sessions under its own folder, as a session opened by hand does. The
// test reads those files and writes nothing there.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { daemonPid, homePaths, listRecords, type HomePaths } from "@sous-run/engine";
import { readState } from "@sous-run/engine/testing";
import { git } from "./git.js";

/** Variables of the caller's shell that would put the run in another home or inside another run.
 *  NODE_TEST_CONTEXT would make a `node --test` that a step runs think it is inside this test. */
const DROPPED = ["NODE_TEST_CONTEXT", "SOUS_HOME", "SOUS_RUN_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"];

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/** The built sous command, the cli package's bin. */
const SOUS = join(PACKAGE, (JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8")) as { bin: { sous: string } }).bin.sous);

export type RunState = NonNullable<ReturnType<typeof readState>>;
/** One turn of a step: one agent() call, its journal row, and what the run state says it cost. */
export interface StepTurn {
  label: string;
  /** The call's index, which its journal row and its agent entry share. */
  index: number;
  /** The row's result: the status object, with `turns` when the call took more than one program turn. */
  result: unknown;
  sessionId?: string;
  cost?: number;
  tokens?: number;
  ms?: number;
}

export interface LiveWorld {
  home: string;
  project: string;
  paths: HomePaths;
  /** Writes a file in the project, by its path from the project folder. */
  write(path: string, text: string): void;
  /** Runs git in the project and gives what it prints, trimmed. */
  git(...args: string[]): string;
  /** Runs the sous command in the project and gives its exit code and output. */
  sous(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  /** The one run's state. It fails when the home holds no run, or more than one. */
  state(): RunState;
}

/** A new world. Its runs' workers and the service stop when the test `t` ends. */
export function liveWorld(t: { after(fn: () => void): void }, name: string): LiveWorld {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `sous-live-${name}-`)));
  const home = join(dir, "home");
  mkdirSync(home);
  writeFileSync(join(home, "config.json"), JSON.stringify({ notify: false }));
  const project = join(dir, "project");
  mkdirSync(join(project, ".sous", "workflows"), { recursive: true });
  git(project, "init", "--quiet", "--initial-branch=main");
  git(project, "config", "user.name", "Test");
  git(project, "config", "user.email", "test@example.com");
  writeFileSync(join(project, "README.md"), "A test project.\n");
  git(project, "add", "README.md");
  git(project, "commit", "--quiet", "-m", "First commit");
  writeFileSync(join(project, ".git", "info", "exclude"), ".sous/\n");
  const paths = homePaths(home);

  t.after(() => {
    // A run that waits for an answer keeps its worker. A worker and the service each lead a
    // process group that also holds the programs they start.
    for (const pid of [...listRecords(paths).map((record) => record.pid), daemonPid(paths)]) {
      if (pid === undefined) continue;
      for (const target of [-pid, pid]) {
        try {
          process.kill(target, "SIGKILL");
        } catch {
          // The process or its group has ended already.
        }
      }
    }
  });

  return {
    home,
    project,
    paths,
    write(path, text) {
      const file = join(project, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    },
    git: (...args) => git(project, ...args),
    sous(...args) {
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const variable of DROPPED) delete env[variable];
      env.SOUS_HOME = home;
      const child = spawn(process.execPath, [SOUS, ...args], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      return new Promise((done, fail) => {
        child.on("error", fail);
        child.on("close", (code, signal) => done({ code: code ?? (signal ? 128 : 1), stdout, stderr }));
      });
    },
    state() {
      const records = listRecords(paths);
      if (records.length !== 1) throw new Error(`the home holds ${records.length} runs, not one`);
      const state = readState(paths, records[0]!.runId);
      if (!state) throw new Error(`no state for run ${records[0]!.runId}`);
      return state;
    },
  };
}

/** The turns of one step label, in the order they ran: the journal's rows for the label, each
 *  with the cost, tokens and time of the agent entry that has the row's call index. */
export function turnsOf(state: RunState, label: string): StepTurn[] {
  return (state.journal ?? [])
    .filter((row) => row.call?.kind === "agent" && row.call.label === label)
    .sort((a, b) => a.index - b.index)
    .map((row) => {
      const agent = state.agents.find((entry) => entry.callIndex === row.index);
      const ms = agent?.startedAt && agent.endedAt ? Date.parse(agent.endedAt) - Date.parse(agent.startedAt) : undefined;
      return {
        label,
        index: row.index,
        result: row.result,
        sessionId: row.session?.sessionId ?? agent?.session?.sessionId,
        cost: row.usage?.cost ?? agent?.usage?.cost,
        tokens: row.usage?.total ?? agent?.usage?.total ?? agent?.tokens,
        ms,
      };
    });
}

/** One turn as a line to print: its status, program turns, cost, tokens, time and session. */
export function turnLine(turn: StepTurn): string {
  const result = turn.result as { status?: unknown; turns?: unknown } | undefined;
  const sent = typeof result?.turns === "number" ? `, ${result.turns} program turns` : "";
  return `${turn.label} call ${turn.index}: ${String(result?.status ?? "no status")}${sent}, $${turn.cost ?? "?"}, ${turn.tokens ?? "?"} tokens, ${turn.ms ?? "?"} ms, session ${turn.sessionId ?? "?"}`;
}

/** Every file under a folder whose name passes the test, or none when the folder is missing. */
function filesUnder(dir: string, wanted: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true }) as string[]).filter((path) => wanted(path.split("/").at(-1) ?? "")).map((path) => join(dir, path));
}

function jsonLines(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

/**
 * The user messages a program kept in its session file, oldest first, as the text the program got.
 * Claude Code: the session's `user` lines under CLAUDE_CONFIG_DIR, or ~/.claude, past tool results
 * and the lines Claude Code adds itself (isMeta). Codex: the user messages of the thread's rollout
 * under CODEX_HOME, or ~/.codex, past the environment context Codex adds to each thread.
 */
export function programPrompts(program: "claude" | "codex", sessionId: string): string[] {
  if (program === "claude") {
    const folder = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
    const [file] = filesUnder(folder, (name) => name === `${sessionId}.jsonl`);
    if (!file) throw new Error(`no Claude Code session file for ${sessionId} under ${folder}`);
    return jsonLines(file).flatMap((line) => {
      if (line.type !== "user" || line.isMeta === true) return [];
      const content = (line.message as { content?: unknown } | undefined)?.content;
      if (typeof content === "string") return [content];
      if (!Array.isArray(content)) return [];
      const texts = content.filter((block: { type?: string }) => block.type === "text").map((block: { text: string }) => block.text);
      return texts.length ? [texts.join("\n")] : [];
    });
  }
  const folder = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
  const [file] = filesUnder(folder, (name) => name.startsWith("rollout-") && name.endsWith(`${sessionId}.jsonl`));
  if (!file) throw new Error(`no Codex rollout for thread ${sessionId} under ${folder}`);
  return jsonLines(file).flatMap((line) => {
    const payload = line.payload as { type?: string; role?: string; content?: Array<{ type?: string; text?: string }> } | undefined;
    if (line.type !== "response_item" || payload?.type !== "message" || payload.role !== "user") return [];
    const texts = (payload.content ?? []).filter((item) => item.type === "input_text" && typeof item.text === "string").map((item) => item.text!);
    const text = texts.join("\n");
    return text && !text.startsWith("<environment_context>") ? [text] : [];
  });
}

/**
 * What Claude Code's local commands printed in a session, oldest first, such as `/goal` with no
 * condition, which reports the goal without a model call. The session file keeps each as a
 * `system` line of subtype `local_command`, with the command's name and its output.
 */
export function claudeCommandOutputs(sessionId: string, command: string): string[] {
  const folder = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
  const [file] = filesUnder(folder, (name) => name === `${sessionId}.jsonl`);
  if (!file) throw new Error(`no Claude Code session file for ${sessionId} under ${folder}`);
  return jsonLines(file).flatMap((line) => {
    if (line.type !== "system" || line.subtype !== "local_command") return [];
    if ((line.commandRun as { command?: string } | undefined)?.command !== command) return [];
    return typeof line.content === "string" ? [line.content.replace(/<\/?local-command-stdout>/g, "")] : [];
  });
}
