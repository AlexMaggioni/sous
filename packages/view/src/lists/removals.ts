import { useSyncExternalStore } from "react";
import { SousError } from "../api/client.ts";
import { toast } from "../ui/toast.tsx";

// Removing a run that ended. The row leaves at once and a toast offers Undo for 8 seconds. Only
// then does the delete go out. Undo puts the row back and sends nothing. The store lives outside
// React, so the delete still goes out when the person leaves the runs list in the meantime.

/** How long Undo can bring a run back before the delete goes out. The toast lasts as long. */
const UNDO_MS = 8000;

let hidden: ReadonlySet<string> = new Set();
const waiting = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

function setHidden(id: string, on: boolean): void {
  const next = new Set(hidden);
  if (on) next.add(id);
  else next.delete(id);
  hidden = next;
  for (const listener of listeners) listener();
}

/** The ids of the runs the person removed in this visit, the ones still in their 8 seconds included. */
export function useHiddenRuns(): ReadonlySet<string> {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => hidden,
  );
}

type Removable = { id: string; title: string };

function undo(run: Removable): void {
  const timer = waiting.get(run.id);
  if (timer === undefined) {
    toast(`${run.title} is gone already, so Undo can't bring it back`);
    return;
  }
  clearTimeout(timer);
  waiting.delete(run.id);
  setHidden(run.id, false);
}

/**
 * Hides the run now, and calls `send` with its id once Undo had its 8 seconds. When `send` fails,
 * the row comes back and a toast says why.
 */
export function removeLater(run: Removable, send: (id: string) => Promise<unknown>): void {
  if (hidden.has(run.id)) return;
  setHidden(run.id, true);
  const timer = setTimeout(() => {
    waiting.delete(run.id);
    send(run.id).catch((error: unknown) => {
      setHidden(run.id, false);
      const call = error instanceof SousError ? (error.call ?? undefined) : undefined;
      toast(`Couldn't remove ${run.title}. ${error instanceof Error ? error.message : String(error)}`, { command: call });
    });
  }, UNDO_MS);
  waiting.set(run.id, timer);
  // Each run its own toast, so a second "Removed slow" keeps the first one's Undo.
  toast(`Removed ${run.title}`, { id: `removed:${run.id}`, undo: () => undo(run) });
}
