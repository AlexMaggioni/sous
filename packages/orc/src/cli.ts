#!/usr/bin/env node
// orc: run saved workflows in the background, answer what they ask, pause, resume and
// schedule them. `orc help` lists the commands.

import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { answerQuestion, answerValue, breakpointValue, busyWorktrees, checkWorkflow, cronMatches, daemonLog, daemonMain, daemonPid, describeAccount, discardRun, dryRun, ensureHome, fileSchedules, findProjectDir, findQuestion, gcWorktrees, HARNESSES, harnessName, homePaths, InputProblems, isHarness, isPlace, limitNotice, listRecords, listRuns, loadConfig, loadSchedules, logFile, nextRun, normalizeAnswer, openWorkflowDir, parseCron, pauseRun, pruneRuns, readLog, readQuestion, readRun, rememberProject, rerunRun, resolveWorkflow, resumeRun, runDetail, runQuestions, saveSchedules, scopePath, startRun, stopRun, stopStep, waitForRun, workerMain, workflowDirs, type AnswerKind, type Answers, type HomePaths, type Place, type RunDetail, type RunQuestion, type RunRecord, type RunView, type Schedule } from "@orchestrator/engine";
import { cmdAccount } from "./account-cli.js";
import { doctor } from "./doctor.js";

class Usage extends Error {}

/** The built command-line file, which also runs the worker. */
export function cliFile(): string {
  const here = fileURLToPath(new URL(".", import.meta.url));
  for (const candidate of [join(here, "cli.js"), join(here, "..", "dist", "cli.js")]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("orc is not built. Run pnpm build in the orchestrator repo.");
}

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

/** The run id the command names. */
function runIdArg(id: string | undefined): string {
  if (!id) throw new Usage("give a run id (orc list shows them)");
  return id;
}

function needRun(paths: HomePaths, id: string | undefined): RunView {
  return readRun(paths, runIdArg(id));
}

type Step = RunDetail["steps"][number];

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

function howToAnswer(question: RunQuestion): string {
  if (question.breakpoint) return `orc approve ${question.id}  |  orc send-back ${question.id} "note"  |  orc stop ${question.runId}`;
  if (question.kind === "confirm") return `orc answer ${question.id} yes|no`;
  if (question.kind === "select") return `orc answer ${question.id} <one of: ${(question.choices ?? []).join(", ")}>`;
  return `orc answer ${question.id} "..."`;
}

/**
 * Wait for a run to end, pause or ask. In a terminal, a question is asked right here and the
 * wait goes on. Elsewhere, such as from an agent's shell, the wait returns at the question
 * with exit code 4, so the caller can answer with `orc answer` and wait again.
 */
async function waitFor(paths: HomePaths, runId: string, options: { json: boolean; quiet?: boolean }): Promise<number> {
  const interactive = process.stdin.isTTY && process.stdout.isTTY && !options.json;
  const end = await waitForRun(paths, runId, {
    ...(options.json || options.quiet ? {} : { log: (text: string) => process.stdout.write(text) }),
    ...(interactive ? { asks: (questions: RunQuestion[], record: RunRecord) => askHere(paths, questions, record) } : {}),
  });
  if (end.questions) {
    if (options.json) printJson(end.summary);
    else for (const q of end.questions) out(`\nwaiting for an answer to ${q.id}:\n  ${q.prompt}\n  ${howToAnswer(q)}\n  then: orc wait ${runId}`);
    return end.code;
  }
  if (options.json) printJson(end.summary);
  else if (end.summary.status === "completed" && end.summary.result !== undefined) {
    out("result:");
    out(typeof end.summary.result === "string" ? end.summary.result : JSON.stringify(end.summary.result, null, 2));
  }
  return end.code;
}

/** Ask each question in the terminal and write the answer. "stop" at a breakpoint stops the run. */
async function askHere(paths: HomePaths, questions: RunQuestion[], record: RunRecord): Promise<void> {
  for (const question of questions) {
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
      stopRun(paths, record.runId);
      continue;
    }
    answerQuestion(paths, question, question.breakpoint ? breakpointValue(reply) : normalizeAnswer(question, reply));
  }
}

