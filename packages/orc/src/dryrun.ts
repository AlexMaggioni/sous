// `orc check <workflow> --dry-run`: run a workflow once with stand-in agents, to catch mistakes in
// its steps and how they connect before a real run. Code steps run for real, in the workflow's own
// place, except that a worktree (or a scratch folder outside a git repo) stands in for the project
// folder, so a dry run never changes the project.
// Each question gets a stand-in answer. At the end the run, its worktrees and its scratch folders
// are deleted.

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createRun, fabricateFromSchema, forgetRun, isGitRepo, loadConfig, loadRecord, removeWorktree, resolveWorkflow, runWorker, runWorktrees, savedState, type AgentRunner, type HomePaths } from "@orchestrator/engine";

/** Step label, or a pattern with `*`, to its answer. A list is a series of answers given in turn,
 *  the last one repeating, so an answer that is itself a list goes inside one: `[["a", "b"]]`. */
export type Answers = Record<string, unknown>;

export function readAnswers(file: string): Answers {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file} must hold an object from step label to answer, such as {"reviewer *": {"approved": false, "review": "Add a test"}}`);
  }
  return parsed as Answers;
}

function matches(pattern: string, label: string): boolean {
  if (!pattern.includes("*")) return pattern === label;
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`).test(label);
}

/** Agents that answer at once: the answer given for the step, else a value that fits the step's
 *  schema, else a line of text. Booleans in a made-up value are true, so loops on them end. */
export function standInAgents(answers: Answers = {}): AgentRunner & { calls: string[] } {
  const calls: string[] = [];
  const given = new Map<string, number>();
  const run = async (_prompt: string, options: Record<string, unknown> = {}): Promise<unknown> => {
    const label = typeof options.label === "string" ? options.label : "agent";
    calls.push(label);
    // A session id lets a later step continue this one, as with real agents.
    const open = options.onSessionOpen as ((ref: unknown) => void) | undefined;
    open?.({ sessionId: `dry-run-${calls.length}`, backendId: "claude", cwd: options.cwd, reopen: { load: true, resume: true, list: true } });
    const key = Object.hasOwn(answers, label) ? label : Object.keys(answers).find((pattern) => matches(pattern, label));
    if (key !== undefined) {
      const value = answers[key];
      if (!Array.isArray(value)) return value;
      const n = given.get(key) ?? 0;
      given.set(key, n + 1);
      return value[Math.min(n, value.length - 1)];
    }
    return options.schema ? fabricateFromSchema(options.schema, label) : `stand-in answer from ${label}`;
  };
  return { run: run as AgentRunner["run"], calls };
}

export interface DryRunResult {
  runId: string;
  status: string;
  result?: unknown;
  reason?: string;
  /** The agent steps the stand-ins answered. */
  agents: string[];
}

export interface DryRunRequest {
  workflow: string;
  projectDir: string;
  inputs: Record<string, unknown>;
  answers?: Answers;
  log?: (line: string) => void;
}

export async function dryRun(paths: HomePaths, request: DryRunRequest): Promise<DryRunResult> {
  // The workflow's own place, except the project folder itself: a worktree stands in for it.
  const own = resolveWorkflow(paths, request.projectDir, request.workflow).extras.place ?? loadConfig(paths).defaultPlace;
  const place = own !== "folder" ? own : isGitRepo(request.projectDir) ? "worktree" : "none";
  const record = createRun(paths, { workflow: request.workflow, projectDir: request.projectDir, inputs: request.inputs, place, origin: "check" });
  const agents = standInAgents(request.answers);
  try {
    const result = await runWorker(record.runId, "start", { paths, inner: agents, log: request.log ?? (() => {}), dryRun: true });
    const state = savedState(paths, record);
    const status = result?.status ?? state?.status ?? "unknown";
    const reason = result?.reason ?? state?.reason ?? state?.pauseReason;
    // The result is plain JSON, made in the workflow's own sandbox; a copy belongs to this side.
    const value = status === "completed" && result?.result !== undefined ? { result: JSON.parse(JSON.stringify(result.result)) as unknown } : {};
    return { runId: record.runId, status, ...value, ...(reason ? { reason: String(reason) } : {}), agents: agents.calls };
  } finally {
    for (const tree of runWorktrees(paths, record.runId)) {
      try {
        removeWorktree(record.projectDir, tree.dir, tree.branch);
      } catch {
        // already gone
      }
    }
    if (existsSync(paths.scratch)) {
      for (const name of readdirSync(paths.scratch)) {
        if (name === record.runId || name.startsWith(`${record.runId}-nested`)) rmSync(join(paths.scratch, name), { recursive: true, force: true });
      }
    }
    forgetRun(paths, loadRecord(paths, record.runId) ?? record);
  }
}
