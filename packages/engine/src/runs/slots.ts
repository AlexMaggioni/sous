// The machine-wide cap on agents running at once. Each running agent holds a slot file.
// Waiting agents queue by priority, then by arrival: a person's run goes before a scheduled one.
// A slot or a ticket whose process has died, or ran in an earlier boot, is removed by the next one
// that looks.

import { closeSync, mkdirSync, openSync, readdirSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { readJsonFile } from "../json-file.js";
import { bootId, processAlive } from "../process-alive.js";

export type Priority = "user" | "schedule";

export interface SlotInfo {
  runId?: string;
  label?: string;
}

/** True while the process that wrote the file runs, in this boot. */
function holderAlive(file: string): boolean {
  const holder = readJsonFile<{ pid?: unknown; boot?: unknown }>(file);
  if (typeof holder?.pid !== "number") return false;
  return processAlive(holder.pid, typeof holder.boot === "string" ? holder.boot : undefined);
}

function removeIfDead(file: string): boolean {
  if (holderAlive(file)) return false;
  try {
    unlinkSync(file);
  } catch {
    // someone else removed it
  }
  return true;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal!.reason ?? new Error("aborted")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

let ticketSeq = 0;

export class SlotPool {
  constructor(
    private readonly slotsDir: string,
    private readonly queueDir: string,
    private readonly cap: () => number,
    private readonly priority: Priority = "user",
    private readonly pollMs = 300,
  ) {
    mkdirSync(slotsDir, { recursive: true });
    mkdirSync(queueDir, { recursive: true });
  }

  /** Slot files held by live processes. */
  held(): string[] {
    const out: string[] = [];
    for (const name of readdirSync(this.slotsDir)) {
      if (!name.endsWith(".json")) continue;
      if (!removeIfDead(join(this.slotsDir, name))) out.push(name);
    }
    return out;
  }

  /** Waiting tickets of live processes, in the order they get a slot. */
  waiting(): string[] {
    const out: string[] = [];
    for (const name of readdirSync(this.queueDir).sort()) {
      if (!name.endsWith(".json")) continue;
      if (!removeIfDead(join(this.queueDir, name))) out.push(name);
    }
    return out;
  }

  private tryTake(info: SlotInfo): string | undefined {
    const cap = Math.max(1, this.cap());
    for (let n = 0; n < cap; n++) {
      const file = join(this.slotsDir, `slot-${n}.json`);
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const fd = openSync(file, "wx");
          writeSync(fd, JSON.stringify({ pid: process.pid, boot: bootId(), ...info, since: new Date().toISOString() }));
          closeSync(fd);
          return file;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if (!removeIfDead(file)) break;
        }
      }
    }
    return undefined;
  }

  /** Wait for a slot. Returns the function that gives it back. */
  async acquire(info: SlotInfo = {}, signal?: AbortSignal): Promise<() => void> {
    const rank = this.priority === "user" ? 0 : 1;
    const ticket = `${rank}-${String(Date.now()).padStart(15, "0")}-${String(process.pid).padStart(8, "0")}-${String(++ticketSeq).padStart(6, "0")}.json`;
    const ticketFile = join(this.queueDir, ticket);
    const fd = openSync(ticketFile, "wx");
    writeSync(fd, JSON.stringify({ pid: process.pid, boot: bootId(), ...info }));
    closeSync(fd);
    try {
      for (;;) {
        signal?.throwIfAborted();
        const free = Math.max(1, this.cap()) - this.held().length;
        const position = this.waiting().indexOf(ticket);
        if (free > 0 && position >= 0 && position < free) {
          const slot = this.tryTake(info);
          if (slot) {
            let released = false;
            return () => {
              if (released) return;
              released = true;
              try {
                unlinkSync(slot);
              } catch {
                // already removed
              }
            };
          }
        }
        await sleep(this.pollMs, signal);
      }
    } finally {
      try {
        unlinkSync(ticketFile);
      } catch {
        // already removed
      }
    }
  }
}
