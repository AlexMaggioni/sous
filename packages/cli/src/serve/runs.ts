// The runs as the page reads them: a row per run, one run's page with its steps and graphs, one
// step call whole, and the open questions. Each maps an engine read to the contract's shape and
// its status words. Nothing here writes.

import { basename } from "node:path";
import {
  innerFlows,
  isAgentCall,
  listRuns,
  loadRecord,
  questionView,
  readRun,
  runActions,
  runDetail,
  runQuestions,
  runTexts,
  scopePrefix,
  stepView,
  workerRuns,
  workflowFlow,
  type HomePaths,
  type RunDetail,
  type RunQuestion,
  type RunRecord,
  type RunView,
} from "@sous-run/engine";
import type { Activity, Flow, Harness, NestedRun, Project, Question, RunPage, RunRow, Status, Step, StepDetail } from "@sous-run/view";

/** The contract's status for each of the pause rule's. */
const STATUS: Record<RunView["status"], Status> = {
  "not started": "queued",
  starting: "queued",
  pending: "queued",
  running: "running",
  asks: "needs",
  paused: "paused",
  interrupted: "paused",
  completed: "done",
  failed: "failed",
  stopped: "stopped",
};

/** The status in words of a paused run, by its pause reason. */
const PAUSED: Record<string, string> = {
  budget: "Paused, budget",
  time_limit: "Paused, time limit",
  usage_limit: "Paused, usage limit",
  auth_required: "Paused, login",
  step_failed: "Paused, failed step",
  step_stopped: "Paused, stopped step",
  interrupted: "Paused, interrupted",
  requested: "Paused",
};

const WORDS: Record<Status, string> = {
  queued: "Starting",
  running: "Running",
  done: "Done",
  paused: "Paused",
  stopped: "Stopped",
  skipped: "Skipped",
  failed: "Failed",
  needs: "Needs you",
};

/** A run's status. A run that waits on a question, a breakpoint or a checkpoint is "needs", and a
 *  run whose worker refused its text is "failed". */
export function statusOf(view: RunView): Status {
  if (view.status === "not started" && view.record.refused) return "failed";
  if (view.unfinished && (view.questions.length > 0 || view.pause?.reason === "asks")) return "needs";
  return STATUS[view.status];
}

function statusText(view: RunView, status: Status): string {
  if (status === "paused") return PAUSED[view.pause?.reason ?? ""] ?? (view.pause?.text ? `Paused, ${view.pause.text}` : "Paused");
  if (view.status === "not started" && status === "queued") return "Not started";
  return WORDS[status];
}

/** Why a run paused, in the contract's words: "login" for a login the program asks for. */
function pauseReasonOf(view: RunView): string | undefined {
  const reason = view.pause?.reason;
  if (!reason) return undefined;
  if (reason === "auth_required") return "login";
  if (reason === "other") return view.saved?.pauseReason ?? "other";
  return reason;
}

export const projectOf = (dir: string): Project => ({ dir, name: basename(dir) || dir });

/** What a run is about: its first input that is a short string of one line, else its workflow. */
function titleOf(record: RunRecord): string {
  const short = Object.values(record.args).find((value): value is string => typeof value === "string" && value.trim() !== "" && value.length <= 100 && !value.includes("\n"));
  return short?.trim() ?? record.workflow;
}

const ENDED: ReadonlySet<Status> = new Set(["done", "failed", "stopped"]);

/** One run as the list shows it. */
export function runRow(view: RunView): RunRow {
  const { record, saved } = view;
  const status = statusOf(view);
  const ended = ENDED.has(status);
  const span = view.changedAt && (ended || status === "paused") ? Date.parse(view.changedAt) - Date.parse(record.createdAt) : undefined;
  const durationMs = saved?.durationMs ?? (span !== undefined && span >= 0 ? span : undefined);
  return {
    id: record.runId,
    workflow: record.workflow,
    title: titleOf(record),
    project: projectOf(record.projectDir),
    status,
    statusText: statusText(view, status),
    startedAt: record.createdAt,
    ...(ended && view.changedAt ? { endedAt: view.changedAt } : {}),
    ...(view.changedAt ? { changedAt: view.changedAt } : {}),
    tokens: saved?.tokens ?? 0,
    ...(saved?.cost ? { cost: saved.cost } : {}),
    ...(durationMs === undefined ? {} : { durationMs }),
    waiting: view.questions.length,
    origin: record.origin === "cli" && record.through?.kind === "person" && record.through.via === "view" ? "view" : record.origin,
  };
}

/** Every run, newest first. */
export function runRows(paths: HomePaths): RunRow[] {
  return listRuns(paths).map(runRow);
}

