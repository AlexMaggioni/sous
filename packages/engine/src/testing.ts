// The test kit, at @sous/engine/testing. A test makes a home with it, plants a run's
// files, and starts workers in its own process through the launcher sous's commands take. sous's
// code never imports it: the architecture test flags an import past the entry from src.

import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ensureHome, homePaths, type HomePaths } from "./runs/home.js";
import type { Launcher } from "./runs/launch.js";
import { endWorker } from "./runs/records.js";
import { engineRunFiles, logFile } from "./runs/store.js";
import { runWorker } from "./runs/worker.js";
import type { PersistedRunState } from "./runs/persistence/run-persistence.js";
import type { InnerRunner } from "./steps/steps.js";
import type { Who } from "./runs/actions.js";
import type { WorkflowRunResult } from "./workflow-result.js";

// Engine parts sous's tests use and sous's code does not, so the main entry leaves them out.
export { WorkflowError, WorkflowErrorCode } from "./errors.js";
export { readActions } from "./runs/actions.js";
export { knownProjects } from "./runs/home.js";
export { writeAnswer } from "./runs/inbox.js";
export { createRun } from "./runs/launch.js";
export { processAlive, requestStepStop, requestTell, saveRecord, updateRecord } from "./runs/records.js";
export { tick } from "./runs/service.js";
export { enginePersistence, readState, stopRequestFile } from "./runs/store.js";
export { workflowProjectPaths } from "./runs/persistence/project-paths.js";
export type { PersistedRunState } from "./runs/persistence/run-persistence.js";
export type { InnerRunner } from "./steps/steps.js";

/** The person at their own terminal, as the writes of tests that call the engine pass it. */
export const PERSON: Who = { by: "person", through: { kind: "person" } };

/**
 * A new home and project folder in the temp folder. The config sends no notices and runs in the
 * project folder, unless `config` says otherwise. Each workflow goes in the project's workflow
 * folder as `<name>.js`.
 */
export function testHome(workflows: Record<string, string> = {}, config: Record<string, unknown> = {}): { paths: HomePaths; projectDir: string } {
  const root = mkdtempSync(join(tmpdir(), "sous-test-"));
  const paths = ensureHome(homePaths(join(root, "home")));
  writeFileSync(paths.config, JSON.stringify({ notify: false, defaultPlace: "folder", ...config }));
  const projectDir = join(root, "project");
  mkdirSync(join(projectDir, ".sous", "workflows"), { recursive: true });
  for (const [name, script] of Object.entries(workflows)) writeFileSync(join(projectDir, ".sous", "workflows", `${name}.js`), script);
  return { paths, projectDir };
}

/** Write a run's engine files the way the engine leaves them, with no manager: its state and,
 *  when given, its event log. A state may leave out what an old engine did not save. */
export function plantState(paths: HomePaths, state: Partial<PersistedRunState> & { runId: string }, events?: string): void {
  const files = engineRunFiles(paths, state.runId);
  mkdirSync(dirname(files.state), { recursive: true });
  writeFileSync(files.state, JSON.stringify(state, null, 2));
  if (events !== undefined) writeFileSync(files.events, events);
}

/** A step the fake runner was asked to run. */
export interface Call {
  prompt: string;
  label?: string;
  options: Record<string, unknown>;
}

/**
 * A runner that stands in for the programs. Each call is noted, opens a session as a program
 * would, and gives what `answer` returns. An `answer` that throws fails the step.
 */
export function fakeRunner(answer: (call: Call, calls: Call[]) => unknown): { runner: InnerRunner; calls: Call[] } {
  const calls: Call[] = [];
  const runner = {
    async run(prompt: string, options: Record<string, unknown> = {}) {
      const call = { prompt, label: options.label as string | undefined, options };
      calls.push(call);
      (options.onSessionOpen as ((ref: unknown) => void) | undefined)?.({ sessionId: `s${calls.length}`, backendId: "claude", cwd: options.cwd, reopen: { load: true, resume: true, list: true } });
      return answer(call, calls);
    },
  } as unknown as InnerRunner;
  return { runner, calls };
}

export interface InProcessOptions {
  /** The runner that stands in for the programs. */
  inner: InnerRunner;
  /** How often the worker looks for an answer, in ms. Default 20. */
  pollMs?: number;
  /** Gets each line the worker logs. The run's log file gets them too. */
  log?: (line: string) => void;
  /** Let `sous pause`, `sous stop` and `sous stop --step` reach the worker. They signal the
   *  record's pid, which is this process. Default false. */
  handleSignals?: boolean;
}

export interface InProcessWorkers {
  /** Starts each worker in this process. Pass it where sous passes workerProcess. */
  launch: Launcher;
  /** Each worker started, in order. */
  launched: Array<{ runId: string; mode: "start" | "resume" }>;
  /** The result of the last worker started for the run. It rejects when that worker threw. */
  ended(runId: string): Promise<WorkflowRunResult | undefined>;
}

/**
 * A launcher that runs each worker in this process, with the given runner. The worker writes its
 * lines to the run's log file, as a worker process does, so `sous log` and `sous run --wait` read
 * them. A worker that throws writes the error to the log and clears its pid, as workerMain does.
 * Unlike a worker process, it leaves SOUS_RUN_ID unset.
 */
export function inProcess(options: InProcessOptions): InProcessWorkers {
  const { inner, pollMs = 20, handleSignals = false } = options;
  const launched: InProcessWorkers["launched"] = [];
  const workers = new Map<string, Promise<WorkflowRunResult | undefined>>();
  const launch: Launcher = (paths, runId, mode) => {
    launched.push({ runId, mode });
    const toFile = (line: string) => appendFileSync(logFile(paths, runId), `${line}\n`);
    const log = (line: string) => {
      toFile(line);
      options.log?.(line);
    };
    const worker = runWorker(runId, mode, { paths, inner, pollMs, log, handleSignals });
    worker.catch((error: unknown) => {
      toFile(`${new Date().toISOString().slice(11, 19)} error      ${(error as Error).stack ?? String(error)}`);
      endWorker(paths, runId);
    });
    workers.set(runId, worker);
  };
  const ended = (runId: string) => workers.get(runId) ?? Promise.reject(new Error(`no worker started for ${runId}`));
  return { launch, launched, ended };
}
