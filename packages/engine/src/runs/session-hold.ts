// The hold on a session: one file per run and session that names the process writing to that
// session now. A program's session takes one writer at a time. The worker holds a session while a
// step's turn runs in it, and `sous join` holds it while the person works in it. A step whose
// session the person holds waits until the person leaves, and `sous join` waits until the turn
// that runs now has its prompt. A holder whose process has ended holds nothing.
//
// A take links a full file into place, so a reader never sees half a holder. A hand-over renames
// a full file over the old one.

import { linkSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { HomePaths } from "./home.js";
import { processAlive } from "../process-alive.js";
import { holdFile } from "./store.js";

/** Who holds a session: the process, whether a step or a person who joined, when, and the step's label. */
export interface Holder {
  pid: number;
  by: "step" | "join";
  at: string;
  label?: string;
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function parse(text: string | undefined): Holder | undefined {
  if (text === undefined) return undefined;
  try {
    const holder = JSON.parse(text) as Partial<Holder>;
    return typeof holder.pid === "number" && (holder.by === "step" || holder.by === "join") ? (holder as Holder) : undefined;
  } catch {
    return undefined;
  }
}

/** The live holder of a session, or undefined when the file is missing, broken, or its process has ended. */
export function readHolder(file: string): Holder | undefined {
  const holder = parse(readText(file));
  return holder && processAlive(holder.pid) ? holder : undefined;
}

/** A full copy of `holder` beside `file`, for a link or a rename. */
function stage(file: string, holder: Holder): string {
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}`;
  writeFileSync(temp, JSON.stringify(holder), { mode: 0o600 });
  return temp;
}

function unlinkQuietly(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // gone already
  }
}

/** Remove a holder that holds nothing. It moves the file aside first, and puts it back when it is
 *  not the one that was read, so a holder that took the session meanwhile keeps it. */
function clearStale(file: string, seen: string | undefined): void {
  const aside = `${file}.${process.pid}.stale`;
  try {
    renameSync(file, aside);
  } catch {
    return;
  }
  if (readText(aside) !== seen) {
    try {
      linkSync(aside, file);
    } catch {
      // Another holder took the session since. It keeps it.
    }
  }
  unlinkQuietly(aside);
}

/** Take the session for `holder`. It returns undefined when taken, or the live holder that keeps it. */
export function takeHold(file: string, holder: Holder): Holder | undefined {
  for (let attempt = 0; attempt < 5; attempt++) {
    const temp = stage(file, holder);
    try {
      linkSync(temp, file);
      return undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      unlinkQuietly(temp);
    }
    const seen = readText(file);
    const live = parse(seen);
    if (live && processAlive(live.pid)) return live;
    clearStale(file, seen);
  }
  return readHolder(file) ?? { pid: 0, by: "step", at: new Date().toISOString() };
}

/** Hand the session from `from` to `to`. It is handed when `from` holds it or nobody does, and it
 *  returns undefined then, or the live holder that keeps it. */
function giveHold(file: string, from: number, to: Holder): Holder | undefined {
  const live = readHolder(file);
  if (live && live.pid !== from) return live;
  renameSync(stage(file, to), file);
  return undefined;
}

/** Let go of the session, when `pid` holds it. */
export function releaseHold(file: string, pid: number): void {
  if (parse(readText(file))?.pid === pid) unlinkQuietly(file);
}

/** The holds of one process, bound to a home. The steps module takes these. */
export interface SessionHolds {
  /** How long a step waits between two looks at a session the person holds. */
  pollMs: number;
  held(runId: string, sessionId: string): Holder | undefined;
  /** Take the session for a step. Undefined when taken, or the holder that keeps it. */
  take(runId: string, sessionId: string, label?: string): Holder | undefined;
  /** Hand a session this process holds, or nobody holds, to the person's `sous join`. */
  give(runId: string, sessionId: string, pid: number): Holder | undefined;
  release(runId: string, sessionId: string): void;
}

export function sessionHolds(paths: HomePaths, options: { pid?: number; pollMs?: number } = {}): SessionHolds {
  const pid = options.pid ?? process.pid;
  const at = () => new Date().toISOString();
  return {
    pollMs: options.pollMs ?? 250,
    held: (runId, sessionId) => readHolder(holdFile(paths, runId, sessionId)),
    take: (runId, sessionId, label) => takeHold(holdFile(paths, runId, sessionId), { pid, by: "step", at: at(), ...(label === undefined ? {} : { label }) }),
    give: (runId, sessionId, to) => giveHold(holdFile(paths, runId, sessionId), pid, { pid: to, by: "join", at: at() }),
    release: (runId, sessionId) => releaseHold(holdFile(paths, runId, sessionId), pid),
  };
}
