// The background service: `orc daemon start`. Every 20 seconds it
//  - starts scheduled runs, and skips one when the schedule's last run has not finished. A
//    schedule comes from `orc schedule add`, or from `schedule` in a workflow file's meta, in the
//    home folder or in a project where orc ran;
//  - resumes runs paused at the subscription limit once the limit resets, unless a workflow they
//    use was edited since they started. Then it tells the user once and waits for `orc resume`;
//  - tells the user, once, about a run cut off by a crash or a restart. It waits for `orc resume`;
//  - removes finished runs older than keepDays, when config.json sets it;
//  - once an hour, removes the worktrees whose branch was merged and that have nothing uncommitted.

import { existsSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunStatus } from "../workflow-result.js";
import { openWorkflowDir } from "../workflows/dir.js";
import { workflowProjectPaths } from "./persistence/project-paths.js";
import { gcWorktrees, runWorktrees } from "../places/places.js";
import { changedWorkflows } from "./control.js";
import { cronMatches, parseCron } from "./cron.js";
import { ensureHome, knownProjects, loadConfig, type HomePaths, type Place } from "./home.js";
import { createRun, logFile, startWorker } from "./launch.js";
import { notify } from "./notify.js";
import { listRecords, processAlive, snapshotFile, type RunRecord } from "./records.js";
import { managerFor } from "./worker.js";

export interface Schedule {
  name: string;
  workflow: string;
  projectDir: string;
  cron: string;
  inputs: Record<string, unknown>;
  place?: Place;
  enabled: boolean;
  createdAt: string;
  /** Set on a schedule read from a workflow file's meta. Its name is the file's path. */
  fromFile?: boolean;
}

interface DaemonState {
  /** The minute each schedule last fired, as YYYY-MM-DDTHH:MM. */
  fired: Record<string, string>;
  /** Automatic resumes tried per run. */
  resumes: Record<string, { count: number; lastAt: string }>;
  /** Runs cut off by a crash or a restart that the user was told about. */
  told?: Record<string, string>;
  lastPrune?: string;
  lastGc?: string;
}

function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, file);
}

export function loadSchedules(paths: HomePaths): Schedule[] {
  return readJson<Schedule[]>(paths.schedules, []);
}

export function saveSchedules(paths: HomePaths, schedules: Schedule[]): void {
  writeJson(paths.schedules, schedules);
}

/**
 * The schedules set in workflow files: those of the home folder, which run in a scratch folder,
 * and those of each project where orc ran. A file with a problem in its meta has none; `orc check`
 * shows the problem.
 */
export function fileSchedules(paths: HomePaths): Schedule[] {
  const out: Schedule[] = [];
  const read = (dir: string, projectDir: string, place?: Place) => {
    for (const entry of openWorkflowDir(dir).list()) {
      const extras = entry.extras;
      if (!extras?.schedule || extras.metaProblems?.length) continue;
      out.push({
        name: entry.file,
        workflow: entry.file,
        projectDir,
        cron: extras.schedule.cron,
        inputs: extras.schedule.inputs,
        ...(place ? { place } : {}),
        enabled: true,
        createdAt: "",
        fromFile: true,
      });
    }
  };
  if (existsSync(paths.workflows)) read(paths.workflows, paths.home, "none");
  for (const projectDir of knownProjects(paths)) {
    const dir = join(projectDir, ".orchestrator", "workflows");
    if (existsSync(dir)) read(dir, projectDir);
  }
  return out;
}

function minuteKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const UNFINISHED: RunStatus[] = ["pending", "running", "paused"];
const RETRY_LIMIT_MS = 15 * 60 * 1000;
const NO_HINT_WAIT_MS = 30 * 60 * 1000;

/** When a usage-limit pause can resume. "Resets at <time>" gives it; otherwise 30 minutes after the pause. */
export function resumeTime(resetHint: string | undefined, pausedAt: string): number {
  const match = resetHint ? /Resets at (\S+)/.exec(resetHint) : null;
  const at = match ? Date.parse(match[1]!) : Number.NaN;
  if (Number.isFinite(at)) return at + 30_000;
  const hours = resetHint ? /in ~?(\d+(?:\.\d+)?)\s*h/i.exec(resetHint) : null;
  if (hours) return Date.parse(pausedAt) + Number(hours[1]) * 3600_000 + 30_000;
  return Date.parse(pausedAt) + NO_HINT_WAIT_MS;
}

export interface TickDeps {
  now?: Date;
  log?: (line: string) => void;
  spawn?: (runId: string, mode: "start" | "resume") => void;
  notify?: (title: string, body: string) => void;
}

