#!/usr/bin/env node
// orc: run saved workflows in the background, answer what they ask, pause, resume and
// schedule them. `orc help` lists the commands.

import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { openWorkflowDir, type PersistedRunState } from "@orchestrator/engine";
import { cmdAccount } from "./account-cli.js";
import { describeAccount, limitNotice } from "./accounts.js";
import { checkWorkflow } from "./check.js";
import { cronMatches, nextRun, parseCron } from "./cron.js";
import { dryRun, readAnswers } from "./dryrun.js";
import { daemonMain, daemonPid, fileSchedules, loadSchedules, prune, saveSchedules, unfinishedRuns, type Schedule } from "./daemon.js";
import { ensureHome, findProjectDir, homePaths, loadConfig, rememberProject, workflowDirs, type HomePaths, type Place } from "./home.js";
import { listQuestions, normalizeAnswer, readQuestion, removeRunQuestions, writeAnswer, type Question } from "./inbox.js";
import { workflowExtras } from "./inputs.js";
import { createRun, InputProblems, logFile, resolveWorkflow, spawnWorker } from "./launch.js";
import { doctor } from "./doctor.js";
import { isProgram, PROGRAM_INFO, PROGRAMS } from "./programs.js";
import { gcWorktrees, isPlace, removeWorktree, runWorktrees } from "./places.js";
import { findRecord, listRecords, loadSnapshot, processAlive, updateRecord, type RunRecord } from "./records.js";
import { currentWorkflows, managerFor, workerMain } from "./worker.js";

class Usage extends Error {}

interface Parsed {
  positionals: string[];
  flags: Record<string, string | true>;
  sets: string[];
  inputs: Record<string, unknown>;
}

/** orc's own flags. Any other --name before `--`, and everything after it, is a workflow input. */
const OWN_FLAGS = new Set(["place", "model", "project", "concurrency", "priority", "cron", "days", "lines", "step", "answers"]);
const OWN_SWITCHES = new Set(["wait", "json", "all", "follow", "f", "dry-run", "yes", "reuse", "latest", "same", "live", "help", "h"]);

export function parseArgs(argv: string[], ownFlags = OWN_FLAGS, ownSwitches = OWN_SWITCHES): Parsed {
  const parsed: Parsed = { positionals: [], flags: {}, sets: [], inputs: {} };
  const split = argv.indexOf("--");
  const head = split === -1 ? argv : argv.slice(0, split);
  const tail = split === -1 ? [] : argv.slice(split + 1);
  const readInputs = (list: string[], into: Record<string, unknown>, own: boolean) => {
    for (let i = 0; i < list.length; i++) {
      const arg = list[i]!;
      if (arg === "-f" && own) {
        parsed.flags.follow = true;
        continue;
      }
      if (!arg.startsWith("--")) {
        if (own) parsed.positionals.push(arg);
        else throw new Usage(`after --, give inputs as --name value, got "${arg}"`);
        continue;
      }
      const eq = arg.indexOf("=");
      const name = eq > 2 ? arg.slice(2, eq) : arg.slice(2);
      const inline = eq > 2 ? arg.slice(eq + 1) : undefined;
      const takeValue = () => {
        if (inline !== undefined) return inline;
        const next = list[i + 1];
        if (next === undefined || next.startsWith("--")) return true;
        i++;
        return next;
      };
      if (own && ownSwitches.has(name)) {
        parsed.flags[name] = true;
      } else if (own && name === "set") {
        const value = takeValue();
        if (value === true) throw new Usage("--set needs label.key=value");
        parsed.sets.push(value);
      } else if (own && ownFlags.has(name)) {
        const value = takeValue();
        if (value === true) throw new Usage(`--${name} needs a value`);
        parsed.flags[name] = value;
      } else {
        into[name] = takeValue();
      }
    }
  };
  readInputs(head, parsed.inputs, true);
  readInputs(tail, parsed.inputs, false);
  return parsed;
}

function parseValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** --set reviewer.model=haiku → { reviewer: { model: "haiku" } }. The label may hold dots; the key is after the last one. */
export function parseSets(sets: string[]): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const set of sets) {
    const eq = set.indexOf("=");
    const path = eq === -1 ? "" : set.slice(0, eq);
    const dot = path.lastIndexOf(".");
    if (eq === -1 || dot <= 0) throw new Usage(`--set needs label.key=value, got "${set}"`);
    const label = path.slice(0, dot);
    (out[label] ??= {})[path.slice(dot + 1)] = parseValue(set.slice(eq + 1));
  }
  return out;
}

