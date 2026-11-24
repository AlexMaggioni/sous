// sous stop, pause, discard, prune and gc: the commands that change or clear runs. A request that
// finds nothing to change exits 0 with a note.

import { discardRun, gcRuns, loadConfig, pauseRun, pruneRuns, readRun, stopRun, stopStep } from "@sous/engine";
import { str, Usage, type Parsed } from "../args.js";
import { reply, type Next, type Reply } from "../reply.js";
import { needRun, stopReply } from "./common.js";
import type { Ctx } from "./index.js";

/** The call that waits for a run, in JSON. */
const waitNext = (runId: string, does: string): Next => ({ call: `sous wait ${runId} --json`, does });

export function cmdStop(args: Parsed, ctx: Ctx): Reply<object> {
  const { paths } = ctx;
  const { record } = needRun(paths, args.positional[0]);
  const runId = record.runId;
  if (typeof args.flags.step === "string") {
    const step = args.flags.step;
    if (!stopStep(paths, runId, step)) {
      const status = readRun(paths, runId).status;
      return reply({ runId, step, stopping: false, status }, { notes: [`${runId} is not running (${status}), so no step runs and nothing stops.`] });
    }
    return reply(
      { runId, step, stopping: true },
      {
        text: [`stopping "${step}" in ${runId}. The run pauses on it, and sous resume ${runId} runs it again.`],
        next: ctx.json ? [waitNext(runId, "waits until the run pauses on the step")] : [],
      },
    );
  }
  const stop = stopRun(paths, runId);
  const answer = stopReply(runId, stop, { runId, outcome: stop.outcome, status: readRun(paths, runId).status });
  if (ctx.json && stop.outcome === "stopping") answer.next.push(waitNext(runId, "waits until the run stops"));
  return answer;
}

export function cmdPause(args: Parsed, ctx: Ctx): Reply<object> {
  const { paths } = ctx;
  const { record } = needRun(paths, args.positional[0]);
  const runId = record.runId;
  const pausing = pauseRun(paths, runId);
  const status = readRun(paths, runId).status;
  if (!pausing) return reply({ runId, status, pausing }, { notes: [`${runId} is not running (${status}), so there is nothing to pause.`] });
  return reply(
    { runId, status, pausing },
    {
      text: [`pausing ${runId}: steps already running finish, nothing new starts. sous resume ${runId} goes on.`],
      next: ctx.json ? [waitNext(runId, "waits until the run pauses")] : [],
    },
  );
}

export function cmdGc(args: Parsed, ctx: Ctx): Reply<object> {
  const dryRun = args.flags["dry-run"] === true;
  const { removed, kept } = gcRuns(ctx.paths, { dryRun });
  const text = [
    ...removed.map((item) => `${dryRun ? "would remove" : "removed"} ${item.dir} (${item.branch}): ${item.reason}`),
    ...kept.map((item) => `kept ${item.dir} (${item.branch}): ${item.reason}`),
  ];
  if (!text.length) text.push("no worktrees");
  const next: Next[] = ctx.json && dryRun && removed.length ? [{ call: "sous gc --json", does: "removes the merged worktrees" }] : [];
  return reply({ dryRun, removed, kept }, { text, next });
}

export function cmdDiscard(args: Parsed, ctx: Ctx): Reply<object> {
  const { paths } = ctx;
  const { record } = needRun(paths, args.positional[0]);
  const runId = record.runId;
  const yes = args.flags.yes === true;
  const text: string[] = [];
  const worktrees = discardRun(paths, runId, { remove: yes, deleted: (tree) => text.push(`deleted ${tree.branch} and ${tree.dir}`) });
  if (!worktrees.length) return reply({ runId, worktrees, deleted: false }, { notes: [`${runId} has no worktree left, so there is nothing to discard.`] });
  if (yes) return reply({ runId, worktrees, deleted: true }, { text });
  return reply(
    { runId, worktrees, deleted: false },
    {
      text: worktrees.map((tree) => `would delete ${tree.branch} and ${tree.dir}`),
      notes: [`Nothing is deleted yet. Deleting them loses the work on these branches. sous discard ${runId} --yes deletes them.`],
      next: ctx.json ? [{ call: `sous discard ${runId} --yes --json`, does: "deletes these branches and worktrees" }] : [],
    },
  );
}

/** How many run ids sous prune --json lists. */
const PRUNED_MAX = 100;

export function cmdPrune(args: Parsed, ctx: Ctx): Reply<object> {
  const paths = ctx.paths;
  const days = Number(str(args.flags.days) ?? loadConfig(paths).keepDays);
  if (!Number.isFinite(days) || days < 0) throw new Usage("sous prune --days N (or set keepDays in config.json)");
  const removed = pruneRuns(paths, days);
  const notes = ctx.json && removed.length > PRUNED_MAX ? [`${removed.length - PRUNED_MAX} more removed run ids not shown.`] : [];
  return reply(
    { days, removed: removed.length, runIds: removed.slice(0, PRUNED_MAX) },
    { text: [removed.length ? `removed ${removed.length} finished runs older than ${days} days` : "nothing to remove"], notes },
  );
}
