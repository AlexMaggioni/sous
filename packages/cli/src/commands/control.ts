// sous stop, pause, discard, prune and gc: the commands that change or clear runs. A request that
// finds nothing to change exits 0 with a note.

import { discardRun, gcRuns, loadConfig, pauseRun, pruneRuns, readRun, stopRun, stopStep, type RunView } from "@sous/engine";
import { str, Usage, type Parsed } from "../args.js";
import { reply, type Next, type Reply } from "../reply.js";
import { needRun, stopReply, waitNext } from "./common.js";
import type { Ctx } from "./index.js";

/** The states of a run whose worker works. */
const LIVE = new Set<RunView["status"]>(["starting", "pending", "running", "asks"]);

/** The call that fits a run a request found in the wrong state: resume a paused run, wait for a
 *  live one, and rerun one that ended or never started. */
export function stateNext(view: RunView): Next[] {
  if (view.resume.ok) return [{ call: `sous resume ${view.runId} --json`, does: "goes on with the run" }];
  if (LIVE.has(view.status)) return [waitNext(view.runId, "waits for the run")];
  return [{ call: `sous rerun ${view.runId} --json`, does: "starts the run again" }];
}

export function cmdStop(args: Parsed, ctx: Ctx): Reply<object> {
  const { paths } = ctx;
  const { record } = needRun(paths, args.positional[0]);
  const runId = record.runId;
  if (typeof args.flags.step === "string") {
    const step = args.flags.step;
    const stopping = stopStep(paths, runId, step);
    const view = readRun(paths, runId);
    const data = { runId, step, stopping, status: view.status };
    if (!stopping) return reply(data, { notes: [`${runId} is not running (${view.status}), so no step runs and nothing stops.`], next: stateNext(view) });
    return reply(data, {
      text: [`stopping "${step}" in ${runId}. The run pauses on it, and sous resume ${runId} runs it again.`],
      next: [waitNext(runId, "waits until the run pauses on the step")],
    });
  }
  const stop = stopRun(paths, runId);
  const view = readRun(paths, runId);
  const answer = stopReply(runId, stop, { runId, outcome: stop.outcome, status: view.status });
  if (stop.outcome === "stopping") answer.next.push(waitNext(runId, "waits until the run stops"));
  else if (stop.outcome !== "stopped") answer.next.push(...stateNext(view));
  return answer;
}

export function cmdPause(args: Parsed, ctx: Ctx): Reply<object> {
  const { paths } = ctx;
  const { record } = needRun(paths, args.positional[0]);
  const runId = record.runId;
  const pausing = pauseRun(paths, runId);
  const view = readRun(paths, runId);
  const data = { runId, status: view.status, pausing };
  if (!pausing) return reply(data, { notes: [`${runId} is not running (${view.status}), so there is nothing to pause.`], next: stateNext(view) });
  return reply(data, {
    text: [`pausing ${runId}: steps already running finish, nothing new starts. sous resume ${runId} goes on.`],
    next: [waitNext(runId, "waits until the run pauses")],
  });
}

export function cmdGc(args: Parsed, ctx: Ctx): Reply<object> {
  const dryRun = args.flags["dry-run"] === true;
  const { removed, kept } = gcRuns(ctx.paths, { dryRun });
  const text = [
    ...removed.map((item) => `${dryRun ? "would remove" : "removed"} ${item.dir} (${item.branch}): ${item.reason}`),
    ...kept.map((item) => `kept ${item.dir} (${item.branch}): ${item.reason}`),
  ];
  if (!text.length) text.push("no worktrees");
  const next: Next[] = dryRun && removed.length ? [{ call: "sous gc --json", does: "removes the merged worktrees" }] : [];
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
      next: [{ call: `sous discard ${runId} --yes --json`, does: "deletes these branches and worktrees" }],
    },
  );
}

/** How many run ids sous prune --json lists. */
const PRUNED_MAX = 100;

export function cmdPrune(args: Parsed, ctx: Ctx): Reply<object> {
  const paths = ctx.paths;
  const days = Number(str(args.flags.days) ?? loadConfig(paths).keepDays);
  if (!Number.isFinite(days) || days < 0) throw new Usage("sous prune --days N (or set keepDays in config.json)", "bad_argument", "Give the number of days to keep finished runs.", "sous prune --days 30");
  const removed = pruneRuns(paths, days);
  const notes = ctx.json && removed.length > PRUNED_MAX ? [`${removed.length - PRUNED_MAX} more removed run ids not shown.`] : [];
  return reply(
    { days, removed: removed.length, runIds: removed.slice(0, PRUNED_MAX) },
    { text: [removed.length ? `removed ${removed.length} finished runs older than ${days} days` : "nothing to remove"], notes },
  );
}
