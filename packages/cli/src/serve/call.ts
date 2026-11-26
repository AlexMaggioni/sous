// POST /api/call: one sous command, run in this process as the person through the page. The
// command gets the same consent rules, refusals and events.jsonl lines as at the terminal. Its
// reply is JSON, and nothing reaches the server's terminal.

import { traceCall, type HomePaths, type Launcher, type Who } from "@sous-run/engine";
import type { CallCommand, CallReply } from "@sous-run/view";
import { parseArgs, str, Usage, type Parsed } from "../args.js";
import { atProject } from "../commands/common.js";
import type { CommandSpec, Ctx, Machine } from "../commands/index.js";
import { personCommand } from "../through.js";
import { ApiFailure, failureOf } from "./errors.js";

/** The person, through the page sous serve opens. */
export const VIEW: Who = { by: "person", through: { kind: "person", via: "view" } };

/** The commands the page may call. */
const CALLS: readonly CallCommand[] = ["run", "rerun", "resume", "pause", "stop", "answer", "approve", "send-back", "tell", "workflows"];

/** The flags the page may not give: who calls is the person, and a call never waits or prints help. */
const NOT_FROM_THE_PAGE = ["by", "wait", "help", "h"];

export interface CallContext {
  paths: HomePaths;
  /** The project sous serve started in, for a command that takes --project and names none. */
  project: string;
  env: NodeJS.ProcessEnv;
  launch: Launcher;
  commands: Record<string, CommandSpec>;
}

const bad = (message: string, change: string) => new ApiFailure(400, { code: "bad_argument", message, change, call: null });

/** The words of the call, checked: a command the page may call, and no flag that changes who calls. */
function wordsOf(body: unknown): string[] {
  const argv = (body as { argv?: unknown } | undefined)?.argv;
  if (!Array.isArray(argv) || !argv.length || !argv.every((word) => typeof word === "string")) {
    throw bad('POST /api/call takes {"argv": [...]}, the words of one sous command.', 'Send the words after "sous", such as {"argv": ["answer", "<question>", "yes"]}.');
  }
  const [command] = argv as string[];
  if (!CALLS.includes(command as CallCommand)) {
    throw bad(`the page may call ${CALLS.join(", ")}, not "${command}".`, "Call one of those commands, or run this one in a terminal.");
  }
  const split = argv.indexOf("--");
  const head = (split === -1 ? argv : argv.slice(0, split)) as string[];
  const flag = head.find((word) => NOT_FROM_THE_PAGE.some((name) => word === `--${name}` || word.startsWith(`--${name}=`) || (name === "h" && word === "-h")));
  if (flag) {
    throw bad(`the page may not give ${flag.split("=")[0]}. A call from the page is the person's, and it answers at once.`, `Leave ${flag.split("=")[0]} out.`);
  }
  return argv as string[];
}

/** The words with --json, and with the server's project when the command takes --project and the
 *  words name none. */
function withDefaults(argv: string[], spec: CommandSpec, project: string): string[] {
  const split = argv.indexOf("--");
  const head = split === -1 ? argv : argv.slice(0, split);
  const tail = split === -1 ? [] : argv.slice(split);
  const extra = [...(head.includes("--json") ? [] : ["--json"])];
  const takesProject = spec.flags.some((flag) => flag.name === "project");
  if (takesProject && !head.some((word) => word === "--project" || word.startsWith("--project="))) extra.push("--project", project);
  return [...head, ...extra, ...tail];
}

/** A machine for a call: what it prints is kept, and it never asks, reads a file or starts a process. */
function quietMachine(): Machine {
  const no = (what: string) => () => {
    throw new Usage(`a call from the page can't ${what}. Run the command in a terminal.`);
  };
  return {
    readText: no("read a file"),
    exists: () => false,
    guideDir: "",
    skillDir: "",
    spawnDaemon: no("start the service"),
    kill: no("end a process"),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    version: "unknown",
    cliPath: "",
    latestVersion: no("check for a new sous"),
    run: no("install a program"),
    isTerminal: false,
    ask: no("ask in a terminal"),
    open: no("open a browser"),
    untilStopped: no("wait for Ctrl-C"),
    out: () => {},
    write: () => {},
    err: () => {},
  };
}

/** Run one call and give its status and reply. With SOUS_TRACE_CALLS=1, each call adds a line to
 *  calls.jsonl, as at the terminal. */
export async function runCall(body: unknown, context: CallContext): Promise<{ status: number; reply: CallReply }> {
  let argv: string[] | undefined;
  let parsed: Parsed | undefined;
  let answer: { status: number; reply: CallReply; exit: number; code?: string };
  try {
    const [command, ...rest] = wordsOf(body);
    const spec = context.commands[command!]!;
    const words = withDefaults(rest, spec, context.project);
    argv = [command!, ...words];
    parsed = parseArgs(words, spec.flags, spec.inputs === true, command);
    const ctx: Ctx = {
      who: VIEW,
      command: personCommand(argv),
      paths: context.paths,
      env: context.env,
      json: true,
      launch: context.launch,
      machine: quietMachine(),
      now: () => new Date(),
      tellWaitMs: 5000,
    };
    const result = await spec.run(parsed, ctx);
    answer = { status: 200, reply: { ok: true, data: result.data as Record<string, unknown>, notes: result.notes, next: result.next }, exit: result.exit };
  } catch (error) {
    // A call in the error keeps the project, as at the terminal with --project.
    const project = str(parsed?.flags.project) ?? context.project;
    const adjust = (call: string) => (context.commands[call.split(" ")[1] ?? ""]?.flags.some((flag) => flag.name === "project") ? atProject(call, project) : call);
    const { status, error: apiError, exit } = failureOf(error, adjust);
    answer = { status, reply: { ok: false, error: apiError }, exit, code: apiError.code };
  }
  if (argv && context.env.SOUS_TRACE_CALLS === "1") {
    traceCall(context.paths, { argv, exit: answer.exit, ...(answer.code ? { code: answer.code } : {}), through: VIEW.through });
  }
  return { status: answer.status, reply: answer.reply };
}
