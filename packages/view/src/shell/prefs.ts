import { useSyncExternalStore } from "react";
import { readStored, store } from "../storage.ts";
import { readThemePref, saveThemePref, type ThemePref } from "../theme.ts";
import type { GroupBy } from "../lists/run-groups.ts";

// The small choices of the list column and the theme. This browser keeps the grouping and the
// theme. The search text and the runs' project filter last until the page reloads, so a filter
// the person forgot never hides a run for good. "Seen from" lives in api/seen-from.ts, since the
// pages share it.

const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const use = <T,>(read: () => T): T => useSyncExternalStore(subscribe, read);

function write(key: string, value: string): void {
  store(key, value);
  notify();
}

const GROUP_KEY = "sous.groupBy";
const readGroupBy = (): GroupBy => (readStored(GROUP_KEY) === "project" ? "project" : "status");
export const useGroupBy = () => use(readGroupBy);
export const setGroupBy = (by: GroupBy) => write(GROUP_KEY, by);

export const useThemePref = () => use(readThemePref);
/** Sets the theme. Where the browser can, the page cross-fades from the old theme to the new one. */
export function setThemePref(pref: ThemePref): void {
  const apply = () => {
    saveThemePref(pref);
    notify();
  };
  if (typeof document !== "undefined" && document.startViewTransition) document.startViewTransition(apply);
  else apply();
}

let runProject = "";
/** The project the runs list shows, or "" for all of them. */
export const useRunProject = () => use(() => runProject);
export function setRunProject(dir: string): void {
  runProject = dir;
  notify();
}

const queries: Record<string, string> = {};
/** The search text of one section's list, kept while the person visits other sections. */
export const useListQuery = (section: string) => use(() => queries[section] ?? "");
export function setListQuery(section: string, text: string): void {
  queries[section] = text;
  notify();
}

const FOLD_KEY = "sous.folded";
function readFolded(): ReadonlySet<string> {
  try {
    const list: unknown = JSON.parse(readStored(FOLD_KEY) ?? "[]");
    return new Set(Array.isArray(list) ? list.filter((key): key is string => typeof key === "string") : []);
  } catch {
    return new Set();
  }
}
let folded = readFolded();
/** The keys of the list groups the person folded. This browser keeps them. */
export const useFolded = () => use(() => folded);
export function toggleFolded(key: string): void {
  const next = new Set(folded);
  if (!next.delete(key)) next.add(key);
  folded = next;
  write(FOLD_KEY, JSON.stringify([...next]));
}
