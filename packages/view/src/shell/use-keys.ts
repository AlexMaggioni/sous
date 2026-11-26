import { useEffect, useRef } from "react";
import { pressOf, readKey, type KeyAction, type KeyState } from "./keys.ts";

/**
 * Feeds the window's keydowns to readKey and hands each action to `onAction`. It returns false
 * when the action did nothing here, such as j with no list, so the key keeps its usual effect.
 */
export function useKeys(onAction: (action: KeyAction) => boolean): void {
  const latest = useRef(onAction);
  useEffect(() => {
    latest.current = onAction;
  });
  useEffect(() => {
    let state: KeyState = { gAt: null };
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const read = readKey(pressOf(event), state, Date.now());
      state = read.state;
      if (read.action && latest.current(read.action)) event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
