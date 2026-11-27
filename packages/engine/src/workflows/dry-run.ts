// `sous check <workflow> --dry-run`: run a workflow once with stand-in agents, to catch mistakes in
// its steps and how they connect before a real run. Code steps run for real, in the workflow's own
// place, except that a worktree (or a scratch folder outside a git repo) stands in for the project
// folder, so a dry run never changes the project.
// Each question gets a stand-in answer, an agent's question too. A step that runs until done gets
// its turns from the stand-ins, and a check command runs once: the dry run notes its exit code, and
// the step goes on as if it passed. At the end the run, its worktrees and its scratch folders are
// deleted.

import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { isHarness } from "../agents.js";
import { DRY_RUN_MAX_CALLS } from "../config.js";
import { agentLimitMessage } from "../errors.js";
import { fabricateFromSchema } from "../fabricate.js";
import { isGitRepo, removeWorktree, runWorktrees } from "../places/places.js";
import { loadConfig, type HomePaths } from "../runs/home.js";
import type { Who } from "../runs/actions.js";
import { createRun } from "../runs/launch.js";
import { loadRecord } from "../runs/records.js";
import { forgetRun } from "../runs/run.js";
import { readState } from "../runs/store.js";
import { runWorker } from "../runs/worker.js";
import type { DryRunCheck } from "../code-steps.js";
import type { PlannedRequest } from "../steps/agent-run.js";
import type { InnerRunner } from "../steps/steps.js";
import { resolveWorkflow } from "./dir.js";

/** Step label, or a pattern with `*`, to its answer. A list is a series of answers given in turn,
 *  the last one repeating, so an answer that is itself a list goes inside one: `[["a", "b"]]`. */
export type Answers = Record<string, unknown>;

