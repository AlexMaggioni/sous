// What several commands share: the run a command names, the wait, and the start line.

import { resolve } from "node:path";
import { answerQuestion, findProjectDir, hint, logFile, readRun, runPreview, stopRun, waitForRun, word, type HomePaths, type RunQuestion, type RunRecord, type RunView } from "@sous/engine";
import { str, Usage, type Parsed } from "../args.js";
import { reply, type Next, type Reply } from "../reply.js";
import type { Ctx } from "./index.js";
import { nextCalls, waitNext } from "./next.js";

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

/** The call with the command's --project, when the command had one and the call names none. */
export function atProject(call: string, project: string | undefined): string {
  if (!project || /(^| )--project( |$)/.test(call)) return call;
  return `${call} --project ${word(project)}`;
}

/** The whole number a flag gives, at least `min`. Undefined when the flag is not there. */
export function wholeFlag(args: Parsed, name: string, min: number): number | undefined {
  const text = str(args.flags[name]);
  if (text === undefined) return undefined;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < min) throw new Usage(`--${name} takes a whole number of ${min} or more, got "${text}"`);
  return value;
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
 * in seconds, the wait ends after that long with exit code 5 while the run goes on. An agent's
 * wait, or a step's, has a timeout of AGENT_WAIT seconds when it gives none.
 */
export async function waitFor(ctx: Ctx, runId: string, json: boolean, timeout?: number): Promise<Reply<object>> {
  const { paths, machine } = ctx;
  const interactive = machine.isTerminal && !json;
  const seconds = timeout ?? (ctx.who.through.kind === "agent" || ctx.who.through.kind === "run" ? AGENT_WAIT : undefined);
  const end = await waitForRun(paths, runId, {
    ...(seconds === undefined ? {} : { until: Date.now() + seconds * 1000 }),
    ...(json ? {} : { log: (text: string) => machine.write(text) }),
    ...(interactive ? { asks: (questions: RunQuestion[]) => askHere(ctx, questions) } : {}),
  });
  if (end.timedOut) {
    if (!json) return reply({}, { text: [`\nstill running after ${seconds}s. sous wait ${runId} waits again.`], exit: WAIT_TIMED_OUT });
    const summary = { ...end.summary, status: "running" as const };
    const calls = nextCalls(summary, "wait", ctx.who, timeout);
    return reply(summary, { exit: WAIT_TIMED_OUT, next: calls.next, notes: [...(timeout === undefined ? [AGENT_WAIT_NOTE] : []), ...calls.notes] });
  }
  if (json) return reply(end.summary, { exit: end.code, ...nextCalls(end.summary, "wait", ctx.who, timeout) });
  const text: string[] = [];
  if (end.questions) {
    for (const q of end.questions) text.push(`\nwaiting for an answer to ${q.id}:\n  ${q.prompt}\n  ${hint(q)}\n  then: sous wait ${runId}`);
  } else if (end.summary.status === "completed" && end.summary.result !== undefined) {
    text.push("result:", typeof end.summary.result === "string" ? end.summary.result : JSON.stringify(end.summary.result, null, 2));
  }
  return reply({}, { text, exit: end.code });
}

/** The exit code of a wait that reached its --timeout. */
const WAIT_TIMED_OUT = 5;

/** The seconds an agent's wait lasts without --timeout: under the two minutes Claude Code gives a tool call. */
const AGENT_WAIT = 110;
const AGENT_WAIT_NOTE = `An agent's wait ends after ${AGENT_WAIT} seconds unless it gives --timeout, since Claude Code stops a tool call after two minutes. The run goes on. Wait again, or give a longer --timeout with a longer tool timeout.`;

/** Ask each question in the terminal and write the answer. "stop" at a breakpoint stops the run. */
async function askHere(ctx: Ctx, questions: RunQuestion[]): Promise<void> {
  for (const question of questions) {
    const text = await ctx.machine.ask(`\n${question.prompt}\n(${hint(question, "prompt")}) > `);
    answerQuestion(ctx.paths, question, { via: "prompt", text }, ctx.who);
  }
}

/** Say the run started, or wait for it with --wait. */
export async function startedOrWait(ctx: Ctx, record: RunRecord, mode: "start" | "resume", args: Parsed): Promise<Reply<object>> {
  if (args.flags.wait) return waitFor(ctx, record.runId, ctx.json);
  if (mode === "start") return started(ctx, record);
  if (ctx.json) return reply({ runId: record.runId, workflow: record.workflow, cwd: record.cwd, log: logFile(ctx.paths, record.runId) });
  return reply({}, { text: [`resumed ${record.runId}  ${record.workflow}  in ${record.cwd}`, `  follow: sous wait ${record.runId}    log: sous log ${record.runId} -f`] });
}

/** The reply of a run that starts: where it runs, what it may ask and what its workflow's last
 *  runs cost. The text form prints the lines sous printed before. */
function started(ctx: Ctx, record: RunRecord): Reply<object> {
  const { runId, workflow, cwd } = record;
  if (!ctx.json) return reply({}, { text: [`started ${runId}  ${workflow}  in ${cwd}`, `  follow: sous wait ${runId}    log: sous log ${runId} -f`] });
  const data = { runId, workflow, cwd, log: logFile(ctx.paths, runId), status: "starting", ...(record.branch ? { branch: record.branch } : {}), ...runPreview(ctx.paths, record) };
  return reply(data, { next: [waitNext(runId, "waits until the run ends, pauses or asks"), { call: `sous show ${runId} --json`, does: "shows the run and its steps" }] });
}

/** What `sous stop` replies, and `sous answer` when a breakpoint's reply stops the run. A stop that
 *  changes nothing says why in a note. */
export function stopReply<T extends object>(runId: string, stop: ReturnType<typeof stopRun>, data: T): Reply<T> {
  if (stop.outcome === "stopping") return reply(data, { text: [`stopping ${runId}`] });
  if (stop.outcome === "stopped") return reply(data, { text: [`stopped ${runId}`] });
  const why =
    stop.outcome === "already-ended"
      ? `${runId} already ended (${stop.status ?? "done"}), so there is nothing to stop.`
      : stop.outcome === "never-started"
        ? `${runId} never started, so there is nothing to stop.`
        : `${runId} is held by another process, so this sous does not stop it.`;
  return reply(data, { notes: [why] });
}
