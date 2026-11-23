// A home and a project for the runs tests. The worker hands each step to the test's runner, so
// no program runs.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import type { AgentRunner } from "../../src/steps/agent-runner.js";
import { ensureHome, homePaths, type HomePaths } from "../../src/runs/home.js";
import { workflowProjectPaths } from "../../src/runs/persistence/project-paths.js";
import type { PersistedRunState } from "../../src/runs/persistence/run-persistence.js";
import type { RunRecord } from "../../src/runs/records.js";

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
      if (rel.startsWith(join("project", ".orchestrator", "workflows") + "/")) continue;
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
  /** A `.lineage` file left by an earlier forget of the same id. */
  lineage?: boolean;
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
  if (options.lineage) folders.push("lineage");
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
  // orc names a run's worktree and its branch after the run.
  mkdirSync(cwd, { recursive: true });
  const moved: RunRecord = { ...record, place: "worktree", worktree: cwd, branch: `orc/${TODAY_ID}` };
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