/** A question as the page shows it. Who may answer depends on the run's record. */
function questionOf(question: RunQuestion, record: RunRecord | undefined): Question {
  const { id, step, join, prompt, kind, choices, breakpoint, title, show, askedAt, answeredBy } = questionView(question, record);
  const { runId, scope, workflow } = question;
  return { id, runId, scope, workflow, ...(step ? { step } : {}), ...(join ? { join } : {}), prompt, kind, ...(choices ? { choices } : {}), breakpoint, ...(title === undefined ? {} : { title }), ...(show === undefined ? {} : { show }), answeredBy, askedAt };
}

/** Every open question, oldest first. */
export function openQuestions(paths: HomePaths): Question[] {
  const records = new Map<string, RunRecord | undefined>();
  return runQuestions(paths).map((question) => {
    if (!records.has(question.runId)) records.set(question.runId, loadRecord(paths, question.runId));
    return questionOf(question, records.get(question.runId));
  });
}

type EngineStep = RunDetail["steps"][number];

/** Where a run stands for its steps: a worker runs it, it waits to go on, or it ended. */
interface RunState {
  alive: boolean;
  unfinished: boolean;
  /** The steps an open question names, as "<scope>\0<label>". */
  asking: Set<string>;
}

function runState(view: RunView): RunState {
  return { alive: workerRuns(view), unfinished: view.unfinished, asking: new Set(view.questions.filter((question) => question.step).map((question) => `${question.scope}\0${question.step}`)) };
}

/** A step's status. A step saved as running is running only while a worker runs the run. Without
 *  one it is paused when the run may go on, else stopped. */
function stepStatus(status: string, scope: string, label: string, state: RunState): Status {
  switch (status) {
    case "queued":
      return "queued";
    case "done":
      return "done";
    case "error":
      return "failed";
    case "skipped":
      return "skipped";
    // The step's turn ended on its agent's question, and it goes on once the person answers.
    case "asks":
      return "needs";
    default:
      if (state.asking.has(`${scope}\0${label}`)) return "needs";
      if (state.alive) return "running";
      return state.unfinished ? "paused" : "stopped";
  }
}

/** How long a step took, in ms, from its start and end. Unset without both, or when one does not read. */
function durationOf(startedAt: string | undefined, endedAt: string | undefined): number | undefined {
  if (!startedAt || !endedAt) return undefined;
  const ms = Date.parse(endedAt) - Date.parse(startedAt);
  return Number.isNaN(ms) ? undefined : ms;
}

const PREVIEW = 200;

function previewOf(step: EngineStep): string | undefined {
  const text = step.resultPreview ?? (step.result === undefined ? undefined : typeof step.result === "string" ? step.result : JSON.stringify(step.result));
  if (!text) return undefined;
  return text.length > PREVIEW ? `${text.slice(0, PREVIEW - 3)}...` : text;
}

/** The run's step calls, in start order, each with the name and the call number `sous step` takes. */
function stepsOf(detail: RunDetail, state: RunState): Step[] {
  const id = detail.record.runId;
  const calls = new Map<string, number>();
  return detail.steps.map((step) => {
    const scope = typeof step.scope === "string" ? step.scope : id;
    const name = `${scopePrefix(id, scope, detail.record.nested)}${step.label}`;
    const call = (calls.get(name) ?? 0) + 1;
    calls.set(name, call);
    const agent = isAgentCall(step);
    const tokens = step.tokens ?? step.usage?.total;
    const durationMs = durationOf(step.startedAt, step.endedAt);
    const preview = previewOf(step);
    return {
      key: `${scope}:${step.id}`,
      label: step.label,
      name,
      scope,
      ...(step.phase ? { phase: step.phase } : {}),
      call,
      kind: agent ? "agent" : "exec",
      status: stepStatus(step.status, scope, step.label, state),
      ...(agent && step.model ? { model: step.model } : {}),
      ...(step.startedAt ? { startedAt: step.startedAt } : {}),
      ...(step.endedAt ? { endedAt: step.endedAt } : {}),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(tokens ? { tokens } : {}),
      ...(step.usage ? { usage: { input: step.usage.input, output: step.usage.output, cacheRead: step.usage.cacheRead, cacheWrite: step.usage.cacheWrite, cost: step.usage.cost } } : {}),
      ...(step.error === undefined ? {} : { error: step.error }),
      ...(preview === undefined ? {} : { preview }),
      ...(step.tries ? { tries: step.tries } : {}),
      ...(step.room ? { room: step.room } : {}),
    };
  });
}

type EngineNode = ReturnType<typeof workflowFlow>["nodes"][number];

/** The saved workflows a flow starts by name, at any depth. */
function startedIn(nodes: EngineNode[], into: Set<string>): Set<string> {
  for (const node of nodes) {
    if (node.t === "step" && node.workflow) into.add(node.workflow);
    for (const inner of innerFlows(node)) startedIn(inner, into);
  }
  return into;
}

/** The graphs of the run's text and of the nested workflows it starts, from the texts it started
 *  with. A nested workflow it started counts too, when its text no longer names it. */
