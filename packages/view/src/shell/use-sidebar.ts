import { createContext, useCallback, useContext, useState } from "react";
import { readStored, store } from "../storage.ts";
import { useMedia, WIDE } from "../ui/use-media.ts";

const KEY = "sous.sidebar";

const readShown = (): boolean => readStored(KEY) !== "hidden";

export type Sidebar = {
  /** Whether the list column shows now. */
  open: boolean;
  /** True under 1100px, where the list column opens over the page. */
  overlay: boolean;
  toggle: () => void;
  /** Shows the list, such as for `/`. */
  show: () => void;
  close: () => void;
};

/**
 * The list column. At 1100px and up, ⌘B or Ctrl+B hides and shows it, and the choice is kept.
 * Under 1100px it starts folded, opens over the page, and Escape closes it. The shell's keys call
 * these.
 */
export function useSidebar(): Sidebar {
  const wide = useMedia(WIDE);
  const [shown, setShown] = useState(readShown);
  const [overlayOpen, setOverlayOpen] = useState(false);

  const toggle = useCallback(() => {
    if (!wide) {
      setOverlayOpen((was) => !was);
      return;
    }
    const next = !shown;
    setShown(next);
    store(KEY, next ? "shown" : "hidden");
  }, [wide, shown]);
  const close = useCallback(() => setOverlayOpen(false), []);
  const show = useCallback(() => {
    if (!wide) setOverlayOpen(true);
    else if (!shown) toggle();
  }, [wide, shown, toggle]);

  return { open: wide ? shown : overlayOpen, overlay: !wide, toggle, show, close };
}

export const SidebarContext = createContext<Sidebar | null>(null);

export function useSidebarContext(): Sidebar {
  const sidebar = useContext(SidebarContext);
  if (!sidebar) throw new Error("useSidebarContext needs the Shell above it");
  return sidebar;
}
