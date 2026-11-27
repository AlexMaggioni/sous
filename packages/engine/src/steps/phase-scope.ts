// The phase a script is in, kept per branch. parallel() runs each function, and pipeline() each
// item, in a branch of its own. A branch starts with the phase it was opened in. A phase() call
// inside it changes that branch only, never a sibling or the code that opened it. A step takes the
// phase of its own branch, so the phase in its call hash does not depend on the order in which the
// branches happen to end. A resume can end them in another order and still pair each step with its
// journal row.

import { AsyncLocalStorage } from "node:async_hooks";

interface PhaseCell {
  current: string | undefined;
}

export interface PhaseScope {
  /** The phase of the branch that calls it, or of the run when no branch is open. */
  get(): string | undefined;
  /** Set the phase of the branch that calls it. */
  set(title: string): void;
  /** Run `fn` in a new branch that starts with the caller's phase. */
  branch<T>(fn: () => T): T;
}

/** The phases of one run level, which starts in `initial`. Each nested workflow() has its own. */
export function phaseScope(initial: string | undefined): PhaseScope {
  const storage = new AsyncLocalStorage<PhaseCell>();
  const top: PhaseCell = { current: initial };
  const cell = () => storage.getStore() ?? top;
  return {
    get: () => cell().current,
    set: (title) => {
      cell().current = title;
    },
    branch: (fn) => storage.run({ current: cell().current }, fn),
  };
}