function str(value: string | true | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function age(iso: string | undefined): string {
  if (!iso) return "";
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  if (seconds < 129600) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

function out(line = ""): void {
  process.stdout.write(`${line}\n`);
}

function printJson(value: unknown): void {
  out(JSON.stringify(value, null, 2));
}

function context(parsed: Parsed): { paths: HomePaths; projectDir: string } {
  const paths = ensureHome(homePaths());
  const project = str(parsed.flags.project);
  return { paths, projectDir: project ? resolve(project) : findProjectDir() };
}

function needRecord(paths: HomePaths, id: string | undefined): RunRecord {
  if (!id) throw new Usage("give a run id (orc list shows them)");
  const record = findRecord(paths, id);
  if (!record) throw new Error(`no run "${id}". orc list shows the runs.`);
  return record;
}

function stateOf(paths: HomePaths, record: RunRecord): PersistedRunState | undefined {
  const manager = managerFor(paths, record.projectDir);
  const state = manager.getPersistence().load(record.runId) ?? undefined;
  if (state && (state.status === "running" || state.status === "pending") && !processAlive(record.pid)) {
    return manager.reconcileExternallyDeadRun(record.runId) ?? state;
  }
  return state;
}

type Step = PersistedRunState["agents"][number];

/** The saved state lags a live run: it is saved when a step ends. The event log has every step
 *  that started or ended since, so show and the monitor see what runs now. */
function withLiveSteps(paths: HomePaths, record: RunRecord, state: PersistedRunState | undefined): PersistedRunState | undefined {
  if (!state || !processAlive(record.pid)) return state;
  const persistence = managerFor(paths, record.projectDir).getPersistence();
  const agents: Step[] = state.agents.map((agent) => ({ ...agent }));
  const key = (scope: unknown, callIndex: unknown) => `${typeof scope === "string" ? scope : record.runId}#${String(callIndex)}`;
  const byKey = new Map(agents.map((agent) => [key(agent.scope, agent.callIndex), agent]));
  try {
    let after = state.eventSeq ?? 0;
    for (;;) {
      const page = persistence.readEvents(record.runId, { after, limit: 1000 });
      for (const { event, timestamp } of page.events) {
        const e = event as unknown as Record<string, unknown>;
        const k = key(e.scope, e.callIndex);
        if (e.type === "agentStart" && !byKey.has(k)) {
          const step = {
            id: agents.length + 1,
            label: String(e.label ?? "agent"),
            status: "running",
            startedAt: timestamp,
            ...(typeof e.phase === "string" ? { phase: e.phase } : {}),
            ...(typeof e.model === "string" ? { model: e.model } : {}),
            ...(typeof e.callIndex === "number" ? { callIndex: e.callIndex } : {}),
            ...(typeof e.scope === "string" ? { scope: e.scope } : {}),
          } as Step;
          agents.push(step);
          byKey.set(k, step);
        } else if (e.type === "agentEnd") {
          const step = byKey.get(k);
          if (step && step.status === "running") {
            step.status = e.errorRecord ? "error" : "done";
            step.endedAt = timestamp;
            if (typeof e.tokens === "number") step.tokens = e.tokens;
            if (typeof e.error === "string") step.error = e.error;
          }
        }
      }
      if (!page.hasMore || page.events.length === 0) break;
      after = page.events[page.events.length - 1]!.seq;
    }
  } catch {
    return state;
  }
  return { ...state, agents };
}

/** The steps in the order they started. A nested workflow's steps go together under it, indented. */
function printSteps(record: RunRecord, agents: readonly Step[], ended: boolean): void {
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
      if (!own.startsWith(`${scope}-nested`)) continue;
      // The child of this scope that holds the step, which may itself hold deeper ones.
      const next = own.indexOf("-nested", scope.length + 1);
      const child = next === -1 ? own : own.slice(0, next);
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

/** One word for the list: what the run is doing, or what it waits for. */
function statusWord(paths: HomePaths, record: RunRecord, state: PersistedRunState | undefined): string {
  const alive = processAlive(record.pid);
  if (alive && listQuestions(paths, record.runId).length) return "asks";
  if (!state) return alive ? "starting" : "not started";
  if (state.status === "running" && !alive) return "interrupted";
  if (state.status === "paused") {
    const reason = state.pauseReason;
    if (reason === "usage_limit") return "paused: limit";
    if (reason === "step_failed") return "paused: failed step";
    if (reason === "step_stopped") return "paused: stopped step";
    if (reason === "time_limit") return "paused: time limit";
    if (reason === "checkpoint_required") return "paused: asks";
    if (reason === "requested") return "paused";
    if (reason === "interrupted") return "interrupted";
    return `paused: ${reason ?? "?"}`;
  }
  if (state.status === "aborted") return "stopped";
  return state.status;
}

const EXIT: Record<string, number> = { completed: 0, failed: 1, paused: 2, aborted: 3, asks: 4 };

function summary(paths: HomePaths, record: RunRecord): Record<string, unknown> {
  const state = stateOf(paths, record);
  const questions = listQuestions(paths, record.runId);
  return {
    runId: record.runId,
    workflow: record.workflow,
    status: state?.status ?? (processAlive(record.pid) ? "running" : "pending"),
    ...(state?.pauseReason ? { pauseReason: state.pauseReason } : {}),
    ...(state?.resetHint ? { resetHint: state.resetHint } : {}),
    ...(state?.reason && state.status !== "completed" ? { reason: state.reason } : {}),
    ...(questions.length ? { questions: questions.map((q) => ({ id: q.id, prompt: q.prompt, kind: q.kind, ...(q.choices ? { choices: q.choices } : {}), breakpoint: q.breakpoint })) } : {}),
    cwd: record.cwd,
    ...(record.branch ? { branch: record.branch } : {}),
    ...(state?.status === "completed" ? { result: state.result } : {}),
  };
}

function howToAnswer(question: Question): string {
  if (question.breakpoint) return `orc approve ${question.id}  |  orc send-back ${question.id} "note"  |  orc stop ${question.runId}`;
  if (question.kind === "confirm") return `orc answer ${question.id} yes|no`;
  if (question.kind === "select") return `orc answer ${question.id} <one of: ${(question.choices ?? []).join(", ")}>`;
  return `orc answer ${question.id} "..."`;
}

/** Print the log from `from`, and return where it ended. */
function printLogFrom(file: string, from: number, write: (text: string) => void): number {
  if (!existsSync(file)) return from;
  const size = statSync(file).size;
  if (size <= from) return from;
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(size - from);
    readSync(fd, buffer, 0, buffer.length, from);
    write(buffer.toString("utf8"));
  } finally {
    closeSync(fd);
  }
  return size;
}

/**
 * Wait for a run to end, pause or ask. In a terminal, a question is asked right here and the
 * wait goes on. Elsewhere, such as from an agent's shell, the wait returns at the question
 * with exit code 4, so the caller can answer with `orc answer` and wait again.
 */
async function waitFor(paths: HomePaths, runId: string, options: { json: boolean; quiet?: boolean }): Promise<number> {
  const file = logFile(paths, runId);
  let offset = options.json || options.quiet ? Number.MAX_SAFE_INTEGER : 0;
  const interactive = process.stdin.isTTY && process.stdout.isTTY && !options.json;
  const asked = new Set<string>();
  for (;;) {
    if (offset !== Number.MAX_SAFE_INTEGER) offset = printLogFrom(file, offset, (text) => process.stdout.write(text));
    const record = findRecord(paths, runId);
    if (!record) throw new Error(`run ${runId} is gone`);
    const alive = processAlive(record.pid);
    if (!alive) {
      await new Promise((r) => setTimeout(r, 150));
      if (offset !== Number.MAX_SAFE_INTEGER) printLogFrom(file, offset, (text) => process.stdout.write(text));
      const result = summary(paths, record);
      if (options.json) printJson(result);
      else if (result.status === "completed" && result.result !== undefined) {
        out("result:");
        out(typeof result.result === "string" ? result.result : JSON.stringify(result.result, null, 2));
      }
      return EXIT[String(result.status)] ?? 1;
    }
    const open = listQuestions(paths, runId).filter((q) => !asked.has(q.id));
    if (open.length) {
      if (!interactive) {
        if (options.json) printJson(summary(paths, record));
        else for (const q of open) out(`\nwaiting for an answer to ${q.id}:\n  ${q.prompt}\n  ${howToAnswer(q)}\n  then: orc wait ${runId}`);
        return EXIT.asks!;
      }
      for (const question of open) {
        asked.add(question.id);
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const hint = question.breakpoint
          ? "approve, stop, or a note to send back"
          : question.kind === "confirm"
            ? "yes or no"
            : question.kind === "select"
              ? (question.choices ?? []).join(" / ")
              : "your answer";
        const reply = (await rl.question(`\n${question.prompt}\n(${hint}) > `)).trim();
        rl.close();
        if (!readQuestion(paths, question.id)) continue;
        if (question.breakpoint && reply.toLowerCase() === "stop") {
          stopRun(paths, record);
          continue;
        }
        writeAnswer(paths, question, question.breakpoint ? breakpointValue(reply) : normalizeAnswer(question, reply));
      }
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

function breakpointValue(reply: string): unknown {
  const lower = reply.trim().toLowerCase();
  if (lower === "" || lower === "approve" || lower === "yes" || lower === "ok") return "approve";
  if (lower === "stop") return "stop";
  return { decision: "send back", note: reply.replace(/^send[ -]back\s*:?\s*/i, "").trim() };
}

function stopRun(paths: HomePaths, record: RunRecord): string {
  if (processAlive(record.pid)) {
    process.kill(record.pid!, "SIGTERM");
    return `stopping ${record.runId}`;
  }
  const result = managerFor(paths, record.projectDir).stopPersistedRun(record.runId);
  removeRunQuestions(paths, record.runId);
  if (result.outcome === "already-terminal") return `${record.runId} already ended (${result.state?.status ?? "done"})`;
  if (result.outcome === "missing") return `${record.runId} never started; nothing to stop`;
  if (result.outcome === "owned-elsewhere") return `${record.runId} is held by another process`;
  return `stopped ${record.runId}`;
}

function findQuestion(paths: HomePaths, id: string | undefined): Question {
  if (!id) throw new Usage("give a question id (orc inbox shows them)");
  const exact = readQuestion(paths, id);
  if (exact) return exact;
  const all = listQuestions(paths);
  const byPrefix = all.filter((q) => q.id.startsWith(id));
  if (byPrefix.length === 1) return byPrefix[0]!;
  const record = findRecord(paths, id);
  if (record) {
    const forRun = all.filter((q) => q.runId === record.runId);
    if (forRun.length === 1) return forRun[0]!;
    if (forRun.length > 1) throw new Error(`run ${record.runId} asks ${forRun.length} questions. Name one: ${forRun.map((q) => q.id).join(", ")}`);
    throw new Error(`run ${record.runId} asks nothing right now`);
  }
  throw new Error(`no open question "${id}". orc inbox lists them.`);
}

async function startAndMaybeWait(paths: HomePaths, record: RunRecord, mode: "start" | "resume", parsed: Parsed): Promise<number> {
  const pid = spawnWorker(paths, record.runId, mode);
  updateRecord(paths, record.runId, { pid });
  const json = parsed.flags.json === true;
  if (!parsed.flags.wait) {
    if (json) printJson({ runId: record.runId, workflow: record.workflow, cwd: record.cwd, log: logFile(paths, record.runId) });
    else {
      out(`${mode === "start" ? "started" : "resumed"} ${record.runId}  ${record.workflow}  in ${record.cwd}`);
      out(`  follow: orc wait ${record.runId}    log: orc log ${record.runId} -f`);
    }
    return 0;
  }
  return waitFor(paths, record.runId, { json });
}

// ── commands ──

async function cmdRun(parsed: Parsed): Promise<number> {
  const { paths, projectDir } = context(parsed);
  const workflow = parsed.positionals[0];
  if (!workflow) throw new Usage("orc run <workflow> [--name value ...]");
  if (parsed.positionals.length > 1) throw new Usage(`give inputs as --name value. Extra words: ${parsed.positionals.slice(1).join(" ")}`);
  const place = str(parsed.flags.place);
  if (place !== undefined && !isPlace(place)) throw new Usage(`--place is worktree, folder or none, got "${place}"`);
  const concurrency = str(parsed.flags.concurrency);
  const record = createRun(paths, {
    workflow,
    projectDir,
    inputs: parsed.inputs,
    ...(place ? { place: place as Place } : {}),
    ...(parsed.sets.length ? { overrides: parseSets(parsed.sets) } : {}),
    ...(str(parsed.flags.model) ? { defaultModel: str(parsed.flags.model)! } : {}),
    ...(concurrency ? { concurrency: Number(concurrency) } : {}),
    // An agent in a run starts workflows through this command too. Its shell carries the run's id.
    ...(process.env.ORC_RUN_ID ? { startedByRun: process.env.ORC_RUN_ID, origin: "agent" as const } : {}),
    // Claude Code marks the shells of its sessions. A run one starts uses its login.
    caller: process.env.CLAUDECODE === "1",
  });
  return startAndMaybeWait(paths, record, "start", parsed);
}

function cmdList(parsed: Parsed): number {
  const paths = ensureHome(homePaths());
  const records = listRecords(paths);
  const shown = parsed.flags.all ? records : records.slice(0, 20);
  const rows = shown.map((record) => {
    const state = stateOf(paths, record);
    return { record, state, status: statusWord(paths, record, state) };
  });
  if (parsed.flags.json) {
    printJson(rows.map(({ record, state, status }) => ({ runId: record.runId, workflow: record.workflow, status, state: state?.status, pauseReason: state?.pauseReason, createdAt: record.createdAt, place: record.place, cwd: record.cwd, origin: record.origin })));
    return 0;
  }
  if (!rows.length) {
    out("no runs yet. orc workflows lists what you can run.");
    return 0;
  }
  const width = Math.max(8, ...rows.map((row) => row.record.workflow.length));
  out(`${"RUN".padEnd(16)} ${"WORKFLOW".padEnd(width)} ${"STATUS".padEnd(20)} ${"AGE".padEnd(5)} WHERE`);
  for (const { record, status } of rows) {
    const where = record.place === "worktree" ? (record.branch ?? record.cwd) : record.place === "none" ? "scratch" : record.cwd;
    out(`${record.runId.padEnd(16)} ${record.workflow.padEnd(width)} ${status.padEnd(20)} ${age(record.createdAt).padEnd(5)} ${where}`);
  }
  if (records.length > shown.length) out(`(${records.length - shown.length} older runs: orc list --all)`);
  const asks = listQuestions(paths).length;
  if (asks) out(`\n${asks} question${asks === 1 ? "" : "s"} waiting: orc inbox`);
  return 0;
}

function cmdShow(parsed: Parsed): number {
  const paths = ensureHome(homePaths());
  const record = needRecord(paths, parsed.positionals[0]);
  const state = withLiveSteps(paths, record, stateOf(paths, record));
  const questions = listQuestions(paths, record.runId);
  if (parsed.flags.json) {
    printJson({ record, state: state ? { ...state, script: undefined, journal: undefined, nestedJournal: undefined, calls: undefined } : undefined, questions });
    return 0;
  }
  out(`${record.workflow}  ${record.runId}`);
  out(`status    ${statusWord(paths, record, state)}${state?.resetHint ? ` (${state.resetHint})` : ""}`);
  if (state?.reason && state.status !== "completed" && state.reason !== state.pauseReason) out(`reason    ${state.reason}`);
  out(`place     ${record.place}  ${record.cwd}${record.branch ? `  (branch ${record.branch})` : ""}`);
  out(`started   ${record.createdAt}  by ${record.origin}${record.schedule ? ` (${record.schedule})` : ""}${record.rerunOf ? `, rerun of ${record.rerunOf}` : ""}${record.reuseFrom ? `, reusing its unchanged steps` : ""}${record.startedByRun ? `, from run ${record.startedByRun}` : ""}`);
  if (Object.keys(record.args).length) out(`inputs    ${JSON.stringify(record.args)}`);
  if (record.overrides) out(`changes   ${JSON.stringify(record.overrides)}`);
  for (const [program, used] of Object.entries(record.programs ?? {})) {
    const name = isProgram(program) ? PROGRAM_INFO[program].name : program;
    out(`program   ${name} ${used.version ?? "(version unknown)"}  ${used.path}`);
  }
  for (const program of PROGRAMS) {
    if (record.accounts?.[program]) out(`account   ${PROGRAM_INFO[program].name}: ${describeAccount(program, record.accounts[program])}`);
  }
  if (record.limit && state?.status === "paused" && state.pauseReason === "usage_limit") out(`limit     ${limitNotice(paths, record, state.resetHint)}`);
  if (state?.tokenUsage) out(`tokens    ${state.tokenUsage.total}${state.durationMs ? `  in ${Math.round(state.durationMs / 1000)}s` : ""}`);
  if (state?.agents.length) {
    out("steps");
    printSteps(record, state.agents, state.status !== "running" && state.status !== "pending");
  }
  for (const question of questions) out(`asks      ${question.id}: ${question.prompt}\n          ${howToAnswer(question)}`);
  if (state?.status === "completed" && state.result !== undefined) {
    out("result");
    out(typeof state.result === "string" ? state.result : JSON.stringify(state.result, null, 2));
  }
  return 0;
}

async function cmdLog(parsed: Parsed): Promise<number> {
  const paths = ensureHome(homePaths());
  const record = needRecord(paths, parsed.positionals[0]);
  const file = logFile(paths, record.runId);
  let offset = printLogFrom(file, 0, (text) => process.stdout.write(text));
  if (!parsed.flags.follow) return 0;
  while (processAlive(findRecord(paths, record.runId)?.pid)) {
    await new Promise((r) => setTimeout(r, 400));
    offset = printLogFrom(file, offset, (text) => process.stdout.write(text));
  }
  printLogFrom(file, offset, (text) => process.stdout.write(text));
  return 0;
}

function cmdInbox(parsed: Parsed): number {
  const paths = ensureHome(homePaths());
  const record = parsed.positionals[0] ? needRecord(paths, parsed.positionals[0]) : undefined;
  const questions = listQuestions(paths, record?.runId);
  if (parsed.flags.json) {
    printJson(questions);
    return 0;
  }
  if (!questions.length) {
    out("nothing waits for you");
    return 0;
  }
  for (const question of questions) {
    out(`${question.id}  ${question.workflow}  ${age(question.askedAt)} ago`);
    out(`  ${question.prompt.replace(/\n/g, "\n  ")}`);
    out(`  ${howToAnswer(question)}`);
  }
  return 0;
}

function cmdAnswer(parsed: Parsed, kind: "answer" | "approve" | "send-back"): number {
  const paths = ensureHome(homePaths());
  const question = findQuestion(paths, parsed.positionals[0]);
  const text = parsed.positionals.slice(1).join(" ");
  let value: unknown;
  if (kind === "approve") {
    value = question.breakpoint ? "approve" : question.kind === "confirm" ? true : "approve";
  } else if (kind === "send-back") {
    if (!question.breakpoint) throw new Usage(`${question.id} is not a breakpoint. Use orc answer ${question.id} "..."`);
    if (!text) throw new Usage(`orc send-back ${question.id} "what to change"`);
    value = { decision: "send back", note: text };
  } else {
    if (!text && question.kind !== "confirm") throw new Usage(`orc answer ${question.id} "your answer"`);
    value = question.breakpoint ? breakpointValue(text) : parsed.flags.json ? parseValue(text) : normalizeAnswer(question, text);
    if (question.kind === "select" && question.choices && !question.choices.includes(value as string)) {
      throw new Usage(`answer one of: ${question.choices.join(", ")}`);
    }
  }
  writeAnswer(paths, question, value);
  const record = findRecord(paths, question.runId);
  const running = processAlive(record?.pid);
  out(`answered ${question.id}${running ? "" : `. The run is not running: orc resume ${question.runId} uses the answer.`}`);
  return 0;
}

function cmdStop(parsed: Parsed): number {
  const paths = ensureHome(homePaths());
  const record = needRecord(paths, parsed.positionals[0]);
  if (typeof parsed.flags.step === "string") return stopStep(paths, record, parsed.flags.step);
  out(stopRun(paths, record));
  return 0;
}

/** The steps the log shows as started and not yet ended, by the name the log gives them. */
export function runningSteps(logText: string): string[] {
  const running: string[] = [];
  for (const line of logText.split("\n")) {
    const match = /^\S+ (start|done|failed)\s+(.*)$/.exec(line);
    if (!match) continue;
    const rest = match[2]!;
    if (match[1] === "start") {
      running.push(rest.replace(/ \([^()]*\)$/, ""));
      continue;
    }
    const ended = running.findIndex((name) => rest === name || rest.startsWith(`${name}:`) || rest.startsWith(`${name},`));
    if (ended !== -1) running.splice(ended, 1);
  }
  return running;
}

/** Stop one running step. The run pauses on it, and resume runs it again. */
function stopStep(paths: HomePaths, record: RunRecord, step: string): number {
  if (!processAlive(record.pid)) {
    out(`${record.runId} is not running, so no step runs`);
    return 1;
  }
  const file = logFile(paths, record.runId);
  const running = runningSteps(existsSync(file) ? readFileSync(file, "utf8") : "");
  if (!running.includes(step)) {
    const now = running.length ? `Running now: ${running.map((name) => `"${name}"`).join(", ")}.` : "No step runs now.";
    throw new Error(`no step named "${step}" runs in ${record.runId}. ${now}`);
  }
  updateRecord(paths, record.runId, { stopSteps: [...(record.stopSteps ?? []), step] });
  process.kill(record.pid!, "SIGUSR2");
  out(`stopping "${step}" in ${record.runId}. The run pauses on it, and orc resume ${record.runId} runs it again.`);
  return 0;
}

function cmdPause(parsed: Parsed): number {
  const paths = ensureHome(homePaths());
  const record = needRecord(paths, parsed.positionals[0]);
  if (!processAlive(record.pid)) {
    out(`${record.runId} is not running`);
    return 1;
  }
  process.kill(record.pid!, "SIGUSR1");
  out(`pausing ${record.runId}: steps already running finish, nothing new starts. orc resume ${record.runId} goes on.`);
  return 0;
}

async function cmdResume(parsed: Parsed): Promise<number> {
  const paths = ensureHome(homePaths());
  const record = needRecord(paths, parsed.positionals[0]);
  if (processAlive(record.pid)) throw new Error(`${record.runId} is running already`);
  const state = stateOf(paths, record);
  if (!state) throw new Error(`${record.runId} never started. orc rerun ${record.runId} starts it fresh.`);
  if (state.status === "completed") throw new Error(`${record.runId} completed. orc rerun ${record.runId} runs it again.`);
  if (state.status === "aborted") throw new Error(`${record.runId} was stopped. orc rerun ${record.runId} starts it again.`);
  // An edit reaches a run only when the user says so at resume.
  const snapshot = loadSnapshot(paths, record.runId);
  const current = currentWorkflows(paths, record.projectDir);
  const used = new Set(Object.values(record.nested ?? {}).map((child) => child.workflow));
  const changed = [
    ...(existsSync(record.file) && readFileSync(record.file, "utf8") !== state.script ? [record.workflow] : []),
    ...[...used].filter((name) => name !== record.workflow && snapshot[name] !== undefined && current[name] !== snapshot[name]),
  ];
  if (parsed.flags.latest && parsed.flags.same) throw new Usage("--latest or --same, not both");
  if (changed.length && !parsed.flags.latest && !parsed.flags.same) {
    throw new Error(
      `${changed.join(", ")} changed since ${record.runId} started. ` +
        `orc resume ${record.runId} --latest takes the new version, and the finished steps that match stay done. ` +
        `orc resume ${record.runId} --same goes on with the version it started with.`,
    );
  }
  if (parsed.flags.latest) updateRecord(paths, record.runId, { resumeLatest: true });
  return startAndMaybeWait(paths, record, "resume", parsed);
}

async function cmdRerun(parsed: Parsed): Promise<number> {
  const paths = ensureHome(homePaths());
  const old = needRecord(paths, parsed.positionals[0]);
  const place = str(parsed.flags.place) ?? old.place;
  if (!isPlace(place)) throw new Usage(`--place is worktree, folder or none, got "${place}"`);
  const reuse = Boolean(parsed.flags.reuse);
  if (reuse) {
    const state = stateOf(paths, old);
    if (processAlive(old.pid) || state?.status === "running" || state?.status === "pending") throw new Error(`${old.runId} is still running. orc stop ${old.runId} first.`);
    if (state?.status === "paused") throw new Error(`${old.runId} is paused. orc resume ${old.runId} takes your edits and keeps the finished steps.`);
    if (parsed.flags.place) throw new Usage("--reuse works where the earlier run worked, so it takes no --place");
  }
  const record = createRun(paths, {
    ...(reuse ? { reuseFrom: old } : {}),
    workflow: old.file,
    projectDir: old.projectDir,
    inputs: { ...old.args, ...parsed.inputs },
    place,
    origin: "rerun",
    rerunOf: old.runId,
    ...(old.overrides || parsed.sets.length ? { overrides: { ...old.overrides, ...parseSets(parsed.sets) } } : {}),
    ...((str(parsed.flags.model) ?? old.defaultModel) ? { defaultModel: str(parsed.flags.model) ?? old.defaultModel! } : {}),
    ...(old.concurrency ? { concurrency: old.concurrency } : {}),
    ...(process.env.ORC_RUN_ID ? { startedByRun: process.env.ORC_RUN_ID } : {}),
    caller: process.env.CLAUDECODE === "1",
  });
  return startAndMaybeWait(paths, record, "start", parsed);
}

function cmdWorkflows(parsed: Parsed): number {
  const { paths, projectDir } = context(parsed);
  const entries = openWorkflowDir(workflowDirs(projectDir, paths)).list();
  if (parsed.flags.json) {
    printJson(entries.map((entry) => ({ name: entry.name, file: entry.file, ...(entry.error ? { error: entry.error } : { ...workflowExtras((entry.meta ?? {}) as unknown as Record<string, unknown>) }) })));
    return 0;
  }
  if (!entries.length) {
    out(`no saved workflows. Put them in ${workflowDirs(projectDir, paths).join(" or ")}.`);
    return 0;
  }
  for (const entry of entries) {
    if (entry.error) {
      out(`${entry.name}  (does not parse: ${entry.error})`);
      continue;
    }
    const extras = workflowExtras((entry.meta ?? {}) as unknown as Record<string, unknown>);
    out(`${entry.name}${extras.description ? `  ${extras.description}` : ""}`);
    for (const [name, spec] of Object.entries(extras.inputs)) {
      const bits = [spec.type ?? "string", spec.required === false || spec.default !== undefined ? "optional" : "required"];
      if (spec.default !== undefined) bits.push(`default ${JSON.stringify(spec.default)}`);
      out(`  --${name}  ${bits.join(", ")}${spec.description ? `  ${spec.description}` : ""}`);
    }
  }
  return 0;
}

async function cmdCheck(parsed: Parsed): Promise<number> {
  const { paths, projectDir } = context(parsed);
  const name = parsed.positionals[0];
  if (!name) throw new Usage("orc check <workflow> [--name value ...] [--dry-run [--answers file.json]]");
  const inputs = Object.keys(parsed.inputs).length ? parsed.inputs : undefined;
  const result = checkWorkflow(paths, projectDir, name, inputs);
  // The service reads this project's workflow files for a schedule from now on.
  rememberProject(paths, projectDir);
  const json = parsed.flags.json === true;
  const wantsDryRun = parsed.flags["dry-run"] === true;
  if (!json) {
    out(`${result.workflow}  ${result.file}`);
    for (const problem of result.problems) out(`  problem: ${problem}`);
    for (const note of result.notes) out(`  note: ${note}`);
    out(result.problems.length ? `${result.problems.length} problem${result.problems.length === 1 ? "" : "s"}` : "ok");
  }
  if (result.problems.length || !wantsDryRun) {
    if (json) printJson(result);
    return result.problems.length ? 1 : 0;
  }
  const answersFile = str(parsed.flags.answers);
  const answers = answersFile ? readAnswers(resolve(answersFile)) : undefined;
  if (!json) out("dry run with stand-in agents. Code steps run for real, never in the project folder, and what they make is deleted after.");
  const dry = await dryRun(paths, { workflow: name, projectDir, inputs: parsed.inputs, ...(answers ? { answers } : {}), ...(json ? {} : { log: (line: string) => out(`  ${line}`) }) });
  if (json) {
    printJson({ ...result, dryRun: dry });
  } else if (dry.status === "completed") {
    out(`dry run completed, with ${dry.agents.length} agent step${dry.agents.length === 1 ? "" : "s"} answered by stand-ins`);
    if (dry.result !== undefined) out(JSON.stringify(dry.result, null, 2));
  } else {
    out(`the dry run did not complete: ${dry.status}${dry.reason ? ` (${dry.reason.replace(/\s+/g, " ")})` : ""}`);
  }
  return dry.status === "completed" ? 0 : 1;
}

function cmdSchedule(parsed: Parsed): number {
  const { paths, projectDir } = context(parsed);
  const [action, name, workflow] = parsed.positionals;
  const schedules = loadSchedules(paths);
  if (action === "list" || action === undefined || action === "test") rememberProject(paths, projectDir);
  const inFiles = fileSchedules(paths);
  const tilde = (path: string) => (process.env.HOME && path.startsWith(process.env.HOME) ? `~${path.slice(process.env.HOME.length)}` : path);
  const find = (all = false) => {
    const found = schedules.find((schedule) => schedule.name === name) ?? (all ? inFiles.find((schedule) => schedule.name === resolve(name ?? "")) : undefined);
    if (found) return found;
    const fromFile = inFiles.find((schedule) => schedule.name === resolve(name ?? ""));
    if (fromFile) throw new Error(`the schedule of ${tilde(fromFile.workflow)} is set in its meta. Change or remove meta.schedule there.`);
    throw new Error(`no schedule "${name}". orc schedule list shows them.`);
  };
  switch (action) {
    case "add": {
      const cron = str(parsed.flags.cron);
      if (!name || !workflow || !cron) throw new Usage('orc schedule add <name> <workflow> --cron "0 9 * * 1-5" [--name value ...]');
      if (schedules.some((schedule) => schedule.name === name)) throw new Error(`a schedule "${name}" exists. Remove it first.`);
      parseCron(cron);
      const resolved = resolveWorkflow(paths, projectDir, workflow);
      const place = str(parsed.flags.place);
      if (place !== undefined && !isPlace(place)) throw new Usage(`--place is worktree, folder or none, got "${place}"`);
      const schedule: Schedule = {
        name,
        workflow: resolved.file,
        projectDir,
        cron,
        inputs: parsed.inputs,
        ...(place ? { place: place as Place } : {}),
        enabled: true,
        createdAt: new Date().toISOString(),
      };
      saveSchedules(paths, [...schedules, schedule]);
      const next = nextRun(parseCron(cron));
      out(`schedule ${name}: ${resolved.name} at "${cron}"${next ? `, next ${next.toLocaleString()}` : ""}`);
      if (resolved.extras.schedule) out(`note: ${resolved.name} also sets "${resolved.extras.schedule.cron}" in its meta, and both start it`);
      if (!daemonPid(paths)) out("the service is not running, so nothing will start: orc daemon start");
      return 0;
    }
    case "list":
    case undefined: {
      const all = [...schedules, ...inFiles];
      if (parsed.flags.json) {
        printJson(all);
        return 0;
      }
      if (!all.length) {
        out("no schedules");
        return 0;
      }
      for (const schedule of all) {
        const next = schedule.enabled ? nextRun(parseCron(schedule.cron)) : undefined;
        const when = schedule.enabled ? (next ? `next ${next.toLocaleString()}` : "") : "disabled";
        if (schedule.fromFile) out(`${tilde(schedule.workflow)}  ${schedule.cron}  set in the file  ${when}`);
        else out(`${schedule.name}  ${schedule.cron}  ${tilde(schedule.workflow)}  ${when}`);
      }
      if (!daemonPid(paths)) out("\nthe service is not running: orc daemon start");
      return 0;
    }
    case "remove":
      find();
      saveSchedules(paths, schedules.filter((schedule) => schedule.name !== name));
      out(`removed ${name}`);
      return 0;
    case "enable":
    case "disable":
      find().enabled = action === "enable";
      saveSchedules(paths, schedules);
      out(`${action}d ${name}`);
      return 0;
    case "test": {
      const schedule = find(true);
      const cron = parseCron(schedule.cron);
      const at = new Date();
      out(`${tilde(schedule.name)} ${cronMatches(cron, at) ? "matches" : "does not match"} now; next ${nextRun(cron)?.toLocaleString() ?? "never"}`);
      return 0;
    }
    default:
      throw new Usage("orc schedule add|list|remove|enable|disable|test");
  }
}

async function cmdDaemon(parsed: Parsed): Promise<number> {
  const paths = ensureHome(homePaths());
  const action = parsed.positionals[0] ?? "status";
  const pid = daemonPid(paths);
  const log = `${paths.logs}/daemon.log`;
  switch (action) {
    case "run":
      await daemonMain(paths);
      return 0;
    case "start": {
      if (pid) {
        out(`the service runs already (pid ${pid})`);
        return 0;
      }
      const fd = openSync(log, "a");
      const child = spawn(process.execPath, [process.argv[1]!, "daemon", "run"], { detached: true, stdio: ["ignore", fd, fd], env: process.env });
      child.unref();
      closeSync(fd);
      out(`the service started (pid ${child.pid}). Log: ${log}`);
      return 0;
    }
    case "stop":
      if (!pid) {
        out("the service is not running");
        return 0;
      }
      process.kill(pid, "SIGTERM");
      out(`stopping the service (pid ${pid})`);
      return 0;
    case "status":
      out(pid ? `the service runs (pid ${pid}). Log: ${log}` : "the service is not running: orc daemon start");
      return pid ? 0 : 1;
    default:
      throw new Usage("orc daemon start|stop|status|run");
  }
}

function cmdGc(parsed: Parsed): number {
  const paths = ensureHome(homePaths());
  const records = listRecords(paths);
  const projects = [...new Set(records.map((record) => record.projectDir))];
  const result = gcWorktrees(paths, projects, { dryRun: parsed.flags["dry-run"] === true, unfinished: unfinishedRuns(paths, records) });
  for (const item of result.removed) out(`${parsed.flags["dry-run"] ? "would remove" : "removed"} ${item.dir} (${item.branch}): ${item.reason}`);
  for (const item of result.kept) out(`kept ${item.dir} (${item.branch}): ${item.reason}`);
  if (!result.removed.length && !result.kept.length) out("no worktrees");
  return 0;
}

function cmdDiscard(parsed: Parsed): number {
  const paths = ensureHome(homePaths());
  const record = needRecord(paths, parsed.positionals[0]);
  if (processAlive(record.pid)) throw new Error(`${record.runId} is running. orc stop ${record.runId} first.`);
  const trees = runWorktrees(paths, record.runId);
  if (!trees.length) {
    out(`${record.runId} has no worktree left`);
    return 0;
  }
  if (parsed.flags.yes !== true) {
    for (const tree of trees) out(`would delete ${tree.branch} and ${tree.dir}`);
    out(`the work on these branches is lost. orc discard ${record.runId} --yes deletes them.`);
    return 1;
  }
  for (const tree of trees) {
    removeWorktree(record.projectDir, tree.dir, tree.branch);
    out(`deleted ${tree.branch} and ${tree.dir}`);
  }
  return 0;
}

function cmdPrune(parsed: Parsed): number {
  const paths = ensureHome(homePaths());
  const days = Number(str(parsed.flags.days) ?? loadConfig(paths).keepDays);
  if (!Number.isFinite(days) || days < 0) throw new Usage("orc prune --days N (or set keepDays in config.json)");
  const removed = prune(paths, days);
  out(removed.length ? `removed ${removed.length} finished runs older than ${days} days` : "nothing to remove");
  return 0;
}

const HELP = `orc runs saved workflows in the background.

  orc run <workflow> [--name value ...] [-- --name value ...]
        --place worktree|folder|none   where the run works (default: the workflow's, else config)
        --model <spec>                 model for steps that name none, such as claude/haiku
        --set <step>.<key>=<value>     change one step for this run, such as --set reviewer.model=claude/opus
        --concurrency N                steps at once in this run
        --wait                         follow the run until it ends; in a terminal, answer here
        --json                         machine-readable output
  orc wait <run> [--json]              wait for a run to end, pause or ask (exit 0 done, 1 failed,
                                       2 paused, 3 stopped, 4 waits for an answer)
  orc list [--all]                     runs, newest first
  orc show <run>                       one run: status, steps, questions, result
  orc log <run> [-f]                   the run's log
  orc inbox [run]                      questions waiting for you
  orc answer <question> <text>         answer a question (a run id works when it asks one thing)
  orc approve <question>               approve a breakpoint
  orc send-back <question> <note>      send a breakpoint's step back with a note
  orc pause <run>                      finish running steps, start nothing new
  orc resume <run> [--wait]            go on from where the run paused, failed or was cut off
        --latest | --same              after an edit: take the new version, or keep the run's own
  orc stop <run>                       end the run; its worktree stays
        --step <name>                  stop one running step instead; the run pauses on it
  orc rerun <run> [--name value ...]   start the same workflow again with the same inputs
        --reuse                      keep the results of the steps you did not edit, in the same place
  orc workflows                        saved workflows and their inputs
  orc check <workflow> [--name value]  check a workflow without running it
        --dry-run                      then run it once with stand-in agents; code steps run, in a copy
        --answers <file.json>          what the stand-ins answer, by step label: {"reviewer *": {...}}
  orc schedule add <name> <workflow> --cron "<min hour day month weekday>" [--name value ...]
  orc schedule list|remove|enable|disable|test <name>
                                       schedule: "0 9 * * 1-5" in a workflow's meta also schedules it
  orc daemon start|stop|status         the service that starts schedules and resumes runs after the limit
  orc gc [--dry-run]                   remove worktrees whose branch is merged
  orc discard <run> [--yes]            delete the run's branches and worktrees, merged or not
  orc prune --days N                   remove finished runs older than N days
  orc account                          the accounts orc's steps can use, and the one they use now
  orc account add <name>               add a Claude Code login: runs claude setup-token, then asks
                                       for the token it prints (or reads it from stdin)
  orc account use <name>               use it for new runs, and move the runs waiting at the usage
                                       limit to it; default is Claude Code's own login
  orc account remove <name>            forget a login
  orc doctor [--live]                  the installed Claude Code and Codex the steps run on, and
                                       whether orc talks to them; --live runs one tiny step on each
        --model <spec>                 with --live, check this model only, such as codex/gpt-6.1-sol

Home: ${homePaths().home} (set ORC_HOME to change). A project's .orchestrator/ folder holds its
workflows, and wins over the home folder's. Agents and MCP servers come from the project's
.rulesync/, then the global rulesync folder (rulesyncGlobal in config.json), then the harnesses'
own folders, such as .claude/agents/ and .codex/agents/. Steps run on the Claude Code and Codex
installed on this machine, on the account orc account names. A run that a Claude Code session or
an agent starts uses that session's account.`;

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === "_worker") return await workerMain(rest[0]!, rest[1] === "resume" ? "resume" : "start");
    const parsed = parseArgs(rest);
    if (!command || command === "help" || command === "--help" || command === "-h" || parsed.flags.help || parsed.flags.h) {
      out(HELP);
      return 0;
    }
    switch (command) {
      case "run":
        return await cmdRun(parsed);
      case "wait": {
        const paths = ensureHome(homePaths());
        return await waitFor(paths, needRecord(paths, parsed.positionals[0]).runId, { json: parsed.flags.json === true });
      }
      case "list":
      case "ls":
        return cmdList(parsed);
      case "show":
        return cmdShow(parsed);
      case "log":
      case "logs":
        return await cmdLog(parsed);
      case "inbox":
      case "questions":
        return cmdInbox(parsed);
      case "answer":
        return cmdAnswer(parsed, "answer");
      case "approve":
        return cmdAnswer(parsed, "approve");
      case "send-back":
        return cmdAnswer(parsed, "send-back");
      case "stop":
        return cmdStop(parsed);
      case "pause":
        return cmdPause(parsed);
      case "resume":
        return await cmdResume(parsed);
      case "rerun":
        return await cmdRerun(parsed);
      case "workflows":
        return cmdWorkflows(parsed);
      case "check":
        return await cmdCheck(parsed);
      case "schedule":
      case "schedules":
        return cmdSchedule(parsed);
      case "daemon":
        return await cmdDaemon(parsed);
      case "gc":
        return cmdGc(parsed);
      case "prune":
        return cmdPrune(parsed);
      case "discard":
        return cmdDiscard(parsed);
      case "account":
      case "accounts":
        return await cmdAccount(parsed.positionals, { json: parsed.flags.json === true, usage: (message) => new Usage(message) });
      case "doctor":
        return await doctor({ live: parsed.flags.live === true, model: str(parsed.flags.model), json: parsed.flags.json === true });
      default:
        throw new Usage(`unknown command "${command}". orc help lists them.`);
    }
  } catch (error) {
    if (error instanceof Usage) process.stderr.write(`usage: ${error.message}\n`);
    else if (error instanceof InputProblems) process.stderr.write(`${error.message}\n`);
    else process.stderr.write(`orc: ${(error as Error).message}\n`);
    return error instanceof Usage ? 64 : 1;
  }
}

const invokedDirectly = (() => {
  try {
    const self = new URL(import.meta.url).pathname;
    const argv1 = process.argv[1] ? resolve(process.argv[1]) : "";
    return argv1 === self || argv1.replace(/\.ts$/, ".js") === self.replace(/\.ts$/, ".js") || /[\\/]orc$/.test(argv1);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (process.argv[2] !== "daemon" || process.argv[3] !== "run") process.exitCode = code;
      if (process.argv[2] === "_worker") setTimeout(() => process.exit(code), 200).unref();
    },
    (error) => {
      process.stderr.write(`orc: ${(error as Error).stack ?? String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
