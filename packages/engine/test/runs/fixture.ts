// A home and a project for the runs tests. The worker hands each step to the test's runner, so
// no program runs.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { WorkflowError, WorkflowErrorCode } from "../../src/errors.js";
import type { AgentRunner } from "../../src/steps/agent-runner.js";
import type { HomePaths } from "../../src/runs/home.js";
import type { RunRecord } from "../../src/runs/records.js";

// The home and the planted state come from the test kit, which sous's tests use too.
export { plantState, testHome as setup } from "../../src/testing.js";

/** The engine names a project's folder after the folder's name and a hash of its path. */
export function projectKey(dir: string): string {
  return `${basename(dir)}-${createHash("sha256").update(dir).digest("hex").slice(0, 12)}`;
}

/** Every file and folder under the test's root, folders ending in "/", without the workflows
 *  the test wrote. The two project keys and the run id are replaced, so the list is the same on
 *  every run. */
export function layout(paths: HomePaths, runId: string, cwd: string): string[] {
  const root = dirname(paths.home);
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const rel = relative(root, path);
      if (rel.startsWith(join("project", ".sous", "workflows") + "/")) continue;
      if (statSync(path).isDirectory()) {
        out.push(`${rel}/`);
        walk(path);
      } else out.push(rel);
    }
  };
  walk(root);
  return out
    .map((line) => line.split(projectKey(cwd)).join("<cwd key>").split(projectKey(paths.home)).join("<home key>").split(runId).join("<id>"))
    .sort();
}

export interface TodayRunOptions {
  /** A lock whose owner is this process, so the lock counts as held. */
  liveLock?: boolean;
  /** An open question in the inbox. */
  question?: boolean;
  /** The run works in a worktree in the home, not in the project folder. */
  worktree?: boolean;
}

/** The id of the run plantTodayRun plants. */
export const TODAY_ID = "mwsvo56a-today1";

const TODAY = join(import.meta.dirname, "..", "fixtures", "today-layout");

/**
 * Plant a finished run of the workflow "today" as today's code leaves its files, with raw writes
 * and no path code of the engine. test/fixtures/today-layout/run/ holds the files, captured from a
 * real run, and each option adds the folder of its name. Names and text hold placeholders:
 * __ID__ the run id, __ROOT__ the folder of the home and the project, __CWD__ the run's folder,
 * __HOME_KEY__ and __CWD_KEY__ the engine's folder names for the home and the run's folder, and
 * __PID__ the lock's owner. Call it on a home from setup().
 */
export function plantTodayRun(paths: HomePaths, options: TodayRunOptions = {}): RunRecord {
  const root = dirname(paths.home);
  const cwd = options.worktree ? join(paths.home, "worktrees", TODAY_ID) : join(root, "project");
  const fill = (text: string) =>
    text
      .replaceAll('"__PID__"', String(process.pid))
      .replaceAll("__PID__", String(process.pid))
      .replaceAll("__CWD_KEY__", projectKey(cwd))
      .replaceAll("__HOME_KEY__", projectKey(paths.home))
      .replaceAll("__CWD__", cwd)
      .replaceAll("__ROOT__", root)
      .replaceAll("__ID__", TODAY_ID);
  const folders = ["run"];
  if (options.liveLock) folders.push("live-lock");
  if (options.question) folders.push("question");
  for (const folder of folders) {
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const from = join(dir, name);
        if (statSync(from).isDirectory()) {
          walk(from);
          continue;
        }
        const to = join(root, fill(relative(join(TODAY, folder), from)));
        mkdirSync(dirname(to), { recursive: true });
        writeFileSync(to, fill(readFileSync(from, "utf8")));
      }
    };
    walk(join(TODAY, folder));
  }
  const recordFile = join(paths.home, "records", `${TODAY_ID}.json`);
  const record = JSON.parse(readFileSync(recordFile, "utf8")) as RunRecord;
  if (!options.worktree) return record;
  // sous names a run's worktree and its branch after the run.
  mkdirSync(cwd, { recursive: true });
  const moved: RunRecord = { ...record, place: "worktree", worktree: cwd, branch: `sous/${TODAY_ID}` };
  writeFileSync(recordFile, `${JSON.stringify(moved, null, 2)}\n`);
  return moved;
}

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

/** A log callback that drops each line. */
export const quiet = () => {};

/** The failure of an agent step that a resume can retry. */
export const boom = () => new WorkflowError("boom", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: true });

/** A pid that no process has now: a child that already ended. */
export function deadPid(): number {
  return spawnSync(process.execPath, ["-e", ""]).pid!;
}
