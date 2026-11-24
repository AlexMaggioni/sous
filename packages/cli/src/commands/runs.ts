// sous run, rerun and resume: the commands that start a worker.

import { isPlace, rerunRun, resumeRun, startRun, type Place } from "@sous/engine";
import { parseSets, str, Usage, type Parsed } from "../args.js";
import { reply, type Reply } from "../reply.js";
import { needRun, projectDir, startedOrWait } from "./common.js";
import { stateNext } from "./control.js";
import type { Ctx } from "./index.js";

/** The run whose step calls, from who is calling. */
const byRun = (ctx: Ctx): string | undefined => (ctx.who.through.kind === "run" ? ctx.who.through.runId : undefined);

/** A Claude Code session calls. A Codex session needs no flag: the run inherits the caller's
 *  environment, and with it Codex's own account folder. */
const byClaude = (ctx: Ctx): boolean => ctx.who.through.kind === "agent" && ctx.who.through.program === "claude";

/** The --set values of the command line. */
const sets = (args: Parsed): string[] => (Array.isArray(args.flags.set) ? args.flags.set : []);

export async function cmdRun(args: Parsed, ctx: Ctx): Promise<Reply<object>> {
  const paths = ctx.paths;
  const dir = projectDir(args);
  const workflow = args.positional[0];
  if (!workflow) throw new Usage("sous run <workflow> [--name value ...]");
  if (args.positional.length > 1) throw new Usage(`give inputs as --name value. Extra words: ${args.positional.slice(1).join(" ")}`);
  const place = str(args.flags.place);
  if (place !== undefined && !isPlace(place)) throw new Usage(`--place is worktree, folder or none, got "${place}"`);
  const concurrency = str(args.flags.concurrency);
  const record = startRun(paths, ctx.launch, {
    workflow,
    projectDir: dir,
    inputs: args.inputs,
    ...(place ? { place: place as Place } : {}),
    ...(sets(args).length ? { overrides: parseSets(sets(args)) } : {}),
    ...(str(args.flags.model) ? { defaultModel: str(args.flags.model)! } : {}),
    ...(concurrency ? { concurrency: Number(concurrency) } : {}),
    // An agent in a run starts workflows through this command too. Its shell carries the run's id.
    ...(byRun(ctx) ? { startedByRun: byRun(ctx), origin: "agent" as const } : {}),
    // A run a Claude Code session starts uses its login.
    caller: byClaude(ctx),
    who: ctx.who,
    command: ctx.command,
    ...(args.flags["let-agent-answer"] ? { letAgentAnswer: true } : {}),
  });
  return startedOrWait(ctx, record, "start", args);
}

export async function cmdResume(args: Parsed, ctx: Ctx): Promise<Reply<object>> {
  const paths = ctx.paths;
  const run = needRun(paths, args.positional[0]);
  // A run that cannot resume says so before this usage error. resumeRun refuses it.
  if (args.flags.latest && args.flags.same && run.resume.ok) {
    throw new Usage("--latest or --same, not both", "bad_argument", "Keep one: --latest takes the new version, --same goes on with the version the run started with.", `sous resume ${run.runId} --same --json`);
  }
  const choice = args.flags.latest ? "latest" : args.flags.same ? "same" : undefined;
  const resumed = resumeRun(paths, ctx.launch, run.runId, ctx.who, { choice, ...(args.flags["let-agent-answer"] ? { letAgentAnswer: { command: ctx.command } } : {}) });
  if ("mustChoose" in resumed) {
    const change = "Add --latest to take the new version, or --same to go on with the version the run started with.";
    throw new Usage(resumed.message, "bad_argument", change, `sous resume ${run.runId} --same --json`);
  }
  if ("wrongState" in resumed) {
    const { runId, status } = resumed.view;
    return reply({ runId, status }, { notes: [resumed.message], next: stateNext(resumed.view) });
  }
  return startedOrWait(ctx, resumed.resumed, "resume", args);
}

export async function cmdRerun(args: Parsed, ctx: Ctx): Promise<Reply<object>> {
  const paths = ctx.paths;
  const run = needRun(paths, args.positional[0]);
  const place = str(args.flags.place) ?? run.record.place;
  if (!isPlace(place)) throw new Usage(`--place is worktree, folder or none, got "${place}"`);
  const reuse = Boolean(args.flags.reuse);
  // A run that cannot be reused says so before this usage error. rerunRun refuses it.
  if (reuse && args.flags.place && run.reuse.ok) throw new Usage("--reuse works where the earlier run worked, so it takes no --place");
  const record = rerunRun(paths, ctx.launch, run.runId, {
    place,
    reuse,
    inputs: args.inputs,
    ...(sets(args).length ? { overrides: parseSets(sets(args)) } : {}),
    ...(str(args.flags.model) !== undefined ? { defaultModel: str(args.flags.model)! } : {}),
    ...(byRun(ctx) ? { startedByRun: byRun(ctx) } : {}),
    caller: byClaude(ctx),
    who: ctx.who,
    command: ctx.command,
    ...(args.flags["let-agent-answer"] ? { letAgentAnswer: true } : {}),
  });
  return startedOrWait(ctx, record, "start", args);
}
