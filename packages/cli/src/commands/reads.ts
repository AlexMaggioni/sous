// sous list, show, log and wait: the commands that read runs.

import { describeAccount, HARNESSES, harnessName, hint, isHarness, limitNotice, listRecords, listRuns, readLog, runDetail, runQuestions, scopePath, type RunDetail, type RunRecord } from "@sous/engine";
import type { Parsed } from "../args.js";
import { age, needRun, runIdArg, waitFor } from "./common.js";
import type { Ctx } from "./index.js";

type Step = RunDetail["steps"][number];

export function cmdWait(args: Parsed, ctx: Ctx): Promise<number> {
  return waitFor(ctx, needRun(ctx.paths, args.positional[0]).runId, { json: ctx.json });
}

export function cmdList(args: Parsed, ctx: Ctx): number {
  const { paths, machine } = ctx;
  const out = machine.out;
  const runs = listRuns(paths, args.flags.all ? {} : { limit: 20 });
  if (ctx.json) {
    out(JSON.stringify(runs.map(({ record, word, saved }) => ({ runId: record.runId, workflow: record.workflow, status: word, state: saved?.status, pauseReason: saved?.pauseReason, createdAt: record.createdAt, place: record.place, cwd: record.cwd, origin: record.origin })), null, 2));
    return 0;
  }
  if (!runs.length) {
    out("no runs yet. sous workflows lists what you can run.");
    return 0;
  }
  const width = Math.max(8, ...runs.map((run) => run.record.workflow.length));
  out(`${"RUN".padEnd(16)} ${"WORKFLOW".padEnd(width)} ${"STATUS".padEnd(20)} ${"AGE".padEnd(5)} WHERE`);
  for (const { record, word } of runs) {
    const where = record.place === "worktree" ? (record.branch ?? record.cwd) : record.place === "none" ? "scratch" : record.cwd;
    out(`${record.runId.padEnd(16)} ${record.workflow.padEnd(width)} ${word.padEnd(20)} ${age(record.createdAt, ctx.now()).padEnd(5)} ${where}`);
  }
  // Only the shown runs' states are read, so the count reads the records alone.
  const older = args.flags.all ? 0 : listRecords(paths).length - runs.length;
  if (older > 0) out(`(${older} older runs: sous list --all)`);
  const asks = runQuestions(paths).length;
  if (asks) out(`\n${asks} question${asks === 1 ? "" : "s"} waiting: sous inbox`);
  return 0;
}

export function cmdShow(args: Parsed, ctx: Ctx): number {
  const { paths, machine } = ctx;
  const out = machine.out;
  const run = runDetail(paths, runIdArg(args.positional[0]));
  const { record, saved } = run;
  if (ctx.json) {
    out(JSON.stringify({ record, state: run.engineState, questions: run.questions }, null, 2));
    return 0;
  }
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
  return 0;
}

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
    read = readLog(paths, read.runId, read.end);
    if (read.text) machine.write(read.text);
  }
  return 0;
}
