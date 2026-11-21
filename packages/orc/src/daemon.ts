// The background service: `orc daemon start`. Every 20 seconds it
//  - starts scheduled runs, and skips one when the schedule's last run has not finished;
//  - resumes runs paused at the subscription limit once the limit resets, and runs cut off
//    by a crash or a restart;
//  - removes finished runs older than keepDays, when config.json sets it.

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import type { RunStatus } from "@automatalabs/shared-types";
import { cronMatches, parseCron } from "./cron.js";
import { ensureHome, loadConfig, type HomePaths, type Place } from "./home.js";
import { createRun, logFile, spawnWorker } from "./launch.js";
import { listRecords, processAlive, updateRecord, type RunRecord } from "./records.js";
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
}

interface DaemonState {
  /** The minute each schedule last fired, as YYYY-MM-DDTHH:MM. */
  fired: Record<string, string>;
  /** Automatic resumes tried per run. */
  resumes: Record<string, { count: number; lastAt: string }>;
  lastPrune?: string;
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
}

export function tick(paths: HomePaths, deps: TickDeps = {}): void {
  const now = deps.now ?? new Date();
  const log = deps.log ?? ((line: string) => process.stdout.write(`${new Date().toISOString()} ${line}\n`));
  const spawnRun = deps.spawn ?? ((runId: string, mode: "start" | "resume") => {
    const pid = spawnWorker(paths, runId, mode);
    updateRecord(paths, runId, { pid });
  });
  const state = readJson<DaemonState>(paths.daemonState, { fired: {}, resumes: {} });
  const config = loadConfig(paths);
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
  for (const schedule of loadSchedules(paths)) {
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
      continue;
    }
    const tried = state.resumes[record.runId];
    if (tried && now.getTime() - Date.parse(tried.lastAt) < RETRY_LIMIT_MS) continue;
    let due = false;
    if (persisted.pauseReason === "usage_limit") {
      due = now.getTime() >= resumeTime(persisted.resetHint, persisted.updatedAt);
    } else if (persisted.pauseReason === "interrupted") {
      due = (tried?.count ?? 0) < 3;
    }
    if (!due) continue;
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

  writeJson(paths.daemonState, state);
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
    m.deleteRun(record.runId);
    for (const file of [`${paths.records}/${record.runId}.json`, logFile(paths, record.runId)]) {
      try {
        unlinkSync(file);
      } catch {
        // already gone
      }
    }
    removed.push(record.runId);
  }
  return removed;
}

export function daemonPid(paths: HomePaths): number | undefined {
  const pid = Number(readJson<{ pid?: number }>(paths.daemonPid, {}).pid);
  return Number.isInteger(pid) && processAlive(pid) ? pid : undefined;
}

/** The service loop, run by `orc daemon run`. */
export async function daemonMain(paths: HomePaths, everyMs = 20_000): Promise<void> {
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
      tick(paths);
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
