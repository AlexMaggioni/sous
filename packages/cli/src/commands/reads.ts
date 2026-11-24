// sous list, show, log and wait: the commands that read runs.

import { describeAccount, HARNESSES, harnessName, hint, homeStatus, isHarness, limitNotice, listRecords, listRuns, readLog, Refusal, runDetail, runQuestions, scopePath, shortRun, sinceWindow, statusLine, type HomeStatus, type RunDetail, type RunRecord } from "@sous/engine";
import { str, Usage, type Parsed } from "../args.js";
import { cut, reply, type Next, type Reply } from "../reply.js";
import { age, needRun, runIdArg, waitFor } from "./common.js";
import type { Ctx } from "./index.js";
import { nextCalls } from "./next.js";

type Step = RunDetail["steps"][number];

export function cmdWait(args: Parsed, ctx: Ctx): Promise<number | Reply<object>> {
  const timeout = str(args.flags.timeout);
  const seconds = Number(timeout);
  if (timeout !== undefined && !(seconds > 0)) throw new Usage(`--timeout takes a number of seconds above 0, got "${timeout}"`);
  return waitFor(ctx, needRun(ctx.paths, args.positional[0]).runId, ctx.json, timeout === undefined ? undefined : seconds);
}

/** How many runs each list of sous status shows without --all. */
const STATUS_MAX = 20;

export function cmdStatus(args: Parsed, ctx: Ctx): Reply<object> {
  const since = str(args.flags.since);
  if (since !== undefined && sinceWindow(since) === undefined) throw new Usage(`--since takes a count and a unit, such as 30m, 12h or 3d, got "${since}"`);
  if (args.flags.line) {
    const line = statusLine(ctx.paths, ctx.now());
    return ctx.json ? reply({ line }) : reply({}, { text: line ? [line] : [] });
  }
  const { earlier, ...status } = homeStatus(ctx.paths, ctx.now(), since === undefined ? {} : { since });
  const notes: string[] = [];
  const shown = <T>(items: T[], what: string): T[] => {
    if (args.flags.all) return items;
    const part = cut(items, STATUS_MAX, "--all", what);
    if (part.note) notes.push(part.note);
    return part.items;
  };
  const data: HomeStatus = { needsYou: shown(status.needsYou, "entries that need you"), running: shown(status.running, "running runs"), waiting: shown(status.waiting, "waiting runs"), finished: shown(status.finished, "finished runs"), service: status.service };
  if (earlier) notes.push(`${earlier} run${earlier === 1 ? "" : "s"} ended before the last ${since ?? "24h"}. Add --since with a longer time, such as --since 7d, to see them.`);
  if (ctx.json) return reply(data, { notes, next: data.needsYou.map((entry) => ({ call: entry.call, does: entry.question ? `answers "${entry.question.prompt}"` : `shows why ${entry.runId} needs you` })) });
  return reply({}, { notes, text: statusText(data, ctx.now()) });
}

/** sous status in text, one section a list. */
function statusText(status: HomeStatus, now: Date): string[] {
  const text: string[] = [];
  const section = <T>(title: string, items: T[], lines: (item: T) => string[]) => {
    if (!items.length) return;
    text.push(title);
    for (const item of items) text.push(...lines(item).map((line) => `  ${line}`));
  };
  section("needs you", status.needsYou, (entry) => [`${entry.runId}  ${entry.workflow}  ${entry.question ? `asks: ${entry.question.prompt}` : entry.what}`, `  ${entry.call}`]);
  section("running", status.running, (run) => [`${run.runId}  ${run.workflow}  ${run.minutes}m  ${run.tokens} tokens${run.steps.length ? `  ${run.steps.join(", ")}` : ""}`]);
  section("waiting", status.waiting, (run) => [`${run.runId}  ${run.workflow}  ${run.what}${run.resumesAt ? `, resumes at ${run.resumesAt}` : ""}`]);
  section("finished", status.finished, (run) => [`${run.runId}  ${run.workflow}  ${run.status}  ${age(run.at, now)} ago${run.branch ? `  branch ${run.branch}` : ""}`]);
  if (!text.length) text.push("nothing needs you, and no run runs or waits.");
  text.push(`service ${status.service.running ? "running" : "not running"}`);
  return text;
}

