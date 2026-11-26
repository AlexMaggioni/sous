// The sizes a part reads: the window's, through a media query, and a box's own width.
import { useLayoutEffect, useState, useSyncExternalStore, type RefObject } from "react";

/** At this width and up, the list column sits beside the page and a detail page has its details column. */
export const WIDE = "(min-width: 1100px)";

/** Whether the media query matches, read again when it changes. False where the browser has no matchMedia. */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia?.(query);
      list?.addEventListener("change", onChange);
      return () => list?.removeEventListener("change", onChange);
    },
    () => window.matchMedia?.(query).matches ?? false,
  );
}

/** The width of a box, read again when it changes. 0 until it is measured. */
export function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}
