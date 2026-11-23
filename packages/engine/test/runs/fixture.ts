// A home and a project for the runs tests. The worker hands each step to the test's runner, so
// no program runs.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunner } from "../../src/steps/agent-runner.js";
import { ensureHome, homePaths, type HomePaths } from "../../src/runs/home.js";
import { workflowProjectPaths } from "../../src/runs/persistence/project-paths.js";
import type { PersistedRunState } from "../../src/runs/persistence/run-persistence.js";

export function setup(workflows: Record<string, string>, config: Record<string, unknown> = {}): { paths: HomePaths; projectDir: string } {
  const root = mkdtempSync(join(tmpdir(), "engine-runs-"));
  const paths = ensureHome(homePaths(join(root, "home")));
  writeFileSync(paths.config, JSON.stringify({ notify: false, defaultPlace: "folder", ...config }));
  const projectDir = join(root, "project");
  mkdirSync(join(projectDir, ".orchestrator", "workflows"), { recursive: true });
  for (const [name, script] of Object.entries(workflows)) writeFileSync(join(projectDir, ".orchestrator", "workflows", `${name}.js`), script);
  return { paths, projectDir };
}

/** Write a run's engine files the way the engine leaves them, with no manager: its state and,
 *  when given, its event log. A state may leave out what an old engine did not save. */
export function plantState(paths: HomePaths, state: Partial<PersistedRunState> & { runId: string }, events?: string): void {
  const { runsDir } = workflowProjectPaths(paths.home, { persistenceRoot: paths.runs });
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(join(runsDir, `${state.runId}.json`), JSON.stringify(state, null, 2));
  if (events !== undefined) writeFileSync(join(runsDir, `${state.runId}.events.jsonl`), events);
}

/** The tests run the worker in this process, so no cli file ever starts. */
export const NO_CLI = "/nonexistent/orc/cli.js";

export interface Call {
  prompt: string;
  label?: string;
}

/**
 * A runner whose steps wait until the test lets them end. `answer` picks what a step does: a
 * value to return, an error to throw, or "wait" to wait for `release(label)`.
 */
export function heldRunner(answer: (call: Call, calls: Call[]) => unknown): { runner: AgentRunner; calls: Call[]; release: (label: string) => void } {
  const calls: Call[] = [];
  const waiting = new Map<string, Array<() => void>>();
  const runner = {
    async run(prompt: string, options: Record<string, unknown> = {}) {
      const call = { prompt, label: options.label as string | undefined };
      calls.push(call);
      const what = answer(call, calls);
      if (what instanceof Error) throw what;
      if (what !== "wait") return what;
      await new Promise<void>((resolve, reject) => {
        const list = waiting.get(call.label ?? "") ?? [];
        list.push(resolve);
        waiting.set(call.label ?? "", list);
        (options.signal as AbortSignal | undefined)?.addEventListener("abort", () => reject(new Error("aborted")));
      });
      return `${call.label} done`;
    },
  } as unknown as AgentRunner;
  const release = (label: string) => {
    for (const resolve of waiting.get(label) ?? []) resolve();
    waiting.delete(label);
  };
  return { runner, calls, release };
}

/** Call `read` until it gives `expected` or 5 seconds pass, and return the last value. */
export async function settle<T>(read: () => T, expected: T): Promise<T> {
  let last = read();
  for (let i = 0; i < 250 && JSON.stringify(last) !== JSON.stringify(expected); i++) {
    await new Promise((r) => setTimeout(r, 20));
    last = read();
  }
  return last;
}

/** Wait until `ready` holds, or 5 seconds pass. */
export async function until(ready: () => boolean): Promise<void> {
  for (let i = 0; i < 250 && !ready(); i++) await new Promise((r) => setTimeout(r, 20));
}
