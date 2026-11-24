// The sous commands by name. A new command is one entry here and its function in a command file.

import type { HomePaths, Launcher } from "@sous/engine";
import { flagsNamed, RESERVED, type FlagSpec, type Parsed } from "../args.js";
import type { Machine } from "../cli.js";
import { cmdDiscard, cmdGc, cmdPause, cmdPrune, cmdStop } from "./control.js";
import { cmdAnswer, cmdInbox } from "./questions.js";
import { cmdList, cmdLog, cmdShow, cmdWait } from "./reads.js";
import { cmdRerun, cmdResume, cmdRun } from "./runs.js";
import { cmdDaemon, cmdSchedule } from "./service.js";
import { cmdAccount, cmdDoctor } from "./setup.js";
import { cmdCheck, cmdWorkflows } from "./workflows.js";

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

export type Command = (args: Parsed, ctx: Ctx) => number | Promise<number>;

export interface CommandSpec {
  run: Command;
  flags: FlagSpec[];
  /** An unknown --name value is a workflow input. */
  inputs?: true;
  usage: string;
}

/** A command's flags, by name. Each is a flag sous owns, so it never becomes an input. Every command takes --help. */
function takes(...names: string[]): FlagSpec[] {
  const stray = names.filter((name) => !RESERVED.includes(name));
  if (stray.length) throw new Error(`add --${stray.join(", --")} to the flags of args.ts first`);
  return flagsNamed([...names, "help", "h"]);
}

export const COMMANDS: Record<string, CommandSpec> = {
  run: { run: cmdRun, flags: takes("place", "model", "set", "concurrency", "project", "wait", "json"), inputs: true, usage: "sous run <workflow> [--name value ...] [-- --name value ...]" },
  wait: { run: cmdWait, flags: takes("json"), usage: "sous wait <run> [--json]" },
  list: { run: cmdList, flags: takes("all", "json"), usage: "sous list [--all]" },
  show: { run: cmdShow, flags: takes("json"), usage: "sous show <run>" },
  log: { run: cmdLog, flags: takes("follow"), usage: "sous log <run> [-f]" },
  inbox: { run: cmdInbox, flags: takes("json"), usage: "sous inbox [run]" },
  answer: { run: (args, ctx) => cmdAnswer(args, ctx, "answer"), flags: takes("json"), usage: "sous answer <question> <text>" },
  approve: { run: (args, ctx) => cmdAnswer(args, ctx, "approve"), flags: takes("json"), usage: "sous approve <question>" },
  "send-back": { run: (args, ctx) => cmdAnswer(args, ctx, "send-back"), flags: takes("json"), usage: "sous send-back <question> <note>" },
  pause: { run: cmdPause, flags: takes(), usage: "sous pause <run>" },
  resume: { run: cmdResume, flags: takes("latest", "same", "wait", "json"), usage: "sous resume <run> [--wait]" },
  stop: { run: cmdStop, flags: takes("step"), usage: "sous stop <run>" },
  rerun: { run: cmdRerun, flags: takes("place", "reuse", "set", "model", "wait", "json"), inputs: true, usage: "sous rerun <run> [--name value ...]" },
  workflows: { run: cmdWorkflows, flags: takes("project", "json"), usage: "sous workflows" },
  check: { run: cmdCheck, flags: takes("project", "dry-run", "answers", "json"), inputs: true, usage: "sous check <workflow> [--name value]" },
  schedule: { run: cmdSchedule, flags: takes("cron", "place", "project", "json"), inputs: true, usage: "sous schedule add|list|remove|enable|disable|test" },
  daemon: { run: cmdDaemon, flags: takes(), usage: "sous daemon start|stop|status" },
  gc: { run: cmdGc, flags: takes("dry-run"), usage: "sous gc [--dry-run]" },
  discard: { run: cmdDiscard, flags: takes("yes"), usage: "sous discard <run> [--yes]" },
  prune: { run: cmdPrune, flags: takes("days"), usage: "sous prune --days N" },
  account: { run: cmdAccount, flags: takes("json"), usage: "sous account [add|use|remove <name>]" },
  doctor: { run: cmdDoctor, flags: takes("live", "model", "json"), usage: "sous doctor [--live]" },
};

/** The other names a command answers to. Help does not list them. */
export const ALIASES: Record<string, CommandSpec> = { ls: COMMANDS.list!, logs: COMMANDS.log!, questions: COMMANDS.inbox!, schedules: COMMANDS.schedule!, accounts: COMMANDS.account! };
