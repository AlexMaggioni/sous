// The background service: `sous daemon start`. Every 20 seconds it
//  - starts scheduled runs, and skips one when the schedule's last run has not finished. A
//    schedule comes from `sous schedule add`, or from `schedule` in a workflow file's meta, in the
//    home folder or in a project where sous ran. A workflow edited since the person approved it
//    does not start: the service logs it each time the schedule comes due, and tells the person
//    once for each edit. At its start, as at the first command, sous takes the workflows it finds
//    as approved, once per home;
//  - resumes runs paused at the subscription limit once the limit resets, unless a workflow they
//    use was edited since they started. Then it tells the user once and waits for `sous resume`;
//  - tells the user, once, about a run cut off by a crash or a restart. It waits for `sous resume`;
//  - removes finished runs older than keepDays, when config.json sets it;
//  - once an hour, removes the worktrees whose branch was merged and that have nothing uncommitted.

import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { readJsonFile, writeJsonFile } from "../json-file.js";
import { openWorkflowDir } from "../workflows/dir.js";
import { recordAction, SERVICE } from "./actions.js";
import { cronMatches, parseCron } from "./cron.js";
import { ensureHome, knownProjects, loadConfig, type HomePaths, type Place } from "./home.js";
import { NotApproved } from "./approval-check.js";
import { seedApprovals } from "./approvals.js";
import { createRun, type Launcher } from "./launch.js";
import { notify } from "./notify.js";
import { processAlive } from "./records.js";
import { word } from "./refusal.js";
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
  /** The schedules the person was told need their yes, with the hashes of the texts it was for. */
  approvalsTold?: Record<string, string>;
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
 * and those of each project where sous ran. A file with a problem in its meta has none; `sous check`
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
    const dir = join(projectDir, ".sous", "workflows");
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
    // The log names the status sous list shows: a run its worker left running reads paused.
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
        // The person added the schedule, so sous starts it, whatever markers the service has.
        who: { by: "sous", through: { kind: "schedule", schedule: schedule.name } },
      });
      launch(paths, record.runId, "start");
      log(`schedule ${schedule.name}: started run ${record.runId}`);
      if (state.approvalsTold) delete state.approvalsTold[schedule.name];
    } catch (error) {
      log(`schedule ${schedule.name}: could not start: ${(error as Error).message}`);
      // The person approves the edited text once, or runs it once by hand, and the next time goes.
      // They hear of each edit once, however often the schedule comes due.
      const hashes = error instanceof NotApproved ? error.texts.map((text) => text.hash).join(",") : undefined;
      if (error instanceof NotApproved && state.approvalsTold?.[schedule.name] !== hashes) {
        (state.approvalsTold ??= {})[schedule.name] = hashes!;
        const project = schedule.projectDir === paths.home ? "" : ` --project ${word(schedule.projectDir)}`;
        const approve = error.texts.map((text) => `sous workflows approve ${word(text.workflow)}${project}`).join(", then ");
        const names = error.texts.map((text) => text.workflow).join(", ");
        tell(`${error.workflow} needs your approval`, `The schedule ${schedule.name} did not start ${schedule.workflow}, because ${names} is new or changed since you approved it. ${approve} lets it start.`);
      }
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
    // Nor does a dry run, which `sous check --dry-run` runs again.
    if (!run.resume.ok && (run.resume.why === "older" || run.resume.why === "dry-run")) continue;
    if (pause.reason === "interrupted") {
      // A run cut off by a crash or a restart never starts again on its own.
      if (!state.told[record.runId]) {
        state.told[record.runId] = now.toISOString();
        log(`run ${record.runId} was cut off. sous resume ${record.runId} goes on from there.`);
        tell(`${record.workflow} was cut off`, `sous resume ${record.runId} goes on from where it stopped`);
      }
      continue;
    }
    const tried = state.resumes[record.runId];
    if (tried && now.getTime() - Date.parse(tried.lastAt) < RETRY_LIMIT_MS) continue;
    // Only a run paused at the usage limit has a time to resume by itself.
    const due = pause.resumeAt !== undefined && now.getTime() >= pause.resumeAt.getTime();
    if (!due) continue;
    // An edit reaches a run only when the user says so, as with `sous resume`.
    const persisted = readState(paths, record.runId);
    if (!persisted) continue;
    const changed = record.resumeLatest ? [] : changedWorkflows(paths, record, persisted);
    if (changed.length) {
      if (!state.told[record.runId]) {
        state.told[record.runId] = now.toISOString();
        const text = `${changed.join(", ")} changed since ${record.runId} started. sous resume ${record.runId} --latest takes the new version, sous resume ${record.runId} --same goes on with the old one.`;
        log(text);
        tell(`${record.workflow} did not resume`, text);
      }
      continue;
    }
    state.resumes[record.runId] = { count: (tried?.count ?? 0) + 1, lastAt: now.toISOString() };
    launch(paths, record.runId, "resume");
    recordAction(paths, { act: "resume", ...SERVICE, runId: record.runId, workflow: record.workflow });
    log(`resumed run ${record.runId} (${persisted.pauseReason})`);
  }

  // Pruning.
  if (config.keepDays !== undefined && (!state.lastPrune || now.getTime() - Date.parse(state.lastPrune) > 3600_000)) {
    state.lastPrune = now.toISOString();
    const removed = pruneRuns(paths, config.keepDays, SERVICE, now);
    if (removed.length) log(`pruned ${removed.length} finished runs older than ${config.keepDays} days`);
  }

  // Merged worktrees.
  if (!state.lastGc || now.getTime() - Date.parse(state.lastGc) > 3600_000) {
    state.lastGc = now.toISOString();
    try {
      const { removed } = gcRuns(paths, SERVICE, { runs });
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

/** The service loop, run by `sous daemon run`. */
export async function daemonMain(paths: HomePaths, launch: Launcher, everyMs = 20_000): Promise<void> {
  ensureHome(paths);
  // The service may run before any command, so it takes the workflows it finds as approved first.
  try {
    seedApprovals(paths);
  } catch (error) {
    process.stdout.write(`${new Date().toISOString()} ${(error as Error).message}\n`);
  }
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
