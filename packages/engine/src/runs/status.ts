// sous status: what in the home needs the person, what runs, what waits on its own and what
// finished. It reads the runs once and writes nothing.

import type { HomePaths } from "./home.js";
import type { Who } from "./actions.js";
import { answeredByFor } from "./consent.js";
import { answerCallsFor, listRuns, runDetail } from "./run.js";
import { daemonPid } from "./service.js";

export interface HomeStatus {
  needsYou: Array<{ runId: string; workflow: string; what: string; question?: { id: string; prompt: string; answeredBy: "people" | "anyone" }; since: string; call: string; sendBack?: string }>;
  running: Array<{ runId: string; workflow: string; minutes: number; tokens: number; steps: string[] }>;
  waiting: Array<{ runId: string; workflow: string; what: string; resumesAt?: string }>;
  finished: Array<{ runId: string; workflow: string; status: string; at: string; branch?: string }>;
  service: { running: boolean };
  /** The runs that ended before the window, so the lists leave them out. Unset when none did. */
  earlier?: number;
}

/** How far back finished runs show when no --since is given. */
const DAY_MS = 24 * 3600_000;
const UNIT_MS = { m: 60_000, h: 3600_000, d: DAY_MS } as const;

/** The window a --since value names, such as 30m, 12h or 3d, in ms. Undefined when it names none. */
export function sinceWindow(text: string): number | undefined {
  const match = /^(\d+)([mhd])$/.exec(text);
  const count = Number(match?.[1]);
  return match && count > 0 ? count * UNIT_MS[match[2] as keyof typeof UNIT_MS] : undefined;
}

/** The home now. Runs that ended show while they ended within `since`, 24 hours by default. The
 *  answer calls are for `who`, the person when not given. */
export function homeStatus(paths: HomePaths, now: Date, options: { since?: string; who?: Who } = {}): HomeStatus {
  const window = options.since === undefined ? DAY_MS : sinceWindow(options.since);
  if (window === undefined) throw new Error(`--since takes a count and a unit, such as 30m, 12h or 3d, not "${options.since}"`);
  const status: HomeStatus = { needsYou: [], running: [], waiting: [], finished: [], service: { running: daemonPid(paths) !== undefined } };
  let earlier = 0;
  for (const run of listRuns(paths)) {
    const { record, word } = run;
    const base = { runId: record.runId, workflow: record.workflow };
    const at = run.changedAt ?? record.createdAt;
    if (run.status === "asks") {
      for (const q of run.questions) {
        // A caller that cannot reach the person, such as a step of a run, gets no answer call.
        const [call = `sous show ${record.runId} --json`, sendBack] = answerCallsFor(paths, q, options.who);
        status.needsYou.push({ ...base, what: "asks", question: { id: q.id, prompt: q.prompt, answeredBy: answeredByFor(q, record) }, since: q.askedAt, call, ...(sendBack ? { sendBack } : {}) });
      }
    } else if (run.status === "running" || run.status === "pending" || run.status === "starting") {
      const detail = runDetail(paths, record.runId);
      status.running.push({ ...base, minutes: Math.floor((now.getTime() - Date.parse(record.createdAt)) / 60_000), tokens: detail.tokens ?? 0, steps: detail.running });
    } else if (run.pause?.resumeAt) {
      status.waiting.push({ ...base, what: word, resumesAt: run.pause.resumeAt.toISOString() });
    } else if (run.unfinished) {
      status.needsYou.push({ ...base, what: word, since: at, call: `sous show ${record.runId} --json` });
    } else if (now.getTime() - Date.parse(at) > window) {
      earlier++;
    } else if (run.status === "completed") {
      status.finished.push({ ...base, status: run.status, at, ...(record.branch ? { branch: record.branch } : {}) });
    } else {
      status.needsYou.push({ ...base, what: word, since: at, call: `sous show ${record.runId} --json` });
    }
  }
  return earlier ? { ...status, earlier } : status;
}

/** One line for an agent's session start, or "" when nothing needs the person. */
export function statusLine(paths: HomePaths, now: Date): string {
  const runs = new Map<string, string>();
  for (const entry of homeStatus(paths, now).needsYou) runs.set(entry.runId, entry.what);
  if (!runs.size) return "";
  const counts = new Map<string, number>();
  for (const what of runs.values()) {
    const kind = what === "asks" || what === "failed" || what === "stopped" ? what : "paused";
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const parts = [...counts].map(([kind, n]) => `${n} ${n === 1 ? "run" : "runs"} ${VERBS[kind as keyof typeof VERBS][n === 1 ? 0 : 1]}`);
  const listed = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  return `sous: ${listed}. Tell the person, and run sous status for details.`;
}

/** What a run that needs the person did, for one run and for several. */
const VERBS = {
  asks: ["asks a question", "ask questions"],
  failed: ["failed", "failed"],
  stopped: ["stopped", "stopped"],
  paused: ["waits for a person", "wait for a person"],
} as const;
