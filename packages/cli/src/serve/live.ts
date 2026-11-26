// GET /api/live: what changed in the home, for the pages open on it. While at least one page
// listens, the feed reads stamps of the home every half second: each run's files, the question
// files, the saved workflow folders, and less often the agents, skills and MCP servers. A stamp
// that differs from the last read sends one "changed" event, and a read that finds nothing
// changed sends nothing.

import { readRun, runStamps, type HomePaths } from "@sous-run/engine";
import type { LiveEvent } from "@sous-run/view";

/** One read of the home's stamps. */
export interface HomeStamps {
  runs: Map<string, string>;
  /** The question files' stamps, by the run that asks them. */
  questions: Map<string, string>;
  workflows: string;
  catalog: string;
}

/** What the server reads besides the runs: the stamps of the workflow folders and of the catalog. */
export interface LiveReads {
  workflows(): string;
  catalog(): string;
}

/** A page that listens. */
export interface Listener {
  send(event: LiveEvent): void;
  /** A comment line that keeps the connection open. */
  ping(): void;
}

export interface LiveTimes {
  /** How often the feed reads the stamps. */
  pollMs: number;
  /** How often it reads the catalog, which costs more. */
  catalogMs: number;
  pingMs: number;
}

const TIMES: LiveTimes = { pollMs: 500, catalogMs: 3000, pingMs: 15_000 };

/** What changed between two reads, or undefined when nothing did. `words` holds each run's status
 *  word as last read, so that a run whose status moves also changes the workflow rows. */
function changesBetween(before: HomeStamps, after: HomeStamps, word: (runId: string) => string | undefined, words: Map<string, string>): Extract<LiveEvent, { type: "changed" }> | undefined {
  const runs = new Set<string>();
  for (const [id, stamp] of after.runs) if (before.runs.get(id) !== stamp) runs.add(id);
  for (const id of before.runs.keys()) if (!after.runs.has(id)) runs.add(id);
  let questions = false;
  for (const runId of new Set([...before.questions.keys(), ...after.questions.keys()])) {
    if (before.questions.get(runId) === after.questions.get(runId)) continue;
    questions = true;
    if (after.runs.has(runId) || before.runs.has(runId)) runs.add(runId);
  }
  // A workflow row shows its last run's status, so a run that starts, ends or is removed changes it.
  let moved = false;
  for (const id of runs) {
    const now = after.runs.has(id) ? word(id) : undefined;
    if (!before.runs.has(id) || words.get(id) !== now) moved = true;
    if (now === undefined) words.delete(id);
    else words.set(id, now);
  }
  const workflows = moved || before.workflows !== after.workflows;
  const catalog = before.catalog !== after.catalog;
  if (!runs.size && !questions && !workflows && !catalog) return undefined;
  return { type: "changed", runs: [...runs], questions, workflows, catalog };
}

/** The feed of one server. It reads the home only while a page listens. */
export class LiveFeed {
  private readonly listeners = new Set<Listener>();
  private readonly words = new Map<string, string>();
  private readonly times: LiveTimes;
  private last: HomeStamps | undefined;
  private catalogAt = 0;
  private poll: ReturnType<typeof setInterval> | undefined;
  private pings: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly paths: HomePaths,
    private readonly reads: LiveReads,
    times: Partial<LiveTimes> = {},
  ) {
    this.times = { ...TIMES, ...times };
  }

  /** Add a page. It gets "hello" at once. Returns its removal. */
  add(listener: Listener): () => void {
    const remove = () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.stop();
    };
    this.listeners.add(listener);
    try {
      listener.send({ type: "hello", at: new Date().toISOString() });
      if (this.listeners.size === 1) this.start();
    } catch (error) {
      // A page that never started must not stay, or the next page would find the feed stopped.
      remove();
      throw error;
    }
    return remove;
  }

  /** Stop reading the home. The pages stay until the server closes them. */
  close(): void {
    this.listeners.clear();
    this.stop();
  }

  private start(): void {
    this.last = this.read(this.last);
    this.poll = setInterval(() => this.tick(), this.times.pollMs);
    this.pings = setInterval(() => {
      for (const listener of this.listeners) listener.ping();
    }, this.times.pingMs);
  }

  private stop(): void {
    clearInterval(this.poll);
    clearInterval(this.pings);
    this.poll = this.pings = undefined;
    this.last = undefined;
  }

  /** The home's stamps. The catalog is read again only once catalogMs passed. */
  private read(before: HomeStamps | undefined): HomeStamps {
    const { runs, questions } = runStamps(this.paths);
    const due = !before || Date.now() - this.catalogAt >= this.times.catalogMs;
    if (due) this.catalogAt = Date.now();
    return { runs, questions, workflows: this.reads.workflows(), catalog: due ? this.reads.catalog() : before.catalog };
  }

  private tick(): void {
    if (!this.last) return;
    let next: HomeStamps;
    try {
      next = this.read(this.last);
    } catch {
      // A read that fails, such as a folder that moves, waits for the next tick.
      return;
    }
    const event = changesBetween(this.last, next, (runId) => this.word(runId), this.words);
    this.last = next;
    if (event) for (const listener of this.listeners) listener.send(event);
  }

  private word(runId: string): string | undefined {
    try {
      return readRun(this.paths, runId).word;
    } catch {
      return undefined;
    }
  }
}
