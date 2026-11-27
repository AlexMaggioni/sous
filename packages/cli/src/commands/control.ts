// sous stop, pause, tell, discard, prune and gc: the commands that change or clear runs. A request
// that finds nothing to change exits 0 with a note.

import { discardRun, gcRuns, loadConfig, pauseRun, pruneRuns, readRun, stopRun, stopStep, tellResult, tellStep, word, type RunView } from "@sous-run/engine";
import { str, Usage, type Parsed } from "../args.js";
import { reply, type Next, type Reply } from "../reply.js";
import { needRun, runIdArg, stopReply, wholeFlag } from "./common.js";
import { rerunNext, resumeNext, waitNext } from "./next.js";
import type { Ctx } from "./index.js";

/** The states of a run whose worker works. */
const LIVE = new Set<RunView["status"]>(["starting", "pending", "running", "asks"]);

/** The call that fits a run a request found in the wrong state: resume a paused run, wait for a
 *  live one, and rerun one that ended or never started. */
export function stateNext(view: RunView): Next[] {
  if (view.resume.ok) return [resumeNext(view.runId, "goes on with the run")];
  if (LIVE.has(view.status)) return [waitNext(view.runId, "waits for the run")];
  return [rerunNext(view.runId, "starts the run again")];
}

export function cmdStop(args: Parsed, ctx: Ctx): Reply<object> {
  const { paths } = ctx;
  const { record } = needRun(paths, args.positional[0]);
  const runId = record.runId;
  if (typeof args.flags.step === "string") {
    const step = args.flags.step;
    const stopping = stopStep(paths, runId, step, ctx.who);
    const view = readRun(paths, runId);
    const data = { runId, step, stopping, status: view.status };
    if (!stopping) return reply(data, { notes: [`${runId} is not running (${view.status}), so no step runs and nothing stops.`], next: stateNext(view) });
    return reply(data, {
      text: [`stopping "${step}" in ${runId}. The run pauses on it, and sous resume ${runId} goes on with it in its session.`],
      next: [waitNext(runId, "waits until the run pauses on the step")],
    });
  }
  const stop = stopRun(paths, runId, ctx.who);
  const view = readRun(paths, runId);
  const answer = stopReply(runId, stop, { runId, outcome: stop.outcome, status: view.status });
  if (stop.outcome === "stopping") answer.next.push(waitNext(runId, "waits until the run stops"));
  else if (stop.outcome !== "stopped") answer.next.push(...stateNext(view));
  return answer;
}

/** sous tell: a message to a running agent step, which it reads after its current tool call. The
 *  reply waits up to tellWaitMs for the worker's receipt. */
export async function cmdTell(args: Parsed, ctx: Ctx): Promise<Reply<object>> {
  const id = runIdArg(args.positional[0]);
  const step = str(args.flags.step);
  const text = args.positional[1];
  if (!step) throw new Usage("give the step to tell with --step, such as sous tell <run> --step <step> \"message\"", "bad_argument", undefined, `sous show ${id} --json`);
  if (!text) throw new Usage("give the message after the run id, such as sous tell <run> --step <step> \"message\"", "bad_argument", undefined, null);
  const call = wholeFlag(args, "call", 1);
  const sent = tellStep(ctx.paths, id, { step, text, ...(call === undefined ? {} : { call }) }, ctx.who);
  const { delivery, calls, notes } = await tellResult(ctx.paths, sent, { waitMs: ctx.tellWaitMs, sleep: ctx.machine.sleep });
  const runId = sent.runId;
  const to = calls.length === 1 ? `"${step}"` : `${calls.length} calls of "${step}"`;
  return reply(
    { runId, step, told: true, delivery, calls },
    {
      text: [delivery === "delivered" ? `told ${to} in ${runId}.` : `sent to ${to} in ${runId}. It is not read yet.`],
      notes,
      next: [
        ...calls.map((told) => ({ call: `sous step ${runId} ${word(told.step)} --call ${told.call} --json`, does: `shows call ${told.call} of the step, with the message once it reads it` })),
        waitNext(runId, "waits until the run ends, pauses or asks"),
      ],
    },
  );
}

export function cmdPause(args: Parsed, ctx: Ctx): Reply<object> {
  const { paths } = ctx;
  const { record } = needRun(paths, args.positional[0]);
  const runId = record.runId;
  const pausing = pauseRun(paths, runId, ctx.who);
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
  const { removed, kept } = gcRuns(ctx.paths, ctx.who, { dryRun });
  // A branch whose worktree's scope ended has no folder.
  const where = (item: { dir: string; branch: string }) => (item.dir ? `${item.dir} (${item.branch})` : `branch ${item.branch}`);
  const text = [
    ...removed.map((item) => `${dryRun ? "would remove" : "removed"} ${where(item)}: ${item.reason}`),
    ...kept.map((item) => `kept ${where(item)}: ${item.reason}`),
  ];
  if (!text.length) text.push("no branches of sous");
  const next: Next[] = dryRun && removed.length ? [{ call: "sous gc --json", does: "removes the merged branches and their worktrees" }] : [];
  return reply({ dryRun, removed, kept }, { text, next });
}

export function cmdDiscard(args: Parsed, ctx: Ctx): Reply<object> {
  const { paths } = ctx;
  const { record } = needRun(paths, args.positional[0]);
  const runId = record.runId;
  const yes = args.flags.yes === true;
  const text: string[] = [];
  const both = (tree: { branch: string; dir?: string }) => `${tree.branch}${tree.dir ? ` and ${tree.dir}` : ""}`;
  const worktrees = discardRun(paths, runId, ctx.who, { remove: yes, deleted: (tree) => text.push(`deleted ${both(tree)}`) });
  if (!worktrees.length) return reply({ runId, worktrees, deleted: false }, { notes: [`${runId} has no branch or worktree left, so there is nothing to discard.`] });
  if (yes) return reply({ runId, worktrees, deleted: true }, { text });
  return reply(
    { runId, worktrees, deleted: false },
    {
      text: worktrees.map((tree) => `would delete ${both(tree)}`),
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
  const removed = pruneRuns(paths, days, ctx.who);
  const notes = ctx.json && removed.length > PRUNED_MAX ? [`${removed.length - PRUNED_MAX} more removed run ids not shown.`] : [];
  return reply(
    { days, removed: removed.length, runIds: removed.slice(0, PRUNED_MAX) },
    { text: [removed.length ? `removed ${removed.length} finished runs older than ${days} days` : "nothing to remove"], notes },
  );
}