/** How many runs sous list shows without --all. */
const LIST_MAX = 20;

export function cmdList(args: Parsed, ctx: Ctx): Reply<object> {
  const { paths } = ctx;
  const records = listRecords(paths);
  // Only the shown runs' states are read, so the count reads the records alone.
  const shown = args.flags.all ? { items: records } : cut(records, LIST_MAX, "--all", "runs");
  const runs = listRuns(paths, { records: shown.items });
  if (ctx.json) {
    const rows = runs.map(({ record, word, saved }) => ({ runId: record.runId, workflow: record.workflow, status: word, state: saved?.status, pauseReason: saved?.pauseReason, createdAt: record.createdAt, place: record.place, cwd: record.cwd, origin: record.origin }));
    const next: Next[] = shown.note ? [{ call: "sous list --all --json", does: "lists every run" }] : [];
    return reply({ runs: rows }, { notes: shown.note ? [shown.note] : [], next });
  }
  const text: string[] = [];
  const out = (line: string) => text.push(line);
  if (!runs.length) {
    out("no runs yet. sous workflows lists what you can run.");
    return reply({}, { text });
  }
  const width = Math.max(8, ...runs.map((run) => run.record.workflow.length));
  out(`${"RUN".padEnd(16)} ${"WORKFLOW".padEnd(width)} ${"STATUS".padEnd(20)} ${"AGE".padEnd(5)} WHERE`);
  for (const { record, word } of runs) {
    const where = record.place === "worktree" ? (record.branch ?? record.cwd) : record.place === "none" ? "scratch" : record.cwd;
    out(`${record.runId.padEnd(16)} ${record.workflow.padEnd(width)} ${word.padEnd(20)} ${age(record.createdAt, ctx.now()).padEnd(5)} ${where}`);
  }
  const older = records.length - runs.length;
  if (older > 0) out(`(${older} older runs: sous list --all)`);
  const asks = runQuestions(paths).length;
  if (asks) out(`\n${asks} question${asks === 1 ? "" : "s"} waiting: sous inbox`);
  return reply({}, { text });
}

export function cmdShow(args: Parsed, ctx: Ctx): Reply<object> {
  const { paths } = ctx;
  const run = runDetail(paths, runIdArg(args.positional[0]));
  const { record, saved } = run;
  if (ctx.json) {
    const short = shortRun(run, ctx.now());
    const next = nextCalls(short, "show");
    if (args.flags.full) return reply({ ...short, record, state: run.engineState }, { next });
    const steps = cut(short.steps, SHOW_STEPS, "--full", "steps");
    return reply({ ...short, steps: steps.items }, { notes: steps.note ? [steps.note] : [], next });
  }
  const text: string[] = [];
  const out = (line: string) => text.push(line);
  out(`${record.workflow}  ${record.runId}`);
  out(`status    ${run.word}${saved?.resetHint ? ` (${saved.resetHint})` : ""}`);
  if (saved?.reason && saved.status !== "completed" && saved.reason !== saved.pauseReason) out(`reason    ${saved.reason}`);
  out(`place     ${record.place}  ${record.cwd}${record.branch ? `  (branch ${record.branch})` : ""}`);
  out(`started   ${record.createdAt}  by ${record.origin}${record.schedule ? ` (${record.schedule})` : ""}${record.rerunOf ? `, rerun of ${record.rerunOf}` : ""}${record.reuseFrom ? `, reusing its unchanged steps` : ""}${record.startedByRun ? `, from run ${record.startedByRun}` : ""}`);
  if (Object.keys(record.args).length) out(`inputs    ${JSON.stringify(record.args)}`);
  if (record.overrides) out(`changes   ${JSON.stringify(record.overrides)}`);
  for (const [program, used] of Object.entries(record.programs ?? {})) {
    const name = isHarness(program) ? harnessName(program) : program;
    out(`program   ${name} ${used.version ?? "(version unknown)"}  ${used.path}`);
  }
  for (const program of HARNESSES) {
    if (record.accounts?.[program]) out(`account   ${harnessName(program)}: ${describeAccount(program, record.accounts[program])}`);
  }
  if (record.limit && run.pause?.reason === "usage_limit") out(`limit     ${limitNotice(paths, record, run.pause.resetAt)}`);
  if (run.tokens !== undefined) out(`tokens    ${run.tokens}${run.durationMs ? `  in ${Math.round(run.durationMs / 1000)}s` : ""}`);
  if (run.steps.length) {
    out("steps");
    printSteps(out, record, run.steps, saved?.status !== "running" && saved?.status !== "pending");
  }
  for (const question of run.questions) out(`asks      ${question.id}: ${question.prompt}\n          ${hint(question)}`);
  if (run.result !== undefined) {
    out("result");
    out(typeof run.result === "string" ? run.result : JSON.stringify(run.result, null, 2));
  }
  return reply({}, { text });
}

