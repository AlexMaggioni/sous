// What several commands share: the run a command names, the wait, and the start line.

import { resolve } from "node:path";
import { answerQuestion, findProjectDir, hint, logFile, readRun, runPreview, stopRun, waitForRun, type HomePaths, type RunQuestion, type RunRecord, type RunView } from "@sous/engine";
import { str, Usage, type Parsed } from "../args.js";
import { reply, type Reply } from "../reply.js";
import type { Ctx } from "./index.js";
import { nextCalls } from "./next.js";

/** How long ago, in one short unit. */
export function age(iso: string | undefined, now: Date): string {
  if (!iso) return "";
  const seconds = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 1000));
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  if (seconds < 129600) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

/** The project the command works in: --project, else the one around the current folder. */
export function projectDir(args: Parsed): string {
  const project = str(args.flags.project);
  return project ? resolve(project) : findProjectDir();
}

/** The run id the command names. */
export function runIdArg(id: string | undefined): string {
  if (!id) throw new Usage("give a run id (sous list shows them)");
  return id;
}

export function needRun(paths: HomePaths, id: string | undefined): RunView {
  return readRun(paths, runIdArg(id));
}

/**
 * Wait for a run to end, pause or ask. In a terminal, a question is asked right here and the
 * wait goes on. Elsewhere, such as from an agent's shell, the wait returns at the question
 * with exit code 4, so the caller can answer with `sous answer` and wait again. With `timeout`,
 * in seconds, the wait ends after that long with exit code 5 while the run goes on.
 */
export async function waitFor(ctx: Ctx, runId: string, json: boolean, timeout?: number): Promise<number | Reply<object>> {
  const { paths, machine } = ctx;
  const interactive = machine.isTerminal && !json;
  const end = await waitForRun(paths, runId, {
    ...(timeout === undefined ? {} : { until: Date.now() + timeout * 1000 }),
    ...(json ? {} : { log: (text: string) => machine.write(text) }),
    ...(interactive ? { asks: (questions: RunQuestion[]) => askHere(ctx, questions) } : {}),
  });
  if (end.timedOut) {
    if (!json) machine.out(`\nstill running after ${timeout}s. sous wait ${runId} waits again.`);
    const summary = { ...end.summary, status: "running" as const };
    return json ? reply(summary, { exit: WAIT_TIMED_OUT, next: nextCalls(summary, "wait", timeout) }) : WAIT_TIMED_OUT;
  }
  if (json) return reply(end.summary, { exit: end.code, next: nextCalls(end.summary, "wait") });
  if (end.questions) {
    for (const q of end.questions) machine.out(`\nwaiting for an answer to ${q.id}:\n  ${q.prompt}\n  ${hint(q)}\n  then: sous wait ${runId}`);
    return end.code;
  }
  if (end.summary.status === "completed" && end.summary.result !== undefined) {
    machine.out("result:");
    machine.out(typeof end.summary.result === "string" ? end.summary.result : JSON.stringify(end.summary.result, null, 2));
  }
  return end.code;
}

/** The exit code of a wait that reached its --timeout. */
const WAIT_TIMED_OUT = 5;

/** Ask each question in the terminal and write the answer. "stop" at a breakpoint stops the run. */
async function askHere(ctx: Ctx, questions: RunQuestion[]): Promise<void> {
  for (const question of questions) {
    const text = await ctx.machine.ask(`\n${question.prompt}\n(${hint(question, "prompt")}) > `);
    answerQuestion(ctx.paths, question, { via: "prompt", text });
  }
}

/** Say the run started, or wait for it with --wait. */
export async function startedOrWait(ctx: Ctx, record: RunRecord, mode: "start" | "resume", args: Parsed): Promise<number | Reply<object>> {
  const { machine } = ctx;
  if (!args.flags.wait && mode === "start") return started(ctx, record);
  if (!args.flags.wait) {
    if (ctx.json) return reply({ runId: record.runId, workflow: record.workflow, cwd: record.cwd, log: logFile(ctx.paths, record.runId) });
    else {
      machine.out(`${mode === "start" ? "started" : "resumed"} ${record.runId}  ${record.workflow}  in ${record.cwd}`);
      machine.out(`  follow: sous wait ${record.runId}    log: sous log ${record.runId} -f`);
    }
    return 0;
  }
  return waitFor(ctx, record.runId, ctx.json);
}

/** The reply of a run that starts: where it runs, what it may ask and what its workflow's last
 *  runs cost. The text form prints the lines sous printed before. */
function started(ctx: Ctx, record: RunRecord): Reply<object> {
  const { runId, workflow, cwd } = record;
  if (!ctx.json) return reply({}, { text: [`started ${runId}  ${workflow}  in ${cwd}`, `  follow: sous wait ${runId}    log: sous log ${runId} -f`] });
  const data = { runId, workflow, cwd, log: logFile(ctx.paths, runId), status: "starting", ...(record.branch ? { branch: record.branch } : {}), ...runPreview(ctx.paths, record) };
  const next = [
    { call: `sous wait ${runId} --json`, does: "waits until the run ends, pauses or asks" },
    { call: `sous show ${runId} --json`, does: "shows the run and its steps" },
  ];
  return reply(data, { next });
}

/** What `sous stop` prints, and `sous answer` when a breakpoint's reply stops the run. */
export function stopText(runId: string, stop: ReturnType<typeof stopRun>): string {
  if (stop.outcome === "stopping") return `stopping ${runId}`;
  if (stop.outcome === "already-ended") return `${runId} already ended (${stop.status ?? "done"})`;
  if (stop.outcome === "never-started") return `${runId} never started; nothing to stop`;
  if (stop.outcome === "held-elsewhere") return `${runId} is held by another process`;
  return `stopped ${runId}`;
}
