// The page follows the system theme unless the person picks light or dark. The pick is a
// convenience for this browser only, so a failed read or write of storage changes nothing else.
import { readStored, store } from "./storage.ts";

export type ThemePref = "system" | "light" | "dark";

const KEY = "sous.theme";
const PREFS: readonly ThemePref[] = ["system", "light", "dark"];

export function readThemePref(): ThemePref {
  const value = readStored(KEY);
  return PREFS.includes(value as ThemePref) ? (value as ThemePref) : "system";
}

/** Sets data-theme on <html> for light or dark, and removes it for the system theme. */
export function applyTheme(pref: ThemePref, root: HTMLElement = document.documentElement): void {
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
}

export function saveThemePref(pref: ThemePref): void {
  applyTheme(pref);
  store(KEY, pref === "system" ? undefined : pref);
}

/** System, then light, then dark, then system again. */
export function nextThemePref(pref: ThemePref): ThemePref {
  return PREFS[(PREFS.indexOf(pref) + 1) % PREFS.length] ?? "system";
}
