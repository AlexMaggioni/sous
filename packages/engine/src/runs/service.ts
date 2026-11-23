// The background service: `orc daemon start`. Every 20 seconds it
//  - starts scheduled runs, and skips one when the schedule's last run has not finished. A
//    schedule comes from `orc schedule add`, or from `schedule` in a workflow file's meta, in the
//    home folder or in a project where orc ran;
//  - resumes runs paused at the subscription limit once the limit resets, unless a workflow they
//    use was edited since they started. Then it tells the user once and waits for `orc resume`;
//  - tells the user, once, about a run cut off by a crash or a restart. It waits for `orc resume`;
//  - removes finished runs older than keepDays, when config.json sets it;
//  - once an hour, removes the worktrees whose branch was merged and that have nothing uncommitted.

import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { readJsonFile, writeJsonFile } from "../json-file.js";
import { openWorkflowDir } from "../workflows/dir.js";
import { cronMatches, parseCron } from "./cron.js";
import { ensureHome, knownProjects, loadConfig, type HomePaths, type Place } from "./home.js";
import { createRun, type Launcher } from "./launch.js";
import { notify } from "./notify.js";
import { processAlive } from "./records.js";
import { readState } from "./store.js";
import { changedWorkflows, gcRuns, listRuns, pruneRuns, startedAndUnfinished, workerRuns } from "./run.js";

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

export function loadSchedules(paths: HomePaths): Schedule[] {
  return readJsonFile<Schedule[]>(paths.schedules) ?? [];
}

export function saveSchedules(paths: HomePaths, schedules: Schedule[]): void {
  writeJsonFile(paths.schedules, schedules);
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

const RETRY_LIMIT_MS = 15 * 60 * 1000;

export interface TickDeps {
  now?: Date;
  log?: (line: string) => void;
  notify?: (title: string, body: string) => void;
}

export function tick(paths: HomePaths, launch: Launcher, deps: TickDeps = {}): void {
  const now = deps.now ?? new Date();
  const log = deps.log ?? ((line: string) => process.stdout.write(`${new Date().toISOString()} ${line}\n`));
  const state = readJsonFile<DaemonState>(paths.daemonState) ?? { fired: {}, resumes: {} };
  const config = loadConfig(paths);
  const tell = deps.notify ?? ((title: string, body: string) => notify(title, body, config.notify));
  state.told ??= {};
  const runs = listRuns(paths);

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
    const last = runs.find((run) => run.record.schedule === schedule.name);
    // The log names the status orc list shows: a run its worker left running reads paused.
    if (last && startedAndUnfinished(last)) {
      log(`schedule ${schedule.name}: skipped, run ${last.runId} has not finished (${last.saved?.status ?? "running"})`);
      continue;
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
      launch(paths, record.runId, "start");
      log(`schedule ${schedule.name}: started run ${record.runId}`);
    } catch (error) {
      log(`schedule ${schedule.name}: could not start: ${(error as Error).message}`);
    }
  }

  // Automatic resumes.
  for (const run of runs) {
    if (workerRuns(run)) continue;
    // The rule reads a run left running by a worker that died as interrupted.
    const { record, pause } = run;
    if (!pause) {
      delete state.resumes[record.runId];
      delete state.told[record.runId];
      continue;
    }
    // A run older code saved never goes on, so the service neither tells of it nor resumes it.
    if (!run.resume.ok && run.resume.why === "older") continue;
    if (pause.reason === "interrupted") {
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
    // Only a run paused at the usage limit has a time to resume by itself.
    const due = pause.resumeAt !== undefined && now.getTime() >= pause.resumeAt.getTime();
    if (!due) continue;
    // An edit reaches a run only when the user says so, as with `orc resume`.
    const persisted = readState(paths, record.runId);
    if (!persisted) continue;
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
    launch(paths, record.runId, "resume");
    log(`resumed run ${record.runId} (${persisted.pauseReason})`);
  }

  // Pruning.
  if (config.keepDays !== undefined && (!state.lastPrune || now.getTime() - Date.parse(state.lastPrune) > 3600_000)) {
    state.lastPrune = now.toISOString();
    const removed = pruneRuns(paths, config.keepDays, now);
    if (removed.length) log(`pruned ${removed.length} finished runs older than ${config.keepDays} days`);
  }

  // Merged worktrees.
  if (!state.lastGc || now.getTime() - Date.parse(state.lastGc) > 3600_000) {
    state.lastGc = now.toISOString();
    try {
      const { removed } = gcRuns(paths, { runs });
      for (const entry of removed) log(`removed worktree ${entry.dir} (${entry.reason})`);
    } catch (error) {
      log(`worktree cleanup failed: ${(error as Error).message}`);
    }
  }

  writeJsonFile(paths.daemonState, state);
}

export function daemonPid(paths: HomePaths): number | undefined {
  const pid = Number(readJsonFile<{ pid?: number }>(paths.daemonPid)?.pid);
  return Number.isInteger(pid) && processAlive(pid) ? pid : undefined;
}

/** The service loop, run by `orc daemon run`. */
export async function daemonMain(paths: HomePaths, launch: Launcher, everyMs = 20_000): Promise<void> {
  ensureHome(paths);
  const existing = daemonPid(paths);
  if (existing && existing !== process.pid) throw new Error(`the service already runs (pid ${existing})`);
  writeJsonFile(paths.daemonPid, { pid: process.pid, since: new Date().toISOString() });
  let running = true;
  const stop = () => {
    running = false;
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.stdout.write(`${new Date().toISOString()} service started\n`);
  while (running) {
    try {
      tick(paths, launch);
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
