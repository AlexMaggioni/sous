import { useSyncExternalStore } from "react";

// Whether the start dialog is open, and for which workflow. Any part of the page opens it, such as
// the list column's "Start a workflow" or a workflow page's Start button, and the shell draws it.

export type StartState = { open: false } | { open: true; workflow?: string };

let state: StartState = { open: false };
const listeners = new Set<() => void>();

function set(next: StartState) {
  state = next;
  for (const listener of listeners) listener();
}

/** Open the start dialog, on one workflow or on the picker. */
export const openStart = (workflow?: string) => set({ open: true, workflow });
export const closeStart = () => set({ open: false });

export function useStartState(): StartState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}
