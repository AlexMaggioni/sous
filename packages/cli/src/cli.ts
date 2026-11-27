#!/usr/bin/env node
// sous: run saved workflows in the background, answer what they ask, pause, resume and
// schedule them. `sous help` lists the commands. The commands live in commands/, and this file
// holds the only machine access of the cli.

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { createRequire } from "node:module";
import { createInterface } from "node:readline/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { daemonLog, ensureHome, homePaths, seedApprovals, traceCall, workerMain, workerProcess, type HomePaths, type Launcher, type Who } from "@sous-run/engine";
import { flagList, parseArgs, str, Usage, type Parsed } from "./args.js";
import { atProject } from "./commands/common.js";
import { ALIASES, COMMANDS, type CommandSpec, type Ctx, type Machine } from "./commands/index.js";
import { errorCode, print, printError } from "./reply.js";
import { personCommand, whoIsCalling } from "./through.js";

/** The built command-line file, which also runs the worker. */
export function cliFile(): string {
  const here = fileURLToPath(new URL(".", import.meta.url));
  for (const candidate of [join(here, "cli.js"), join(here, "..", "dist", "cli.js")]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("sous is not built. Run pnpm build in the sous repo.");
}

/** sous's workers, each a process of its own that runs cli.js. A command that starts one finds
 *  cli.js first, so a sous that is not built writes no record. */
function workers(): Launcher {
  const file = cliFile();
  return workerProcess(() => file);
}

/** What a caller of main may put in place of sous's own parts. */
export interface MainOptions {
  /** Starts the workers of the runs a command starts or resumes. By default each worker is a
   *  process of its own. Tests pass one that runs the worker in their process. */
  launch?: Launcher;
  /** The environment the commands read: the markers of who calls and SOUS_TRACE_CALLS, HOME in
   *  schedule, HOME and Claude Code's config folder variable in skill, hook and doctor, and
   *  CODEX_THREAD_ID in doctor. The home and the accounts still read process.env. Default: process.env. */
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** What the commands do on the machine. Tests pass one to fake a terminal. */
  machine?: Machine;
  /** How long sous tell waits for the worker's receipt, in ms. Default 5000. */
  tellWaitMs?: number;
}

/** The version in sous's package.json, the same from src and dist. */
function ownVersion(): string {
  try {
    return (createRequire(import.meta.url)("../package.json") as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** The latest @sous-run/cli on the npm registry, or undefined after 5 seconds or on any failure.
 *  npm_config_registry, which npm sets for the scripts it runs, names another registry. */
async function latestOnNpm(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const registry = (env.npm_config_registry ?? "https://registry.npmjs.org/").replace(/\/?$/, "/");
  try {
    const response = await fetch(`${registry}@sous-run%2fcli/latest`, { signal: AbortSignal.timeout(5000), headers: { accept: "application/json" } });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : undefined;
  } catch {
    return undefined;
  }
}

function machine(): Machine {
  const here = fileURLToPath(new URL(".", import.meta.url));
  return {
    version: ownVersion(),
    get cliPath() {
      const file = fileURLToPath(import.meta.url);
      try {
        return realpathSync(file);
      } catch {
        return file;
      }
    },
    latestVersion: () => latestOnNpm(process.env),
    run: (command) =>
      new Promise((done) => {
        // npm, pnpm and the rest are .cmd files on Windows, which only a shell starts.
        const child = spawn(command[0]!, command.slice(1), { stdio: ["inherit", process.stderr, process.stderr], shell: process.platform === "win32" });
        child.on("error", () => done(127));
        child.on("exit", (code) => done(code ?? 1));
      }),
    readText: (file) => readFileSync(file, "utf8"),
    exists: (file) => existsSync(file),
    guideDir: join(here, "..", "guide"),
    skillDir: join(here, "..", "skill", "sous"),
    spawnDaemon(paths) {
      const fd = openSync(daemonLog(paths), "a");
      const child = spawn(process.execPath, [process.argv[1]!, "daemon", "run"], { detached: true, stdio: ["ignore", fd, fd], env: process.env });
      child.unref();
      closeSync(fd);
      return child.pid;
    },
    kill: (pid) => process.kill(pid, "SIGTERM"),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    get isTerminal() {
      return Boolean(process.stdin.isTTY && process.stdout.isTTY);
    },
    async ask(prompt) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const text = await rl.question(prompt);
      rl.close();
      return text;
    },
    open(url) {
      const [command, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
      const child = spawn(command as string, args as string[], { detached: true, stdio: "ignore" });
      child.on("error", () => process.stderr.write("sous: no browser opened. Open the link above.\n"));
      child.unref();
    },
    untilStopped: () =>
      new Promise((done) => {
        const stop = () => {
          process.off("SIGINT", stop);
          process.off("SIGTERM", stop);
          done();
        };
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
      }),
    onStop(stop) {
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return () => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      };
    },
    openProgram: (program) =>
      new Promise((done) => {
        // The terminal sends Ctrl-C to sous as well as to the program. The program handles it.
        const ignore = () => {};
        process.on("SIGINT", ignore);
        let ended = false;
        const end = (code: number) => {
          if (ended) return;
          ended = true;
          process.off("SIGINT", ignore);
          done(code);
        };
        const child = spawn(program.path, program.args, { cwd: program.cwd, env: program.env, stdio: "inherit" });
        child.on("error", () => end(127));
        child.on("exit", (code, signal) => end(code ?? 128 + (signal ? constants.signals[signal] : 0)));
      }),
    privateFolder() {
      // mkdtemp makes the folder readable by this user only.
      const dir = mkdtempSync(join(tmpdir(), "sous-join-"));
      return {
        write(name, text) {
          const file = join(dir, name);
          writeFileSync(file, text, { mode: 0o600 });
          return file;
        },
        remove: () => rmSync(dir, { recursive: true, force: true }),
      };
    },
    out: (line) => process.stdout.write(`${line}\n`),
    write: (text) => process.stdout.write(text),
    err: (line) => process.stderr.write(`${line}\n`),
  };
}

/** The context of one command. The home and the launcher are made when the command first uses them.
 *  The first use of the home also takes the workflows sous finds as approved, once per home. */
function contextOf(json: boolean, options: MainOptions, machine: Machine, who: Who, command: string): Ctx {
  let paths: HomePaths | undefined;
  return {
    who,
    command,
    get paths() {
      if (paths) return paths;
      paths = ensureHome(homePaths());
      // A broken approvals.json does not stop a read. The commands that need it refuse.
      try {
        seedApprovals(paths);
      } catch {}
      return paths;
    },
    env: options.env ?? process.env,
    json,
    get launch() {
      return options.launch ?? workers();
    },
    machine,
    now: options.now ?? (() => new Date()),
    tellWaitMs: options.tellWaitMs ?? 5000,
  };
}

const HELP = `Agents: run \`sous guide\`.

sous runs saved workflows in the background.

  sous run <workflow> [--name value ...] [-- --name value ...]
        --place worktree|folder|none    where the run works (default: the workflow's, else config)
        --model <spec>                  model for steps that name none, such as claude/haiku
        --set <step>.<key>=<value>      change one step for this run, such as --set reviewer.model=claude/opus
        --concurrency N                 steps at once in this run
        --budget N                      tokens one go may spend; at N the run pauses (default: config, else none)
        --wait                          follow the run until it ends; in a terminal, answer here
        --json                          machine-readable output
  sous wait <run> [--timeout N] [--json]  wait for a run to end, pause or ask (exit 0 done, 1 failed,
                                        2 paused, 3 stopped, 4 waits for an answer, 5 timed out)
  sous status [--since 3d] [--json]     what needs you, what runs, what waits and what finished
        --line                          one line for a new agent session, or nothing
  sous list [--all]                     runs, newest first
  sous show <run> [--full]              one run: status, steps, questions, result
  sous log <run> [-f]                   the run's log
        --json --after <seq>            the run's events after a seq, 100 at most
  sous step <run> <label>               one step: status, prompt or command, failure, what it did
        --call N | --tail N | --full    another call; the last N activity entries; all of it
  sous inbox [run]                      questions waiting for you
  sous answer <question> <text>         answer a question (a run id works when it asks one thing)
        --value-json                    the text is JSON, such as {"a": 1}, not words
        --by person                     the person decided; an agent passes on their word
  sous approve <question>               approve a breakpoint
        --by person                     the person decided; an agent passes on their word
  sous send-back <question> <note>      send a breakpoint's step back with a note
        --by person                     the person decided; an agent passes on their word
  sous pause <run>                      finish running steps, start nothing new
  sous resume <run> [--wait]            go on from where the run paused, failed or was cut off
        --latest | --same               after an edit: take the new version, or keep the run's own
        --budget N                      the run's new budget, from this go on
        --note <msg> [--step <name>]    give the first agent call that runs a note, or that step's
  sous stop <run>                       end the run; its worktree stays
        --step <name>                   stop one running step instead; the run pauses on it
  sous tell <run> --step <name> <msg>   give a running agent step a message it reads after its tool call
        --call n                        tell only the nth call of the step
  sous join <run> <step>                step into an agent step's session in this terminal; the
                                        step goes on in it when you leave, and nothing else stops
        --call n                        the session of the nth call of the step
  sous rerun <run> [--name value ...]   start the same workflow again with the same inputs
        --reuse                         keep the results of the steps you did not edit, in the same place
        --budget N                      tokens one go of the new run may spend (default: the run's)
  sous workflows                        saved workflows and their inputs
  sous workflows show <name> [--full]   one workflow: its steps, its approval, its last runs
        --diff                          what changed since the person's yes
  sous agents                           the agents a step can name
  sous workflows approve <name> | --all the person's yes to a workflow's text as it is now
        --by person                     the person decided; an agent passes on their word
  sous check <workflow> [--name value]  check a workflow without running it
        --dry-run                       then run it once with stand-in agents; code steps run, in a copy
        --answers <file.json>           what the stand-ins answer, by step label: {"reviewer *": {...}}
  sous schedule add <name> <workflow> --cron "<min hour day month weekday>" [--name value ...]
  sous schedule list|remove|enable|disable|test <name>
                                        schedule: "0 9 * * 1-5" in a workflow's meta also schedules it
  sous daemon start|stop|status         the service that starts schedules and resumes runs after the limit
  sous gc [--dry-run]                   remove worktrees whose branch is merged
  sous discard <run> [--yes]            delete the run's branches and worktrees, merged or not;
                                        without --yes, list what it would delete
  sous prune --days N                   remove finished runs older than N days
  sous account                          the accounts sous's steps can use, and the one they use now
  sous account add <name>               add a Claude Code login: runs claude setup-token, then asks
                                        for the token it prints (or reads it from stdin)
  sous account use <name>               use it for new runs, and move the runs waiting at the usage
                                        limit to it; default is Claude Code's own login
  sous account remove <name>            forget a login
  sous doctor [--live]                  the installed Claude Code and Codex the steps run on, whether
                                        sous talks to them, where each finds the skill, and whether
                                        sous can write its home; --live runs one tiny step on each
        --model <spec>                  with --live, check this model only, such as codex/gpt-6.1-sol
  sous guide [topic]                    how an agent drives sous for a person, one topic at a time
  sous skill install|path|check         link the sous skill for Claude Code and Codex, print its
                                        folder, or show where each program finds it
  sous hook install|remove              add or remove the Claude Code session-start hook that runs
                                        sous status --line; it keeps a backup of settings.json
  sous serve [--port N] [--no-open]     the page of the runs in the browser, on this machine only;
                                        prints a link with a token and serves until Ctrl-C
  sous version                          the version of sous (also sous --version)
  sous update [--check]                 install the latest sous with the package manager that
                                        installed this one; --check only says whether one is out

With --json, a command prints one JSON object, with its notes and the calls to make next. A
request that changes nothing, such as pausing a paused run, exits 0 with a note.

Home: ${homePaths().home} (set SOUS_HOME to change). A project's .sous/ folder holds its
workflows, and wins over the home folder's. Agents and MCP servers come from the project's
.rulesync/, then the global rulesync folder (rulesyncGlobal in config.json), then the harnesses'
own folders, such as .claude/agents/ and .codex/agents/. Steps run on the Claude Code and Codex
installed on this machine, on the account sous account names. A run that a Claude Code session or
an agent starts uses that session's account.`;

/** The command a name calls, or undefined. */
function commandNamed(name: string): CommandSpec | undefined {
  if (Object.hasOwn(COMMANDS, name)) return COMMANDS[name];
  return Object.hasOwn(ALIASES, name) ? ALIASES[name] : undefined;
}

/** Run one sous command and give its exit code. With SOUS_TRACE_CALLS=1 in the env, each call
 *  but a worker's adds a line to calls.jsonl, a refused one with its code. */
export async function main(argv: string[], options: MainOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  let code: string | undefined;
  const exit = await call(argv, options, (error) => (code = errorCode(error)));
  if (env.SOUS_TRACE_CALLS === "1" && argv[0] !== "_worker") {
    traceCall(ensureHome(homePaths()), { argv, exit, ...(code ? { code } : {}), through: whoIsCalling(env).through });
  }
  return exit;
}

/** Run one command. `failed` hears the error a command ends with. */
async function call(argv: string[], options: MainOptions, failed: (error: unknown) => void): Promise<number> {
  const [command, ...rest] = argv;
  const host = options.machine ?? machine();
  let json: boolean | undefined;
  let parsed: Parsed | undefined;
  try {
    if (command === "_worker") return await workerMain(rest[0]!, rest[1] === "resume" ? "resume" : "start");
    const spec = command ? commandNamed(command) : undefined;
    parsed = parseArgs(rest, spec?.flags ?? [], spec?.inputs === true, command);
    json = parsed.flags.json === true;
    if (command === "--version" || command === "-v") {
      host.out(`sous ${host.version}`);
      return 0;
    }
    if (!command || command === "help" || command === "--help" || command === "-h" || parsed.flags.help || parsed.flags.h) {
      host.out(HELP);
      return 0;
    }
    if (!spec) throw new Usage(`unknown command "${command}". sous help lists them.`);
    const by = str(parsed.flags.by);
    const who = whoIsCalling(options.env ?? process.env, by);
    const result = await spec.run(parsed, contextOf(json, options, host, who, personCommand(argv)));
    // A read decides nothing, so --by person on it is only a note.
    if (by !== undefined && !spec.flags.some((flag) => flag.name === "by")) result.notes.push(READ_BY);
    // A flag the command does not take changes nothing, and a note names it.
    for (const name of parsed.dropped) result.notes.push(`sous ${command} does not take --${name}, so it left it out. It takes ${flagList(spec.flags)}.`);
    // The text form prints the text, then a note: line for each note, then a next: line for each call.
    return print(result, json, (line) => host.out(line));
  } catch (error) {
    failed(error);
    // A command line that does not parse is read again for --json, before any "--".
    const asJson = json ?? (rest.includes("--") ? rest.slice(0, rest.indexOf("--")) : rest).includes("--json");
    return printError(error, asJson, (line) => (asJson ? host.out(line) : host.err(line)), withProject(str(parsed?.flags.project)));
  }
}

/** The note of --by person on a read. */
const READ_BY = "--by person changes nothing here: this command only reads, and sous records who decided only for a write.";

/** A call in an error keeps the command's --project, when the command it calls takes one. */
function withProject(project: string | undefined): ((call: string) => string) | undefined {
  if (!project) return undefined;
  return (call) => {
    const called = commandNamed(call.split(" ")[1] ?? "");
    return called?.flags.some((flag) => flag.name === "project") ? atProject(call, project) : call;
  };
}

const invokedDirectly = (() => {
  try {
    const self = fileURLToPath(import.meta.url);
    const argv1 = process.argv[1] ? resolve(process.argv[1]) : "";
    return argv1 === self || argv1.replace(/\.ts$/, ".js") === self.replace(/\.ts$/, ".js") || /[\\/]sous$/.test(argv1);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (process.argv[2] !== "daemon" || process.argv[3] !== "run") process.exitCode = code;
      if (process.argv[2] === "_worker") setTimeout(() => process.exit(code), 200).unref();
    },
    (error) => {
      process.stderr.write(`sous: ${(error as Error).stack ?? String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
