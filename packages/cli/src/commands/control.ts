// sous stop, pause, discard, prune and gc: the commands that change or clear runs.

import { discardRun, gcRuns, loadConfig, pauseRun, pruneRuns, stopRun, stopStep } from "@sous/engine";
import { str, Usage, type Parsed } from "../args.js";
import { needRun, stopText } from "./common.js";
import type { Ctx } from "./index.js";

export function cmdStop(args: Parsed, ctx: Ctx): number {
  const { paths, machine } = ctx;
  const { record } = needRun(paths, args.positional[0]);
  if (typeof args.flags.step === "string") {
    const step = args.flags.step;
    if (!stopStep(paths, record.runId, step)) {
      machine.out(`${record.runId} is not running, so no step runs`);
      return 1;
    }
    machine.out(`stopping "${step}" in ${record.runId}. The run pauses on it, and sous resume ${record.runId} runs it again.`);
    return 0;
  }
  machine.out(stopText(record.runId, stopRun(paths, record.runId)));
  return 0;
}

export function cmdPause(args: Parsed, ctx: Ctx): number {
  const { paths, machine } = ctx;
  const { record } = needRun(paths, args.positional[0]);
  if (!pauseRun(paths, record.runId)) {
    machine.out(`${record.runId} is not running`);
    return 1;
  }
  machine.out(`pausing ${record.runId}: steps already running finish, nothing new starts. sous resume ${record.runId} goes on.`);
  return 0;
}

export function cmdGc(args: Parsed, ctx: Ctx): number {
  const { paths, machine } = ctx;
  const dry = args.flags["dry-run"] === true;
  const result = gcRuns(paths, { dryRun: dry });
  for (const item of result.removed) machine.out(`${dry ? "would remove" : "removed"} ${item.dir} (${item.branch}): ${item.reason}`);
  for (const item of result.kept) machine.out(`kept ${item.dir} (${item.branch}): ${item.reason}`);
  if (!result.removed.length && !result.kept.length) machine.out("no worktrees");
  return 0;
}

export function cmdDiscard(args: Parsed, ctx: Ctx): number {
  const { paths, machine } = ctx;
  const { record } = needRun(paths, args.positional[0]);
  const yes = args.flags.yes === true;
  const trees = discardRun(paths, record.runId, { remove: yes, deleted: (tree) => machine.out(`deleted ${tree.branch} and ${tree.dir}`) });
  if (!trees.length) {
    machine.out(`${record.runId} has no worktree left`);
    return 0;
  }
  if (!yes) {
    for (const tree of trees) machine.out(`would delete ${tree.branch} and ${tree.dir}`);
    machine.out(`the work on these branches is lost. sous discard ${record.runId} --yes deletes them.`);
    return 1;
  }
  return 0;
}

export function cmdPrune(args: Parsed, ctx: Ctx): number {
  const paths = ctx.paths;
  const days = Number(str(args.flags.days) ?? loadConfig(paths).keepDays);
  if (!Number.isFinite(days) || days < 0) throw new Usage("sous prune --days N (or set keepDays in config.json)");
  const removed = pruneRuns(paths, days);
  ctx.machine.out(removed.length ? `removed ${removed.length} finished runs older than ${days} days` : "nothing to remove");
  return 0;
}
