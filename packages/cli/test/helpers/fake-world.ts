// A world for the scenario tests: a git project, a sous home whose programs are the fakes in
// test/fakes, and the real sous command run as a process of its own. A test makes a world,
// writes a workflow and the fakes' rules, runs sous commands, and reads the fakes' log.
//
// The world lives in a new folder inside HOME, which test/with-temp-home.mjs points at a temp
// folder. Its folder holds the sous home, the project, the rules, the log and the fakes'
// sessions (claude-sessions/ and codex's, next to the log).

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { daemonPid, ensureHome, homePaths, listRecords, type HomePaths } from "@sous-run/engine";
import { cliFile } from "../../src/cli.js";
import { git } from "./git.js";

const FAKES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../test/fakes");

/** Variables of the test's own shell that would steer sous or the fakes away from the world.
 *  NODE_TEST_CONTEXT would make a `node --test` that a step runs think it is inside this test. */
const DROPPED = ["NODE_TEST_CONTEXT", "SOUS_HOME", "SOUS_RUN_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_EXECUTABLE", "CODEX_PATH", "FAKE_VERSION", "FAKE_PERSON"];

/** One rule of the fakes. test/fakes/lib.mjs lists every field. */
export interface FakeRule {
  /** A regex the prompt must match. */
  match?: string;
  program?: "claude" | "codex";
  answer?: unknown;
  [field: string]: unknown;
}

/** One line of the fakes' log. A turn's line has a prompt. Other lines record a message sent
 *  into a turn (steer), a by-hand session (byHand), a question (ask) or a goal's turn (goal). */
export interface FakeLine {
  program: "claude" | "codex";
  /** The program's process id. Turns with the same pid ran in one program. */
  pid?: number;
  sessionId?: string | null;
  argv?: string[];
  cwd?: string;
  model?: string | null;
  effort?: string | null;
  permissionMode?: string;
  /** True when the turn went on in a session the program had already. */
  resume?: boolean;
  fork?: boolean;
  schema?: unknown;
  mcpServers?: Array<{ name: string; transport: string }>;
  allowedTools?: string[];
  disallowedTools?: string[];
  tools?: string[] | null;
  systemPrompt?: string | null;
  appendSystemPrompt?: string | null;
  skills?: unknown;
  approvalPolicy?: unknown;
  disabledTools?: Record<string, string[]>;
  sandboxPolicy?: string | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  /** The session's system text, whichever program: Claude's appended system prompt or Codex's
   *  developer instructions. The helper adds it. */
  system?: string | null;
  login?: string[];
  prompt?: string;
  images?: unknown[];
  /** The index of the rule that decided the answer, or null when none matched. */
  rule?: number | null;
  /** answer, fail, limit, auth or exit. */
  outcome?: string;
  approval?: unknown;
  steer?: { id: string | null; text: string; priority?: string | null; expectedTurnId?: string | null };
  state?: string;
  byHand?: string;
  ask?: Record<string, unknown>;
  goal?: { turn: number; of: number };
  [field: string]: unknown;
}

/**
 * How a later turn went on in an earlier turn's session: "held" in the earlier turn's program,
 * "resumed" in a new program that resumed the session, else "apart".
 */
export function wentOn(earlier: FakeLine | undefined, later: FakeLine | undefined): "held" | "resumed" | "apart" {
  if (!earlier || !later || later.sessionId !== earlier.sessionId) return "apart";
  if (later.pid !== undefined && later.pid === earlier.pid) return "held";
  return later.resume ? "resumed" : "apart";
}

/** What a sous command gave. */
export interface SousResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface FakeWorldOptions {
  /** The fakes' rules. Default: none, so each prompt gets the fakes' made-up answer. */
  rules?: FakeRule[];
  /** Lines added to the home's config.json over { notify: false }. sous's own defaults hold
   *  for the rest, so the default place is a worktree. */
  config?: Record<string, unknown>;
  /** The line a person types in a by-hand session of the fake claude (FAKE_PERSON). */
  person?: string;
}

