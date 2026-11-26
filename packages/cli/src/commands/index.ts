// The sous commands by name. A new command is one entry here and its function in a command file.

import type { HomePaths, Launcher, Who } from "@sous/engine";
import { flagsNamed, RESERVED, type FlagSpec, type Parsed } from "../args.js";
import type { Reply } from "../reply.js";
import { cmdDiscard, cmdGc, cmdPause, cmdPrune, cmdStop, cmdTell } from "./control.js";
import { cmdAnswer, cmdInbox } from "./questions.js";
import { cmdList, cmdLog, cmdShow, cmdStatus, cmdWait } from "./reads.js";
import { cmdRerun, cmdResume, cmdRun } from "./runs.js";
import { cmdServe } from "./serve.js";
import { cmdStep } from "./step.js";
import { cmdDaemon, cmdSchedule } from "./service.js";
import { cmdAccount, cmdDoctor, cmdGuide, cmdHook, cmdSkill } from "./setup.js";
import { cmdAgents, cmdCheck, cmdWorkflows } from "./workflows.js";

/** What the commands do on the machine. Only cli.ts makes the real one. */
export interface Machine {
  /** Input files, such as the answers of a dry run. */
  readText(file: string): string;
  exists(file: string): boolean;
  /** The guide topics and the skill, next to dist/cli.js. */
  guideDir: string;
  skillDir: string;
  /** Start the service in the background, and give its pid. */
  spawnDaemon(paths: HomePaths): number | undefined;
  /** End the service. */
  kill(pid: number): void;
  sleep(ms: number): Promise<void>;
  /** stdin and stdout are both a terminal. */
  readonly isTerminal: boolean;
  /** Ask in the terminal and give the line typed. */
  ask(prompt: string): Promise<string>;
  /** Open a link in the person's browser. */
  open(url: string): void;
  /** Wait for Ctrl-C, or the signal that ends the process. */
  untilStopped(): Promise<void>;
  out(line: string): void;
  /** Text as it comes, such as a log, with no line end added. */
  write(text: string): void;
  err(line: string): void;
}

/** What a command works with. Its parts that touch the machine are read only when it uses them. */
export interface Ctx {
  /** Who calls, from the env's markers and --by. The engine's writes record it. */
  who: Who;
  /** The command line as the person types it, for a refusal that hands it to them. */
  command: string;
  /** The home, made on first use. */
  readonly paths: HomePaths;
  env: NodeJS.ProcessEnv;
  json: boolean;
  /** Starts the workers. Reading it finds sous's built cli.js first. */
  readonly launch: Launcher;
  machine: Machine;
  now: () => Date;
  /** How long sous tell waits for the worker's receipt, in ms. */
  tellWaitMs: number;
}

/** A command gives a reply, which main prints. */
export type Command = (args: Parsed, ctx: Ctx) => Reply<object> | Promise<Reply<object>>;

export interface CommandSpec {
  run: Command;
  flags: FlagSpec[];
  /** An unknown --name value is a workflow input. */
  inputs?: true;
}

/** A command's flags, by name. Each is a flag sous owns, so it never becomes an input. Every command takes --help.
 *  A command that writes takes --by, and a read given --by person says in a note that it changes nothing. */
function takes(...names: string[]): FlagSpec[] {
  const stray = names.filter((name) => !RESERVED.includes(name));
  if (stray.length) throw new Error(`add --${stray.join(", --")} to the flags of args.ts first`);
  return flagsNamed([...names, "help", "h"]);
}

export const COMMANDS: Record<string, CommandSpec> = {
  run: { run: cmdRun, flags: takes("place", "model", "set", "concurrency", "budget", "project", "wait", "let-agent-answer", "by", "json"), inputs: true },
  wait: { run: cmdWait, flags: takes("timeout", "json") },
  status: { run: cmdStatus, flags: takes("since", "line", "all", "json") },
  list: { run: cmdList, flags: takes("all", "json") },
  show: { run: cmdShow, flags: takes("full", "json") },
  step: { run: cmdStep, flags: takes("call", "tail", "full", "json") },
  log: { run: cmdLog, flags: takes("follow", "after", "json") },
  inbox: { run: cmdInbox, flags: takes("json") },
  answer: { run: (args, ctx) => cmdAnswer(args, ctx, "answer"), flags: takes("value-json", "by", "json") },
  approve: { run: (args, ctx) => cmdAnswer(args, ctx, "approve"), flags: takes("by", "json") },
  "send-back": { run: (args, ctx) => cmdAnswer(args, ctx, "send-back"), flags: takes("by", "json") },
  pause: { run: cmdPause, flags: takes("by", "json") },
  resume: { run: cmdResume, flags: takes("latest", "same", "budget", "note", "step", "wait", "let-agent-answer", "by", "json") },
  stop: { run: cmdStop, flags: takes("step", "by", "json") },
  tell: { run: cmdTell, flags: takes("step", "call", "by", "json") },
  rerun: { run: cmdRerun, flags: takes("place", "reuse", "set", "model", "budget", "wait", "let-agent-answer", "by", "json"), inputs: true },
  workflows: { run: cmdWorkflows, flags: takes("project", "all", "by", "diff", "full", "json") },
  agents: { run: cmdAgents, flags: takes("project", "json") },
  check: { run: cmdCheck, flags: takes("project", "dry-run", "answers", "json"), inputs: true },
  schedule: { run: cmdSchedule, flags: takes("cron", "place", "project", "by", "json"), inputs: true },
  daemon: { run: cmdDaemon, flags: takes("json") },
  gc: { run: cmdGc, flags: takes("dry-run", "by", "json") },
  discard: { run: cmdDiscard, flags: takes("yes", "by", "json") },
  prune: { run: cmdPrune, flags: takes("days", "by", "json") },
  account: { run: cmdAccount, flags: takes("by", "json") },
  doctor: { run: cmdDoctor, flags: takes("live", "model", "json") },
  guide: { run: cmdGuide, flags: takes("json") },
  skill: { run: cmdSkill, flags: takes("by", "json") },
  hook: { run: cmdHook, flags: takes("by", "json") },
  serve: { run: (args, ctx) => cmdServe(args, ctx, COMMANDS), flags: takes("port", "no-open", "project", "by") },
};

/** The other names a command answers to. Help does not list them. */
export const ALIASES: Record<string, CommandSpec> = { ls: COMMANDS.list!, logs: COMMANDS.log!, questions: COMMANDS.inbox!, schedules: COMMANDS.schedule!, accounts: COMMANDS.account! };