/** How many steps the short sous show --json gives. */
const SHOW_STEPS = 30;

/** The steps in the order they started. A nested workflow's steps go together under it, indented. */
function printSteps(out: (line: string) => void, record: RunRecord, agents: readonly Step[], ended: boolean): void {
  const scopeOf = (agent: Step) => (typeof agent.scope === "string" ? agent.scope : record.runId);
  const line = (agent: Step, indent: string) => {
    // A step the run left running when it ended never finished.
    const status = ended && agent.status === "running" ? "stopped" : agent.status;
    const mark = status === "done" ? "done " : status === "error" ? "error" : status.padEnd(5);
    const seconds = agent.startedAt && agent.endedAt ? Math.round((Date.parse(agent.endedAt) - Date.parse(agent.startedAt)) / 1000) : undefined;
    const cost = [seconds !== undefined ? `${seconds}s` : "", agent.tokens ? `${agent.tokens} tokens` : ""].filter(Boolean).join(", ");
    const extra = agent.error ? `  ${agent.error.replace(/\s+/g, " ").slice(0, 120)}` : agent.model ? `  ${agent.model}` : "";
    out(`${indent}${mark} ${agent.label}${cost ? `  (${cost})` : ""}${extra}`);
  };
  const printScope = (scope: string, indent: string) => {
    const opened = new Set<string>();
    for (const agent of agents) {
      const own = scopeOf(agent);
      if (own === scope) {
        line(agent, indent);
        continue;
      }
      // The child of this scope that holds the step, which may itself hold deeper ones.
      const path = own === record.runId ? [own] : [record.runId, ...scopePath(record.nested, own)];
      const at = path.indexOf(scope);
      if (at === -1 || at === path.length - 1) continue;
      const child = path[at + 1]!;
      if (opened.has(child)) continue;
      opened.add(child);
      const nested = record.nested?.[child];
      const name = nested?.workflow ?? "nested workflow";
      const where = nested?.branch ? `, branch ${nested.branch}` : "";
      out(`${indent}${nested?.label ? `${nested.label}  (workflow ${name}${where})` : `workflow ${name}${where ? ` (${where.slice(2)})` : ""}`}`);
      printScope(child, `${indent}  `);
    }
  };
  printScope(record.runId, "  ");
}

export async function cmdLog(args: Parsed, ctx: Ctx): Promise<number> {
  const { paths, machine } = ctx;
  let read = readLog(paths, runIdArg(args.positional[0]));
  if (read.text) machine.write(read.text);
  if (!args.flags.follow) return 0;
  while (read.running) {
    await machine.sleep(400);
    read = followOn(paths, read);
    if (read.text) machine.write(read.text);
  }
  return 0;
}

/** The log after `read`. A run that goes away while sous follows it is no wrong id, so its
 *  refusal becomes a plain error that exits 1. The pinned test "let sous log -f print the no run
 *  error, and exit 1, when the run goes away while it follows" in reads.test.ts holds this. */
function followOn(paths: Ctx["paths"], read: ReturnType<typeof readLog>): ReturnType<typeof readLog> {
  try {
    return readLog(paths, read.runId, read.end);
  } catch (error) {
    if (error instanceof Refusal) throw new Error(error.message);
    throw error;
  }
}