function matches(pattern: string, label: string): boolean {
  if (!pattern.includes("*")) return pattern === label;
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`).test(label);
}

const STATUSES = ["done", "working", "question"];

const DRY_RUN_CAP_REASON = `The dry run stopped after ${DRY_RUN_MAX_CALLS} agent, code and checkpoint calls. A dry run starts no program, so it keeps this cap to end a loop in the script. A real run has no cap unless the script sets meta.maxAgents.`;
const STATUS_KEYS = ["status", "result", "message"];

/** The step's own schema inside a status schema: the first choice of its result. A step with no
 *  schema of its own has a string there. */
function resultSchema(status: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const result = (status?.properties as Record<string, { anyOf?: Array<Record<string, unknown>> }> | undefined)?.result;
  const own = result?.anyOf?.[0];
  return own && !(Object.keys(own).length === 1 && own.type === "string") ? own : undefined;
}

/** What a stand-in gives with no answer: a value that fits the schema, else a line of text. */
function madeUp(schema: Record<string, unknown> | undefined, label: string): unknown {
  return schema ? fabricateFromSchema(schema, label) : `stand-in answer from ${label}`;
}

/**
 * An answer to a step that runs until done, as a turn's status. A status name, or an object with
 * a status and no key but status, result and message, is a status. The fields it leaves out are
 * filled: a made-up result with "done", a stand-in question with "question", null otherwise. Any
 * other answer is "done" with that answer as the result.
 */
function asStatus(answer: unknown, schema: Record<string, unknown> | undefined, label: string): unknown {
  const fields: Record<string, unknown> | undefined =
    typeof answer === "string" && STATUSES.includes(answer)
      ? { status: answer }
      : answer !== null && typeof answer === "object" && !Array.isArray(answer) && "status" in answer && Object.keys(answer).every((key) => STATUS_KEYS.includes(key))
        ? (answer as Record<string, unknown>)
        : undefined;
  if (!fields) return { status: "done", result: answer, message: null };
  const status = fields.status;
  const result = "result" in fields ? fields.result : status === "done" ? madeUp(schema, label) : null;
  const message = "message" in fields ? fields.message : status === "question" ? `stand-in question from ${label}` : null;
  return { status, result, message };
}

/** Agents that answer at once: the answer given for the step, else a value that fits the step's
 *  schema, else a line of text. Booleans in a made-up value are true, so loops on them end. A step
 *  that runs until done gets its answer as a turn's status, and "done" when none is given or its
 *  answers ran out on a status other than done. */
function standInAgents(answers: Answers = {}): InnerRunner & { calls: string[] } {
  const calls: string[] = [];
  const given = new Map<string, number>();
  /** The next answer for the step. `spent` is true once its list ran out, and the last answer repeats. */
  const answerFor = (label: string): { value: unknown; spent: boolean } | undefined => {
    const key = Object.hasOwn(answers, label) ? label : Object.keys(answers).find((pattern) => matches(pattern, label));
    if (key === undefined) return undefined;
    const list = Array.isArray(answers[key]) ? (answers[key] as unknown[]) : [answers[key]];
    const n = given.get(key) ?? 0;
    given.set(key, n + 1);
    return { value: list[Math.min(n, list.length - 1)], spent: n >= list.length };
  };
  const run = async (_prompt: string, request: PlannedRequest): Promise<unknown> => {
    const label = request.label ?? "agent";
    calls.push(label);
    // One session id per session, as with real agents: a kept turn goes on in its session, and a
    // fork gets a new one. The session is on the program the step's model names.
    const kept = request.continueFromSession && !request.fork ? request.continueFromSession.sessionId : undefined;
    const program = request.model?.split("/")[0]?.toLowerCase();
    const backendId = request.continueFromSession?.backendId ?? (isHarness(program) ? program : "claude");
    request.onSessionOpen?.({ sessionId: kept ?? `dry-run-${calls.length}`, backendId, cwd: request.cwd!, reopen: { load: true, resume: true, list: true } });
    const answer = answerFor(label);
    const schema = request.schema as Record<string, unknown> | undefined;
    if (!request.untilDone) return answer ? answer.value : madeUp(schema, label);
    const own = resultSchema(schema);
    const status = asStatus(answer ? answer.value : "done", own, label) as { status: unknown };
    // A status other than done plays once: once the answers run out, the step says done, so a
    // step answered "working" ends.
    return answer?.spent && status.status !== "done" ? asStatus("done", own, label) : status;
  };
  return { run, calls };
}

export interface DryRunResult {
  runId: string;
  status: string;
  result?: unknown;
  reason?: string;
  /** The agent steps the stand-ins answered. */
  agents: string[];
  /** The check commands that ran, each once, with their exit codes. Set when any ran. */
  checks?: DryRunCheck[];
}

export interface DryRunRequest {
  workflow: string;
  projectDir: string;
  inputs: Record<string, unknown>;
  answers?: Answers;
  log?: (line: string) => void;
  /** Who asks. A dry run runs the code steps, so an agent's dry run of a people workflow is refused as its run is. */
  who: Who;
  /** The command the person types, for that refusal. */
  command?: string;
}

export async function dryRun(paths: HomePaths, request: DryRunRequest): Promise<DryRunResult> {
  // The workflow's own place, except the project folder itself: a worktree stands in for it.
  const own = resolveWorkflow(paths, request.projectDir, request.workflow).extras.place ?? loadConfig(paths).defaultPlace;
  const place = own !== "folder" ? own : isGitRepo(request.projectDir) ? "worktree" : "none";
  const record = createRun(paths, { workflow: request.workflow, projectDir: request.projectDir, inputs: request.inputs, place, origin: "check", who: request.who, ...(request.command ? { command: request.command } : {}) });
  const agents = standInAgents(request.answers);
  const checks: DryRunCheck[] = [];
  try {
    const result = await runWorker(record.runId, "start", { paths, inner: agents, log: request.log ?? (() => {}), dryRun: true, onDryRunCheck: (check) => checks.push(check) });
    const state = readState(paths, record.runId);
    const status = result?.status ?? state?.status ?? "unknown";
    const given = result?.reason ?? state?.reason ?? state?.pauseReason;
    // The dry run's own cap, which the script did not set.
    const reason = given === agentLimitMessage(DRY_RUN_MAX_CALLS) ? DRY_RUN_CAP_REASON : given;
    // The result is plain JSON, made in the workflow's own sandbox; a copy belongs to this side.
    const value = status === "completed" && result?.result !== undefined ? { result: JSON.parse(JSON.stringify(result.result)) as unknown } : {};
    return { runId: record.runId, status, ...value, ...(reason ? { reason: String(reason) } : {}), agents: agents.calls, ...(checks.length ? { checks } : {}) };
  } finally {
    const latest = loadRecord(paths, record.runId) ?? record;
    for (const tree of runWorktrees(latest)) {
      try {
        removeWorktree(record.projectDir, tree.dir, tree.branch);
      } catch {
        // already gone
      }
    }
    // The scratch folders of the run and its nested runs.
    for (const dir of [latest.cwd, ...Object.values(latest.nested ?? {}).map((child) => child.cwd)]) {
      if (dir && dirname(dir) === paths.scratch) rmSync(dir, { recursive: true, force: true });
    }
    forgetRun(paths, latest);
  }
}