function flowsOf(script: string | undefined, texts: Record<string, string>, record: RunRecord): { flow?: Flow; flows: Record<string, Flow> } {
  const flow = script === undefined ? undefined : workflowFlow(script);
  const flows: Record<string, Flow> = {};
  const todo = [...startedIn(flow?.nodes ?? [], new Set(Object.values(record.nested ?? {}).map((child) => child.workflow)))];
  for (let name = todo.shift(); name !== undefined; name = todo.shift()) {
    const text = texts[name];
    if (flows[name] || text === undefined) continue;
    flows[name] = workflowFlow(text);
    todo.push(...startedIn(flows[name]!.nodes, new Set()));
  }
  return { ...(flow ? { flow } : {}), flows };
}

/** The Claude Code and Codex versions the run's steps ran on. */
function programsOf(record: RunRecord): RunPage["programs"] {
  const out: Partial<Record<Harness, { version?: string }>> = {};
  for (const [program, used] of Object.entries(record.programs ?? {})) {
    if (program === "claude" || program === "codex") out[program] = used.version ? { version: used.version } : {};
  }
  return Object.keys(out).length ? out : undefined;
}

/** One run whole: its row, where it works, its steps, questions, nested runs and graphs, and the
 *  actions that fit its state. */
export function runPage(paths: HomePaths, id: string): RunPage {
  const detail = runDetail(paths, id);
  const { record } = detail;
  const row = runRow(detail);
  const texts = runTexts(paths, record);
  const nested: NestedRun[] = Object.entries(record.nested ?? {}).map(([child, run]) => ({
    id: child,
    parent: run.parent,
    workflow: run.workflow,
    ...(run.label ? { label: run.label } : {}),
    ...(run.branch ? { branch: run.branch } : {}),
  }));
  const pauseReason = pauseReasonOf(detail);
  const programs = programsOf(record);
  const can = runActions(detail);
  return {
    ...row,
    cwd: record.cwd,
    place: record.place,
    ...(record.branch ? { branch: record.branch } : {}),
    ...(record.worktree ? { worktree: record.worktree } : {}),
    args: record.args,
    ...(record.defaultModel ? { model: record.defaultModel } : {}),
    ...(record.budget ? { budget: record.budget } : {}),
    ...(pauseReason ? { pauseReason } : {}),
    ...(detail.pause?.resumeAt ? { resumesAt: detail.pause.resumeAt.toISOString() } : {}),
    ...(detail.failure ? { failure: detail.failure } : {}),
    ...(detail.result === undefined ? {} : { result: detail.result }),
    questions: detail.questions.map((question) => questionOf(question, record)),
    steps: stepsOf(detail, runState(detail)),
    ...(detail.engineState?.rooms?.length ? { rooms: detail.engineState.rooms } : {}),
    nested,
    ...flowsOf(texts.script, texts.workflows, record),
    can: { ...can, resumeChoice: can.resume && texts.changed.length > 0, rerun: true },
    ...(record.rerunOf ? { rerunOf: record.rerunOf } : {}),
    ...(programs ? { programs } : {}),
  };
}

/** An activity entry in the page's words. A message sous tell sent is a note. */
function activityOf(line: { seq: number; at: string; kind: string; text: string; tool?: string }): Activity {
  const kind = line.kind === "tell" ? "note" : (line.kind as Activity["kind"]);
  return { seq: line.seq, at: line.at, kind, text: line.text, ...(line.tool ? { tool: line.tool } : {}) };
}

/** One call of a step whole, by its name in the log, the last call unless `call` names one. */
export function stepDetail(paths: HomePaths, runId: string, name: string, call?: number): StepDetail {
  const view = stepView(paths, runId, name, { full: true, ...(call === undefined ? {} : { call }) });
  const run = readRun(paths, runId);
  const label = view.step.slice(scopePrefix(run.record.runId, view.scope, run.record.nested).length);
  const status = stepStatus(view.status, view.scope, label, runState(run));
  const durationMs = durationOf(view.startedAt, view.endedAt);
  return {
    name: view.step,
    scope: view.scope,
    call: view.call,
    calls: view.calls,
    kind: view.kind,
    status,
    ...(view.model ? { model: view.model } : {}),
    ...(view.startedAt ? { startedAt: view.startedAt } : {}),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(view.tokens ? { tokens: view.tokens } : {}),
    ...(view.prompt === undefined ? {} : { prompt: view.prompt }),
    ...(view.command === undefined ? {} : { command: view.command }),
    ...(view.output === undefined ? {} : { output: view.output }),
    ...(view.result === undefined ? {} : { result: view.result }),
    ...(view.failure === undefined ? {} : { failure: view.failure }),
    ...(view.session ? { session: view.session } : {}),
    activity: view.activity.map(activityOf),
  };
}