export function tick(paths: HomePaths, cliFile: string, deps: TickDeps = {}): void {
  const now = deps.now ?? new Date();
  const log = deps.log ?? ((line: string) => process.stdout.write(`${new Date().toISOString()} ${line}\n`));
  const spawnRun = deps.spawn ?? ((runId: string, mode: "start" | "resume") => startWorker(paths, cliFile, runId, mode));
  const state = readJson<DaemonState>(paths.daemonState, { fired: {}, resumes: {} });
  const config = loadConfig(paths);
  const tell = deps.notify ?? ((title: string, body: string) => notify(title, body, config.notify));
  state.told ??= {};
  const records = listRecords(paths);
  const managers = new Map<string, ReturnType<typeof managerFor>>();
  const manager = (projectDir: string) => {
    let found = managers.get(projectDir);
    if (!found) managers.set(projectDir, (found = managerFor(paths, projectDir)));
    return found;
  };
  const statusOf = (record: RunRecord) => {
    const m = manager(record.projectDir);
    let persisted = m.getPersistence().load(record.runId) ?? undefined;
    if (persisted && (persisted.status === "running" || persisted.status === "pending") && !processAlive(record.pid)) {
      persisted = m.reconcileExternallyDeadRun(record.runId) ?? persisted;
    }
    return persisted;
  };

  // Schedules.
  const key = minuteKey(now);
  let schedules = loadSchedules(paths);
  try {
    schedules = [...schedules, ...fileSchedules(paths)];
  } catch (error) {
    log(`could not read the schedules in workflow files: ${(error as Error).message}`);
  }
  for (const schedule of schedules) {
    if (!schedule.enabled || state.fired[schedule.name] === key) continue;
    let cron;
    try {
      cron = parseCron(schedule.cron);
    } catch (error) {
      log(`schedule ${schedule.name}: ${(error as Error).message}`);
      continue;
    }
    if (!cronMatches(cron, now)) continue;
    state.fired[schedule.name] = key;
    const last = records.find((record) => record.schedule === schedule.name);
    if (last) {
      const status = statusOf(last)?.status;
      if (processAlive(last.pid) || (status && UNFINISHED.includes(status))) {
        log(`schedule ${schedule.name}: skipped, run ${last.runId} has not finished (${status ?? "running"})`);
        continue;
      }
    }
    try {
      const record = createRun(paths, {
        workflow: schedule.workflow,
        projectDir: schedule.projectDir,
        inputs: schedule.inputs,
        ...(schedule.place ? { place: schedule.place } : {}),
        priority: "schedule",
        origin: "schedule",
        schedule: schedule.name,
      });
      spawnRun(record.runId, "start");
      log(`schedule ${schedule.name}: started run ${record.runId}`);
    } catch (error) {
      log(`schedule ${schedule.name}: could not start: ${(error as Error).message}`);
    }
  }

  // Automatic resumes.
  for (const record of records) {
    if (processAlive(record.pid)) continue;
    const persisted = statusOf(record);
    if (persisted?.status !== "paused") {
      delete state.resumes[record.runId];
      delete state.told[record.runId];
      continue;
    }
    if (persisted.pauseReason === "interrupted") {
      // A run cut off by a crash or a restart never starts again on its own.
      if (!state.told[record.runId]) {
        state.told[record.runId] = now.toISOString();
        log(`run ${record.runId} was cut off. orc resume ${record.runId} goes on from there.`);
        tell(`${record.workflow} was cut off`, `orc resume ${record.runId} goes on from where it stopped`);
      }
      continue;
    }
    const tried = state.resumes[record.runId];
    if (tried && now.getTime() - Date.parse(tried.lastAt) < RETRY_LIMIT_MS) continue;
    let due = false;
    if (persisted.pauseReason === "usage_limit") {
      due = now.getTime() >= resumeTime(persisted.resetHint, persisted.updatedAt);
    }
    if (!due) continue;
    // An edit reaches a run only when the user says so, as with `orc resume`.
    const changed = record.resumeLatest ? [] : changedWorkflows(paths, record, persisted);
    if (changed.length) {
      if (!state.told[record.runId]) {
        state.told[record.runId] = now.toISOString();
        const text = `${changed.join(", ")} changed since ${record.runId} started. orc resume ${record.runId} --latest takes the new version, orc resume ${record.runId} --same goes on with the old one.`;
        log(text);
        tell(`${record.workflow} did not resume`, text);
      }
      continue;
    }
    state.resumes[record.runId] = { count: (tried?.count ?? 0) + 1, lastAt: now.toISOString() };
    spawnRun(record.runId, "resume");
    log(`resumed run ${record.runId} (${persisted.pauseReason})`);
  }

  // Pruning.
  if (config.keepDays !== undefined && (!state.lastPrune || now.getTime() - Date.parse(state.lastPrune) > 3600_000)) {
    state.lastPrune = now.toISOString();
    const removed = prune(paths, config.keepDays, now);
    if (removed.length) log(`pruned ${removed.length} finished runs older than ${config.keepDays} days`);
  }

  // Merged worktrees.
  if (!state.lastGc || now.getTime() - Date.parse(state.lastGc) > 3600_000) {
    state.lastGc = now.toISOString();
    try {
      const projects = [...new Set(records.map((record) => record.projectDir))];
      const { removed } = gcWorktrees(paths, projects, { busy: busyWorktrees(paths, records) });
      for (const entry of removed) log(`removed worktree ${entry.dir} (${entry.reason})`);
    } catch (error) {
      log(`worktree cleanup failed: ${(error as Error).message}`);
    }
  }

  writeJson(paths.daemonState, state);
}

