// The sous commands by name. A new command is one entry here and its function in a command file.

import type { HomePaths, Launcher } from "@sous/engine";
import { flagsNamed, RESERVED, type FlagSpec, type Parsed } from "../args.js";
import type { Reply } from "../reply.js";
import { cmdDiscard, cmdGc, cmdPause, cmdPrune, cmdStop } from "./control.js";
import { cmdAnswer, cmdInbox } from "./questions.js";
import { cmdList, cmdLog, cmdShow, cmdStatus, cmdWait } from "./reads.js";
import { cmdRerun, cmdResume, cmdRun } from "./runs.js";
import { cmdDaemon, cmdSchedule } from "./service.js";
import { cmdAccount, cmdDoctor, cmdGuide, cmdSkill } from "./setup.js";
import { cmdCheck, cmdWorkflows } from "./workflows.js";

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
  out(line: string): void;
  /** Text as it comes, such as a log, with no line end added. */
  write(text: string): void;
  err(line: string): void;
}

/** What a command works with. Its parts that touch the machine are read only when it uses them. */
export interface Ctx {
  /** The home, made on first use. */
  readonly paths: HomePaths;
  env: NodeJS.ProcessEnv;
  json: boolean;
  /** Starts the workers. Reading it finds sous's built cli.js first. */
  readonly launch: Launcher;
  machine: Machine;
  now: () => Date;
}

/** A command gives a reply, which main prints. */
export type Command = (args: Parsed, ctx: Ctx) => Reply<object> | Promise<Reply<object>>;

export interface CommandSpec {
  run: Command;
  flags: FlagSpec[];
  /** An unknown --name value is a workflow input. */
  inputs?: true;
}

/** A command's flags, by name. Each is a flag sous owns, so it never becomes an input. Every command takes --help. */
function takes(...names: string[]): FlagSpec[] {
  const stray = names.filter((name) => !RESERVED.includes(name));
  if (stray.length) throw new Error(`add --${stray.join(", --")} to the flags of args.ts first`);
  return flagsNamed([...names, "help", "h"]);
}

export const COMMANDS: Record<string, CommandSpec> = {
  run: { run: cmdRun, flags: takes("place", "model", "set", "concurrency", "project", "wait", "json"), inputs: true },
  wait: { run: cmdWait, flags: takes("timeout", "json") },
  status: { run: cmdStatus, flags: takes("since", "line", "all", "json") },
  list: { run: cmdList, flags: takes("all", "json") },
  show: { run: cmdShow, flags: takes("full", "json") },
  log: { run: cmdLog, flags: takes("follow", "json") },
  inbox: { run: cmdInbox, flags: takes("json") },
  answer: { run: (args, ctx) => cmdAnswer(args, ctx, "answer"), flags: takes("value-json", "json") },
  approve: { run: (args, ctx) => cmdAnswer(args, ctx, "approve"), flags: takes("json") },
  "send-back": { run: (args, ctx) => cmdAnswer(args, ctx, "send-back"), flags: takes("json") },
  pause: { run: cmdPause, flags: takes("json") },
  resume: { run: cmdResume, flags: takes("latest", "same", "wait", "json") },
  stop: { run: cmdStop, flags: takes("step", "json") },
  rerun: { run: cmdRerun, flags: takes("place", "reuse", "set", "model", "wait", "json"), inputs: true },
  workflows: { run: cmdWorkflows, flags: takes("project", "json") },
  check: { run: cmdCheck, flags: takes("project", "dry-run", "answers", "json"), inputs: true },
  schedule: { run: cmdSchedule, flags: takes("cron", "place", "project", "json"), inputs: true },
  daemon: { run: cmdDaemon, flags: takes("json") },
  gc: { run: cmdGc, flags: takes("dry-run", "json") },
  discard: { run: cmdDiscard, flags: takes("yes", "json") },
  prune: { run: cmdPrune, flags: takes("days", "json") },
  account: { run: cmdAccount, flags: takes("json") },
  doctor: { run: cmdDoctor, flags: takes("live", "model", "json") },
  guide: { run: cmdGuide, flags: takes("json") },
  skill: { run: cmdSkill, flags: takes("json") },
};

/** The other names a command answers to. Help does not list them. */
export const ALIASES: Record<string, CommandSpec> = { ls: COMMANDS.list!, logs: COMMANDS.log!, questions: COMMANDS.inbox!, schedules: COMMANDS.schedule!, accounts: COMMANDS.account! };
