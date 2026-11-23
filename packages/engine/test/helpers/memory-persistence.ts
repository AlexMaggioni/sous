// A run store in memory, for tests of the manager that need no files.

import type { PersistedRunState, RunPersistence } from "../../src/runs/persistence/run-persistence.js";

export interface MemoryPersistence {
  persistence: RunPersistence;
  /** The saved states, by run id. */
  states: Map<string, PersistedRunState>;
  /** A copy of every state saved, in order. */
  saves: PersistedRunState[];
  /** The run id of each lease taken, and of each one given back. */
  acquired: string[];
  released: string[];
  /** Put a state in the store as an earlier process left it, with no save noted. */
  seed(state: PersistedRunState): void;
}

/**
 * A store that keeps copies, so a second manager on the same store loads a run as a new process
 * would. It always grants a lease.
 */
export function memoryPersistence(): MemoryPersistence {
  const states = new Map<string, PersistedRunState>();
  const saves: PersistedRunState[] = [];
  const acquired: string[] = [];
  const released: string[] = [];
  const clone = (state: PersistedRunState): PersistedRunState => structuredClone(state);
  const persistence: RunPersistence = {
    save(state) {
      const copy = clone(state);
      saves.push(copy);
      states.set(state.runId, copy);
    },
    load(runId) {
      const state = states.get(runId);
      return state ? clone(state) : null;
    },
    list() {
      return [...states.values()].map(clone);
    },
    delete(runId) {
      return states.delete(runId);
    },
    acquireRunLease(runId) {
      acquired.push(runId);
      return { runId, token: `${runId}-lease` };
    },
    releaseRunLease(lease) {
      released.push(lease.runId);
    },
    validateRunLease() {
      return true;
    },
  };
  return { persistence, states, saves, acquired, released, seed: (state) => void states.set(state.runId, clone(state)) };
}
