import { SECTIONS } from "../sections.ts";

// The page's keyboard shortcuts, read from one keydown at a time. Pure, so the tests press keys
// without a page. use-keys.ts feeds it the window's keydowns and does what it says.

export type KeyAction =
  | { type: "go"; path: string }
  | { type: "move"; delta: 1 | -1 }
  | { type: "filter" }
  | { type: "jump" }
  | { type: "sidebar" }
  | { type: "help" }
  | { type: "close" };

export type KeyPress = {
  key: string;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  repeat: boolean;
  /** Focus is in a field that takes text, such as the search or a form. */
  typing: boolean;
  /** Focus is in a dialog, a menu or a list box, which handle their own keys. */
  layered: boolean;
};

/** When the person pressed `g`, waiting for the section key. Null when nothing waits. */
export type KeyState = { gAt: number | null };

/** How long `g` waits for its second key. */
const G_WAIT_MS = 1500;

/** The shortcuts, for the help dialog and the settings page. `keys` is in Kbd's notation. */
export const SHORTCUTS: readonly { keys: string; does: string }[] = [
  { keys: "mod+k", does: "Jump to a run, workflow, agent, skill or MCP server" },
  { keys: "/", does: "Search the list" },
  { keys: "j", does: "Next row in the list" },
  { keys: "k", does: "Previous row in the list" },
  { keys: "Enter", does: "Open the row" },
  ...SECTIONS.map((s) => ({ keys: `g ${s.key}`, does: `Go to ${s.noun}` })),
  { keys: "mod+b", does: "Hide or show the list" },
  { keys: "?", does: "Show these shortcuts" },
];

/**
 * What one keydown does, and what waits after it. Letters and `/` never fire while the person
 * types in a field. ⌘K and ⌘B do, since they type nothing. Nothing fires inside a dialog or a menu.
 */
export function readKey(press: KeyPress, state: KeyState, now: number): { action?: KeyAction; state: KeyState } {
  const idle: KeyState = { gAt: null };
  if (press.layered) return { state: idle };
  const mod = press.meta || press.ctrl;
  const key = press.key.length === 1 ? press.key.toLowerCase() : press.key;

  if (mod && !press.alt && !press.shift) {
    if (press.repeat) return { state: idle };
    if (key === "k") return { action: { type: "jump" }, state: idle };
    if (key === "b") return { action: { type: "sidebar" }, state: idle };
    return { state: idle };
  }
  if (press.typing || mod || press.alt) return { state: idle };
  if (key === "Escape") return { action: { type: "close" }, state: idle };

  // `?` and `/` take Shift on some keyboards, so they match by the character alone.
  if (key === "?") return press.repeat ? { state: idle } : { action: { type: "help" }, state: idle };
  if (key === "/") return press.repeat ? { state: idle } : { action: { type: "filter" }, state: idle };
  if (press.shift) return { state: idle };

  if (state.gAt !== null && now - state.gAt <= G_WAIT_MS) {
    const section = SECTIONS.find((s) => s.key === key);
    if (section) return { action: { type: "go", path: section.path }, state: idle };
  }
  if (key === "j" || key === "k") return { action: { type: "move", delta: key === "j" ? 1 : -1 }, state: idle };
  if (key === "g" && !press.repeat) return { state: { gAt: now } };
  return { state: idle };
}

/** What opens over the page and handles its own keys: a dialog, a menu or a list box. */
export const LAYERS = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

/** The keydown as readKey takes it. */
export function pressOf(event: KeyboardEvent): KeyPress {
  const target = event.target instanceof Element ? event.target : null;
  const field = target?.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])");
  const typing = !!field && !(field instanceof HTMLInputElement && ["checkbox", "radio", "button", "submit", "reset", "range", "color"].includes(field.type));
  return {
    key: event.key,
    meta: event.metaKey,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    repeat: event.repeat,
    typing,
    layered: !!target?.closest(LAYERS),
  };
}
