// This browser's storage, for the page's small choices. A browser that keeps nothing, such as a
// private window, still works: a read finds nothing, and a write holds only for this visit.

export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Keeps `value` under `key`. Undefined forgets the key. */
export function store(key: string, value: string | undefined): void {
  try {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // The choice still holds for this visit.
  }
}