export interface FakeWorld {
  /** The world's folder. It holds the home, the project, the rules and the log. */
  dir: string;
  /** The git project the commands run in, with one commit. */
  projectDir: string;
  /** The sous home's paths. */
  paths: HomePaths;
  /** The fakes' log file. Each turn appends one JSON line. */
  logFile: string;
  /** Write a workflow to the project's .sous/workflows/<name>.js. */
  workflow(name: string, script: string): void;
  /** Write an agent file: .claude/agents/<name>.md, or .codex/agents/<name>.toml for codex. */
  agent(name: string, text: string, program?: "claude" | "codex"): void;
  /** Write any file in the project, by its path from the project folder. */
  write(path: string, text: string): void;
  /** Replace the fakes' rules. A fake reads them on each request, so a change reaches a run that
   *  is going on. */
  rules(rules: FakeRule[]): void;
  /** Set the line a person types in a by-hand session, for the commands run after. */
  person(line: string | undefined): void;
  /** Run git in the project and give what it prints, trimmed. */
  git(...args: string[]): string;
  /** Run the sous command in the project, and wait for it to exit. It fails the test after
   *  `timeoutMs`, 60 seconds unless `sousWith` says otherwise. */
  sous(...args: string[]): Promise<SousResult>;
  /** The same, with more environment variables and a time limit. */
  sousWith(options: { env?: Record<string, string>; timeoutMs?: number }, ...args: string[]): Promise<SousResult>;
  /** Every line of the fakes' log so far, oldest first. */
  log(): FakeLine[];
  /** Kill what the world started: sous commands still running, run workers and the service.
   *  The test's end calls it. */
  close(): void;
}

/** A new world. It closes when the test `t` ends. */
export function fakeWorld(t: { after(fn: () => void): void }, options: FakeWorldOptions = {}): FakeWorld {
  const home = realpathSync(homedir());
  // A world outside a temp HOME would write into the person's real home folder.
  if (!home.startsWith(realpathSync(tmpdir()) + sep)) throw new Error(`HOME is ${home}, not a temp folder. Start the test through test/with-temp-home.mjs.`);
  const dir = mkdtempSync(join(home, "sous-world-"));
  const paths = ensureHome(homePaths(join(dir, "home")));
  writeFileSync(paths.config, JSON.stringify({ notify: false, ...options.config, claudePath: join(FAKES, "claude"), codexPath: join(FAKES, "codex") }));

  const projectDir = join(dir, "project");
  mkdirSync(projectDir);
  git(projectDir, "init", "--quiet", "--initial-branch=main");
  git(projectDir, "config", "user.name", "Test");
  git(projectDir, "config", "user.email", "test@example.com");
  writeFileSync(join(projectDir, "README.md"), "A test project.\n");
  git(projectDir, "add", "README.md");
  git(projectDir, "commit", "--quiet", "-m", "First commit");
  // Workflows stay out of the project's changes.
  writeFileSync(join(projectDir, ".git", "info", "exclude"), ".sous/\n");

  const logFile = join(dir, "fake.log");
  const rulesFile = join(dir, "rules.json");
  writeFileSync(rulesFile, JSON.stringify(options.rules ?? []));
  let person = options.person;
  const running = new Set<ChildProcess>();

  const write = (path: string, text: string) => {
    const file = join(projectDir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };

  const sousWith = (extra: { env?: Record<string, string>; timeoutMs?: number }, ...args: string[]) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const name of DROPPED) delete env[name];
    Object.assign(env, { SOUS_HOME: paths.home, FAKE_LOG: logFile, FAKE_RULES: rulesFile }, person === undefined ? {} : { FAKE_PERSON: person }, extra.env);
    const child = spawn(process.execPath, [cliFile(), ...args], { cwd: projectDir, env, stdio: ["ignore", "pipe", "pipe"] });
    running.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const timeoutMs = extra.timeoutMs ?? 60_000;
    return new Promise<SousResult>((done, fail) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        fail(new Error(`sous ${args.join(" ")} ran past ${timeoutMs} ms.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      }, timeoutMs);
      child.on("error", fail);
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        running.delete(child);
        done({ code: code ?? (signal ? 128 : 1), stdout, stderr });
      });
    });
  };

  const close = () => {
    for (const child of running) child.kill("SIGKILL");
    // A worker and the service each start detached, as the leader of a process group that
    // also holds the fake programs they start.
    const pids = [...listRecords(paths).map((record) => record.pid), daemonPid(paths)];
    for (const pid of pids) {
      if (pid === undefined) continue;
      for (const target of [-pid, pid]) {
        try {
          process.kill(target, "SIGKILL");
        } catch {
          // The process or its group has ended already.
        }
      }
    }
  };
  t.after(close);

  return {
    dir,
    projectDir,
    paths,
    logFile,
    workflow: (name, script) => write(join(".sous", "workflows", `${name}.js`), script),
    agent: (name, text, program = "claude") => write(program === "claude" ? join(".claude", "agents", `${name}.md`) : join(".codex", "agents", `${name}.toml`), text),
    write,
    rules: (rules) => writeFileSync(rulesFile, JSON.stringify(rules)),
    person: (line) => (person = line),
    git: (...args) => git(projectDir, ...args),
    sous: (...args) => sousWith({}, ...args),
    sousWith,
    log: () =>
      existsSync(logFile)
        ? readFileSync(logFile, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((text) => {
              const line = JSON.parse(text) as FakeLine;
              const system = line.program === "claude" ? line.appendSystemPrompt : line.developerInstructions;
              return system === undefined ? line : { ...line, system };
            })
        : [],
    close,
  };
}