/** What `orc stop` prints. */
function stopText(record: RunRecord, stop: ReturnType<typeof stopRun>): string {
  if (stop.outcome === "stopping") return `stopping ${record.runId}`;
  if (stop.outcome === "already-ended") return `${record.runId} already ended (${stop.status ?? "done"})`;
  if (stop.outcome === "never-started") return `${record.runId} never started; nothing to stop`;
  if (stop.outcome === "held-elsewhere") return `${record.runId} is held by another process`;
  return `stopped ${record.runId}`;
}

function needQuestion(paths: HomePaths, id: string | undefined): RunQuestion {
  if (!id) throw new Usage("give a question id (orc inbox shows them)");
  return findQuestion(paths, id);
}

/** Say the run started, or wait for it with --wait. */
async function startedOrWait(paths: HomePaths, record: RunRecord, mode: "start" | "resume", parsed: Parsed): Promise<number> {
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
  const record = startRun(paths, cliFile(), {
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
  return startedOrWait(paths, record, "start", parsed);
}

function cmdList(parsed: Parsed): number {
  const paths = ensureHome(homePaths());
  const runs = listRuns(paths, parsed.flags.all ? {} : { limit: 20 });
  if (parsed.flags.json) {
    printJson(runs.map(({ record, word, saved }) => ({ runId: record.runId, workflow: record.workflow, status: word, state: saved?.status, pauseReason: saved?.pauseReason, createdAt: record.createdAt, place: record.place, cwd: record.cwd, origin: record.origin })));
    return 0;
  }
  if (!runs.length) {
    out("no runs yet. orc workflows lists what you can run.");
    return 0;
  }
  const width = Math.max(8, ...runs.map((run) => run.record.workflow.length));
  out(`${"RUN".padEnd(16)} ${"WORKFLOW".padEnd(width)} ${"STATUS".padEnd(20)} ${"AGE".padEnd(5)} WHERE`);
  for (const { record, word } of runs) {
    const where = record.place === "worktree" ? (record.branch ?? record.cwd) : record.place === "none" ? "scratch" : record.cwd;
    out(`${record.runId.padEnd(16)} ${record.workflow.padEnd(width)} ${word.padEnd(20)} ${age(record.createdAt).padEnd(5)} ${where}`);
  }
  // Only the shown runs' states are read, so the count reads the records alone.
  const older = parsed.flags.all ? 0 : listRecords(paths).length - runs.length;
  if (older > 0) out(`(${older} older runs: orc list --all)`);
  const asks = runQuestions(paths).length;
  if (asks) out(`\n${asks} question${asks === 1 ? "" : "s"} waiting: orc inbox`);
  return 0;
}

function cmdShow(parsed: Parsed): number {
  const paths = ensureHome(homePaths());
  const run = runDetail(paths, runIdArg(parsed.positionals[0]));
  const { record, saved } = run;
  if (parsed.flags.json) {
    printJson({ record, state: run.engineState, questions: run.questions });
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
    printSteps(record, run.steps, saved?.status !== "running" && saved?.status !== "pending");
  }
  for (const question of run.questions) out(`asks      ${question.id}: ${question.prompt}\n          ${howToAnswer(question)}`);
  if (run.result !== undefined) {
    out("result");
    out(typeof run.result === "string" ? run.result : JSON.stringify(run.result, null, 2));
  }
  return 0;
}

async function cmdLog(parsed: Parsed): Promise<number> {
  const paths = ensureHome(homePaths());
  let read = readLog(paths, runIdArg(parsed.positionals[0]));
  if (read.text) process.stdout.write(read.text);
  if (!parsed.flags.follow) return 0;
  while (read.running) {
    await new Promise((r) => setTimeout(r, 400));
    read = readLog(paths, read.runId, read.end);
    if (read.text) process.stdout.write(read.text);
  }
  return 0;
}

function cmdInbox(parsed: Parsed): number {
  const paths = ensureHome(homePaths());
  const questions = parsed.positionals[0] ? needRun(paths, parsed.positionals[0]).questions : runQuestions(paths);
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

function cmdAnswer(parsed: Parsed, kind: AnswerKind): number {
  const paths = ensureHome(homePaths());
  const question = needQuestion(paths, parsed.positionals[0]);
  const text = parsed.positionals.slice(1).join(" ");
  const answer = answerValue(question, kind, text, parsed.flags.json === true);
  if ("usage" in answer) throw new Usage(answer.usage);
  const running = answerQuestion(paths, question, answer.value);
  out(`answered ${question.id}${running ? "" : `. The run is not running: orc resume ${question.runId} uses the answer.`}`);
  return 0;
}

function cmdStop(parsed: Parsed): number {
  const paths = ensureHome(homePaths());
  const { record } = needRun(paths, parsed.positionals[0]);
  if (typeof parsed.flags.step === "string") {
    const step = parsed.flags.step;
    if (!stopStep(paths, record.runId, step)) {
      out(`${record.runId} is not running, so no step runs`);
      return 1;
    }
    out(`stopping "${step}" in ${record.runId}. The run pauses on it, and orc resume ${record.runId} runs it again.`);
    return 0;
  }
  out(stopText(record, stopRun(paths, record.runId)));
  return 0;
}

function cmdPause(parsed: Parsed): number {
  const paths = ensureHome(homePaths());
  const { record } = needRun(paths, parsed.positionals[0]);
  if (!pauseRun(paths, record.runId)) {
    out(`${record.runId} is not running`);
    return 1;
  }
  out(`pausing ${record.runId}: steps already running finish, nothing new starts. orc resume ${record.runId} goes on.`);
  return 0;
}

async function cmdResume(parsed: Parsed): Promise<number> {
  const paths = ensureHome(homePaths());
  const run = needRun(paths, parsed.positionals[0]);
  // A run that cannot resume says so before this usage error. resumeRun refuses it.
  if (parsed.flags.latest && parsed.flags.same && run.resume.ok) throw new Usage("--latest or --same, not both");
  const record = resumeRun(paths, cliFile(), run.runId, parsed.flags.latest ? "latest" : parsed.flags.same ? "same" : undefined);
  return startedOrWait(paths, record, "resume", parsed);
}

async function cmdRerun(parsed: Parsed): Promise<number> {
  const paths = ensureHome(homePaths());
  const run = needRun(paths, parsed.positionals[0]);
  const place = str(parsed.flags.place) ?? run.record.place;
  if (!isPlace(place)) throw new Usage(`--place is worktree, folder or none, got "${place}"`);
  const reuse = Boolean(parsed.flags.reuse);
  // A run that cannot be reused says so before this usage error. rerunRun refuses it.
  if (reuse && parsed.flags.place && run.reuse.ok) throw new Usage("--reuse works where the earlier run worked, so it takes no --place");
  const record = rerunRun(paths, cliFile(), run.runId, {
    place,
    reuse,
    inputs: parsed.inputs,
    ...(parsed.sets.length ? { overrides: parseSets(parsed.sets) } : {}),
    ...(str(parsed.flags.model) !== undefined ? { defaultModel: str(parsed.flags.model)! } : {}),
    ...(process.env.ORC_RUN_ID ? { startedByRun: process.env.ORC_RUN_ID } : {}),
    caller: process.env.CLAUDECODE === "1",
  });
  return startedOrWait(paths, record, "start", parsed);
}

function cmdWorkflows(parsed: Parsed): number {
  const { paths, projectDir } = context(parsed);
  const entries = openWorkflowDir(workflowDirs(projectDir, paths)).list();
  if (parsed.flags.json) {
    printJson(entries.map((entry) => ({ name: entry.name, file: entry.file, ...(entry.error ? { error: entry.error } : { ...entry.extras }) })));
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
    const extras = entry.extras!;
    out(`${entry.name}${extras.description ? `  ${extras.description}` : ""}`);
    for (const [name, spec] of Object.entries(extras.inputs)) {
      const bits = [spec.type ?? "string", spec.required === false || spec.default !== undefined ? "optional" : "required"];
      if (spec.default !== undefined) bits.push(`default ${JSON.stringify(spec.default)}`);
      out(`  --${name}  ${bits.join(", ")}${spec.description ? `  ${spec.description}` : ""}`);
    }
  }
  return 0;
}

function readAnswers(file: string): Answers {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file} must hold an object from step label to answer, such as {"reviewer *": {"approved": false, "review": "Add a test"}}`);
  }
  return parsed as Answers;
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
  const log = daemonLog(paths);
  switch (action) {
    case "run":
      await daemonMain(paths, cliFile());
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
  const runs = listRuns(paths);
  const projects = [...new Set(runs.map((run) => run.record.projectDir))];
  const result = gcWorktrees(paths, projects, { dryRun: parsed.flags["dry-run"] === true, busy: busyWorktrees(paths, runs) });
  for (const item of result.removed) out(`${parsed.flags["dry-run"] ? "would remove" : "removed"} ${item.dir} (${item.branch}): ${item.reason}`);
  for (const item of result.kept) out(`kept ${item.dir} (${item.branch}): ${item.reason}`);
  if (!result.removed.length && !result.kept.length) out("no worktrees");
  return 0;
}

function cmdDiscard(parsed: Parsed): number {
  const paths = ensureHome(homePaths());
  const { record } = needRun(paths, parsed.positionals[0]);
  const yes = parsed.flags.yes === true;
  const trees = discardRun(paths, record.runId, { remove: yes, deleted: (tree) => out(`deleted ${tree.branch} and ${tree.dir}`) });
  if (!trees.length) {
    out(`${record.runId} has no worktree left`);
    return 0;
  }
  if (!yes) {
    for (const tree of trees) out(`would delete ${tree.branch} and ${tree.dir}`);
    out(`the work on these branches is lost. orc discard ${record.runId} --yes deletes them.`);
    return 1;
  }
  return 0;
}

function cmdPrune(parsed: Parsed): number {
  const paths = ensureHome(homePaths());
  const days = Number(str(parsed.flags.days) ?? loadConfig(paths).keepDays);
  if (!Number.isFinite(days) || days < 0) throw new Usage("orc prune --days N (or set keepDays in config.json)");
  const removed = pruneRuns(paths, days);
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

/** Each command by its name, and the other names it answers to. */
const COMMANDS: Record<string, (parsed: Parsed) => number | Promise<number>> = {
  run: cmdRun,
  wait: (parsed) => {
    const paths = ensureHome(homePaths());
    return waitFor(paths, needRun(paths, parsed.positionals[0]).runId, { json: parsed.flags.json === true });
  },
  list: cmdList,
  ls: cmdList,
  show: cmdShow,
  log: cmdLog,
  logs: cmdLog,
  inbox: cmdInbox,
  questions: cmdInbox,
  answer: (parsed) => cmdAnswer(parsed, "answer"),
  approve: (parsed) => cmdAnswer(parsed, "approve"),
  "send-back": (parsed) => cmdAnswer(parsed, "send-back"),
  stop: cmdStop,
  pause: cmdPause,
  resume: cmdResume,
  rerun: cmdRerun,
  workflows: cmdWorkflows,
  check: cmdCheck,
  schedule: cmdSchedule,
  schedules: cmdSchedule,
  daemon: cmdDaemon,
  gc: cmdGc,
  prune: cmdPrune,
  discard: cmdDiscard,
  account: (parsed) => cmdAccount(parsed.positionals, { json: parsed.flags.json === true, usage: (message) => new Usage(message), cliFile }),
  accounts: (parsed) => cmdAccount(parsed.positionals, { json: parsed.flags.json === true, usage: (message) => new Usage(message), cliFile }),
  doctor: (parsed) => doctor({ live: parsed.flags.live === true, model: str(parsed.flags.model), json: parsed.flags.json === true }),
};

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === "_worker") return await workerMain(rest[0]!, rest[1] === "resume" ? "resume" : "start");
    const parsed = parseArgs(rest);
    if (!command || command === "help" || command === "--help" || command === "-h" || parsed.flags.help || parsed.flags.h) {
      out(HELP);
      return 0;
    }
    const run = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
    if (!run) throw new Usage(`unknown command "${command}". orc help lists them.`);
    return await run(parsed);
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
