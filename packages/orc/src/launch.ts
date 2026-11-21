// Start a run: find the workflow, check its inputs, make its place, write its record, and
// start its worker in the background. Used by `orc run`, `orc rerun` and the schedules.

import { spawn } from "node:child_process";
import { existsSync, openSync, readFileSync, closeSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateRunId, openWorkflowDir, parseWorkflowScript } from "@automatalabs/workflow-engine";
import { loadConfig, workflowDirs, type HomePaths, type Place } from "./home.js";
import { checkInputs, workflowExtras, type WorkflowExtras } from "./inputs.js";
import { preparePlace } from "./places.js";
import { saveRecord, type RunRecord } from "./records.js";
import type { Priority } from "./slots.js";

export interface ResolvedWorkflow {
  name: string;
  file: string;
  script: string;
  meta: Record<string, unknown>;
  extras: WorkflowExtras;
}

/** A saved workflow by name (project first, then home), or a script file by path. */
export function resolveWorkflow(paths: HomePaths, projectDir: string, nameOrPath: string): ResolvedWorkflow {
  let file: string | undefined;
  const asPath = isAbsolute(nameOrPath) ? nameOrPath : resolve(process.cwd(), nameOrPath);
  if ((nameOrPath.includes("/") || nameOrPath.endsWith(".js") || nameOrPath.endsWith(".mjs")) && existsSync(asPath)) {
    file = asPath;
  } else {
    const dirs = workflowDirs(projectDir, paths);
    const entry = openWorkflowDir(dirs)
      .list()
      .find((candidate) => candidate.name === nameOrPath);
    if (!entry) {
      const names = openWorkflowDir(dirs)
        .list()
        .map((candidate) => candidate.name);
      throw new Error(
        `no workflow "${nameOrPath}". Looked in ${dirs.join(" and ")}.${names.length ? ` Saved workflows: ${names.join(", ")}.` : ""}`,
      );
    }
    if (entry.error) throw new Error(`${entry.file} does not parse: ${entry.error}`);
    file = entry.file;
  }
  const script = readFileSync(file, "utf8");
  const { meta } = parseWorkflowScript(script);
  const name = basename(file).replace(/(\.workflow)?\.m?js$/, "");
  return { name, file, script, meta: meta as unknown as Record<string, unknown>, extras: workflowExtras(meta as unknown as Record<string, unknown>) };
}

export interface CreateRunRequest {
  workflow: string;
  projectDir: string;
  inputs: Record<string, unknown>;
  place?: Place;
  priority?: Priority;
  origin?: RunRecord["origin"];
  schedule?: string;
  overrides?: Record<string, Record<string, unknown>>;
  defaultModel?: string;
  concurrency?: number;
  rerunOf?: string;
  /** Reuse the results of this run's steps that did not change. The new run works in its place. */
  reuseFrom?: RunRecord;
  /** The run whose agent asks for this one, when an agent starts it. */
  startedByRun?: string;
}

export class InputProblems extends Error {
  constructor(readonly workflow: string, readonly problems: string[]) {
    super(`${workflow} cannot start:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
}

/** Check the request and write the run's record. Nothing runs yet. */
export function createRun(paths: HomePaths, request: CreateRunRequest): RunRecord {
  const resolved = resolveWorkflow(paths, request.projectDir, request.workflow);
  const checked = checkInputs(resolved.extras, request.inputs);
  const args = checked.args;
  const problems = [...(resolved.extras.metaProblems ?? []), ...checked.problems];
  if (problems.length) throw new InputProblems(resolved.name, problems);
  if (request.startedByRun && resolved.extras.startedBy === "people") {
    throw new Error(`${resolved.name} is started by people only, so the agent in run ${request.startedByRun} cannot start it.`);
  }
  const config = loadConfig(paths);
  const runId = generateRunId();
  const reuse = request.reuseFrom;
  // A run that reuses another's results needs that run's files too, so it works where it did.
  const place = reuse ? reuse.place : (request.place ?? resolved.extras.place ?? config.defaultPlace);
  const prepared = reuse
    ? { cwd: reuse.cwd, ...(reuse.worktree ? { worktree: reuse.worktree, branch: reuse.branch } : {}) }
    : preparePlace(paths, place, runId, request.projectDir);
  const record: RunRecord = {
    runId,
    workflow: resolved.name,
    file: resolved.file,
    args,
    place,
    cwd: prepared.cwd,
    projectDir: request.projectDir,
    ...(prepared.worktree ? { worktree: prepared.worktree, branch: prepared.branch } : {}),
    priority: request.priority ?? "user",
    origin: request.origin ?? "cli",
    ...(request.schedule ? { schedule: request.schedule } : {}),
    createdAt: new Date().toISOString(),
    ...(request.overrides && Object.keys(request.overrides).length ? { overrides: request.overrides } : {}),
    ...(request.defaultModel ? { defaultModel: request.defaultModel } : {}),
    ...((request.concurrency ?? resolved.extras.concurrency) ? { concurrency: request.concurrency ?? resolved.extras.concurrency } : {}),
    ...(resolved.extras.timeout ? { timeout: resolved.extras.timeout } : {}),
    ...(request.rerunOf ? { rerunOf: request.rerunOf } : {}),
    ...(reuse ? { reuseFrom: reuse.runId } : {}),
    ...(request.startedByRun ? { startedByRun: request.startedByRun } : {}),
  };
  saveRecord(paths, record);
  return record;
}

/** The built command-line file, which also runs the worker. */
function cliFile(): string {
  const here = fileURLToPath(new URL(".", import.meta.url));
  for (const candidate of [join(here, "cli.js"), join(here, "..", "dist", "cli.js")]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("orc is not built. Run pnpm build in the orchestrator repo.");
}

export function logFile(paths: HomePaths, runId: string): string {
  return join(paths.logs, `${runId}.log`);
}

/** Start the run's worker in the background. Its output goes to logs/<run id>.log. */
export function spawnWorker(paths: HomePaths, runId: string, mode: "start" | "resume"): number {
  const out = openSync(logFile(paths, runId), "a");
  try {
    const child = spawn(process.execPath, [cliFile(), "_worker", runId, mode], {
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...process.env, ORC_HOME: paths.home },
    });
    child.unref();
    return child.pid!;
  } finally {
    closeSync(out);
  }
}