/** The runs that have not finished: a worker runs them, or they wait paused. */
export function unfinishedRuns(paths: HomePaths, records = listRecords(paths)): Set<string> {
  const ids = new Set<string>();
  for (const record of records) {
    // A run with no state yet is about to start.
    const status = managerFor(paths, record.projectDir).getPersistence().load(record.runId)?.status;
    if (processAlive(record.pid) || !status || UNFINISHED.includes(status)) ids.add(record.runId);
  }
  return ids;
}

/** The worktrees of the runs that have not finished, borrowed ones included. gc keeps these. */
export function busyWorktrees(paths: HomePaths, records = listRecords(paths)): Set<string> {
  const unfinished = unfinishedRuns(paths, records);
  const dirs = new Set<string>();
  for (const record of records) {
    if (!unfinished.has(record.runId)) continue;
    if (record.worktree) dirs.add(record.worktree);
    for (const tree of runWorktrees(record)) dirs.add(tree.dir);
  }
  return dirs;
}

/** Delete a run's saved state, record, workflow snapshot and logs. Its worktrees stay. */
export function forgetRun(paths: HomePaths, record: RunRecord): void {
  managerFor(paths, record.projectDir).deleteRun(record.runId);
  // The engine keeps its own copy of the log, in a folder named after where the run worked.
  const engineLogs = workflowProjectPaths(record.cwd, { persistenceRoot: paths.runs });
  const files = [`${paths.records}/${record.runId}.json`, snapshotFile(paths, record.runId), logFile(paths, record.runId), join(engineLogs.runsDir, `${record.runId}.log`)];
  for (const file of files) {
    try {
      unlinkSync(file);
    } catch {
      // already gone
    }
  }
  for (const dir of [engineLogs.runsDir, engineLogs.rootDir]) {
    try {
      rmdirSync(dir);
    } catch {
      // not empty, or gone
    }
  }
}

/** Remove finished runs older than `days`: the engine's state, orc's record and the log. Worktrees stay. */
export function prune(paths: HomePaths, days: number, now = new Date()): string[] {
  const cutoff = now.getTime() - days * 86_400_000;
  const removed: string[] = [];
  for (const record of listRecords(paths)) {
    if (Date.parse(record.createdAt) > cutoff || processAlive(record.pid)) continue;
    const m = managerFor(paths, record.projectDir);
    const status = m.getPersistence().load(record.runId)?.status;
    if (status && UNFINISHED.includes(status)) continue;
    forgetRun(paths, record);
    removed.push(record.runId);
  }
  return removed;
}

export function daemonPid(paths: HomePaths): number | undefined {
  const pid = Number(readJson<{ pid?: number }>(paths.daemonPid, {}).pid);
  return Number.isInteger(pid) && processAlive(pid) ? pid : undefined;
}

/** The service loop, run by `orc daemon run`. */
export async function daemonMain(paths: HomePaths, cliFile: string, everyMs = 20_000): Promise<void> {
  ensureHome(paths);
  const existing = daemonPid(paths);
  if (existing && existing !== process.pid) throw new Error(`the service already runs (pid ${existing})`);
  writeJson(paths.daemonPid, { pid: process.pid, since: new Date().toISOString() });
  let running = true;
  const stop = () => {
    running = false;
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.stdout.write(`${new Date().toISOString()} service started\n`);
  while (running) {
    try {
      tick(paths, cliFile);
    } catch (error) {
      process.stdout.write(`${new Date().toISOString()} tick failed: ${(error as Error).stack ?? String(error)}\n`);
    }
    for (let waited = 0; running && waited < everyMs; waited += 500) await new Promise((r) => setTimeout(r, 500));
  }
  try {
    unlinkSync(paths.daemonPid);
  } catch {
    // already gone
  }
  process.stdout.write(`${new Date().toISOString()} service stopped\n`);
}
