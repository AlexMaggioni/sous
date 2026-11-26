// The motions that need script, as DESIGN.md says under Motion: a value that changed while it
// showed, a page or view that arrives, the list column that slides out and back, an element that
// plays its exit before it leaves, and items that slide to their new places. Without the Web
// Animations API, as in tests, nothing animates and each change is at once.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { Status } from "./status-icon.tsx";

// The same values as under Motion in app.css.
/** The curve of everything that comes, opens, moves or changes, as --ease-arrive. */
const ARRIVE = "cubic-bezier(0.16, 1, 0.3, 1)";
/** The curve of the fade of what goes away, as --ease-leave. */
const LEAVE = "cubic-bezier(0.4, 0, 1, 1)";
/** To open, arrive, swap or move, either way, as --base. */
const BASE = 200;
/** To fade away, and for feedback, as --quick. */
const QUICK = 120;
/** How far what arrives in place comes up, as --rise. */
export const RISE = 4;

/**
 * The classes of a menu, dropdown, dialog or tooltip from UI SDK: it opens over --base and fades away
 * faster, over --quick, on --ease-leave. Each adds what it starts from, such as a fade.
 */
export const POPUP = "transition-[opacity,translate] duration-(--base) data-ending-style:duration-(--quick) data-ending-style:ease-leave";

/** True when the person asked for less motion. Then nothing moves, and fades stay. */
function calm(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/**
 * True once the value changed while the component showed. On the first render it is false, so
 * nothing animates on load, or when a row scrolls into a long list.
 */
export function useChanged<T>(value: T): boolean {
  const [seen, setSeen] = useState({ value, changed: false });
  if (Object.is(seen.value, value)) return seen.changed;
  setSeen({ value, changed: true });
  return true;
}

/**
 * The wash of a node or row whose status just turned failed or "needs you" while it showed: a
 * class that fades its tint away once. Nothing on load, and nothing for the other statuses, which
 * only draw their icon.
 */
export function useWash(status: Status | undefined): string {
  const changed = useChanged(status);
  if (!changed) return "";
  return status === "failed" ? "animate-wash-fail" : status === "needs" ? "animate-wash-needs" : "";
}

/**
 * True once `on` turned true while the same `scope`, such as a run, showed, so what it shows can
 * arrive with a motion. False on load, and when the person moved to a scope where it was on already.
 */
export function useArrived(scope: string, on: boolean): boolean {
  const [seen, setSeen] = useState({ scope, on, arrived: false });
  if (seen.scope === scope && seen.on === on) return seen.arrived;
  const arrived = seen.scope === scope && on;
  setSeen({ scope, on, arrived });
  return arrived;
}

/**
 * Slides the element from where it was to where it is, when what sits above it changed height while
 * the same `scope`, such as a run, showed: a question that opens above the views, or one answered.
 * Not on load, when the person moved to another scope, or when the window changed width.
 */
export function useShift(ref: RefObject<HTMLElement | null>, scope: string): void {
  const last = useRef<{ scope: string; top: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const now = { scope, top: el.offsetTop, width: window.innerWidth };
    const before = last.current;
    last.current = now;
    if (!before || before.scope !== scope || before.width !== now.width || before.top === now.top || !el.animate || calm()) return;
    el.animate([{ transform: `translateY(${before.top - now.top}px)` }, { transform: "none" }], { duration: BASE, easing: ARRIVE });
  });
}

/**
 * Plays the arrival of a new page or view on the element, up 4px with a fade, when `key`, such as
 * the page's path, changed since the last render. Not on load. The old one goes at once, so nothing
 * waits for an exit. With less motion it only fades.
 */
export function useArrive(ref: RefObject<HTMLElement | null>, key: string): void {
  const last = useRef(key);
  useLayoutEffect(() => {
    if (last.current === key) return;
    last.current = key;
    const el = ref.current;
    if (!el?.animate) return;
    el.animate([{ opacity: 0, transform: calm() ? "none" : `translateY(${RISE}px)` }, { opacity: 1, transform: "none" }], { duration: BASE, easing: ARRIVE });
  }, [ref, key]);
}

/**
 * The motion of a drawer that `open` shows and hides, such as the list column, and whether it is
 * still in the page: it stays while it slides away. It slides out from behind the rail by its own
 * width, and back, over --base. With `push`, the page beside it moves with it, from where it was, so
 * the page takes its new width at once and never lays out again on each frame. With less motion the
 * drawer fades in over --base and out over --quick, and the page takes its place at once. Nothing
 * moves on load.
 */
export function useDrawer(open: boolean, push: boolean, drawer: RefObject<HTMLElement | null>, page: RefObject<HTMLElement | null>): boolean {
  const [present, setPresent] = useState(open);
  if (open && !present) setPresent(true);
  const was = useRef(open);
  // Where a slide the person reversed halfway had got to, so the next one starts there.
  const halfway = useRef<{ drawer: Keyframe; page: number } | null>(null);
  useLayoutEffect(() => {
    // A slide cut short by a change of layout, not by the person, ends where it should be, and a
    // drawer that was sliding away leaves the page.
    if (was.current === open) {
      halfway.current = null;
      if (!open) setPresent(false);
      return;
    }
    was.current = open;
    const el = drawer.current;
    if (!el?.animate) {
      if (!open) setPresent(false);
      return;
    }
    const move = !calm();
    const width = el.offsetWidth;
    const away: Keyframe = move ? { transform: `translateX(${-width}px)` } : { opacity: 0 };
    const here: Keyframe = move ? { transform: "none" } : { opacity: 1 };
    const from = halfway.current;
    halfway.current = null;
    const timing = move || open ? { duration: BASE, easing: ARRIVE } : { duration: QUICK, easing: LEAVE };
    const slide = el.animate(open ? [from?.drawer ?? away, here] : [from?.drawer ?? here, away], { ...timing, fill: open ? "none" : "forwards" });
    // The page took its new place at once, so it starts its width away from there, plus where it was.
    const shift = (from?.page ?? 0) + (open ? -width : width);
    const follow = push && move ? page.current?.animate([{ transform: `translateX(${shift}px)` }, { transform: "none" }], timing) : undefined;
    if (!open) slide.finished.then(() => setPresent(false), () => undefined);
    return () => {
      if (slide.playState === "running") {
        const style = getComputedStyle(el);
        const pageX = follow?.playState === "running" && page.current ? new DOMMatrixReadOnly(getComputedStyle(page.current).transform).m41 : 0;
        halfway.current = { drawer: move ? { transform: style.transform } : { opacity: style.opacity }, page: pageX };
      }
      slide.cancel();
      follow?.cancel();
    };
  }, [open, push, drawer, page]);
  return open || present;
}

/**
 * Fades the element out, `drop` px down unless the person asked for less motion, then calls
 * `done`. It holds the last frame, so nothing flashes before the element leaves. The returned
 * function stops the exit and shows the element again.
 */
export function leave(el: HTMLElement | null, done: () => void, { drop = 0 } = {}): () => void {
  if (!el?.animate) {
    done();
    return () => undefined;
  }
  const move = calm() ? 0 : drop;
  const exit = el.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: `translateY(${move}px)` }], { duration: QUICK, easing: LEAVE, fill: "forwards" });
  exit.finished.then(done, () => undefined);
  return () => exit.cancel();
}

/** More than this many items in view to slide at once, and they take their places at once. */
const MAX_MOVES = 60;

export type Place = { x: number; y: number; w: number; h: number };

/**
 * The moved items that went past another one, such as a run that changed group: their order
 * flipped, and it moved at least as far. Items that only shifted, because an item came or went
 * above them, kept their order. An item compares only with those in the same `parent`.
 */
export function wentPast<T extends { was: Place; now: Place; parent?: unknown }>(moves: T[]): T[] {
  return moves.filter((a) => moves.some((b) => b !== a && b.parent === a.parent && (a.was.y - b.was.y) * (a.now.y - b.now.y) < 0 && Math.abs(a.was.y - a.now.y) >= Math.abs(b.was.y - b.now.y)));
}

/**
 * Slides each element under `box` that carries `data-motion-key` from where it was to where it is
 * now, and fades in the new ones, when `order` changed since the last render. A new one whose
 * `data-motion-swap` names an item that was there brightens from half instead, and moves as that
 * item moves. Other renders only measure. When `instant` changed too, such as when the person searched or folded a list,
 * everything takes its place at once. An element with `data-motion-resize`, such as a graph's
 * frame, also grows or shrinks to its new size. When `box` scrolls and the browser scrolls it back
 * because the list got shorter, the items above the gap slide down to close it.
 */
export function useListMotion(box: RefObject<HTMLElement | null>, order: string, instant = ""): void {
  const last = useRef<{ order: string; instant: string; at: Map<string, Place> } | null>(null);
  // How far the box was scrolled before this render. Its scroll events come after a render, so a
  // scroll the browser takes back as the list gets shorter shows only in the next one.
  const scrolled = useRef(0);
  useEffect(() => {
    const root = box.current;
    if (!root) return;
    const keep = () => {
      scrolled.current = root.scrollTop;
    };
    keep();
    root.addEventListener("scroll", keep, { passive: true });
    return () => root.removeEventListener("scroll", keep);
  }, [box]);
  useLayoutEffect(() => {
    const root = box.current;
    if (!root) return;
    const items = [...root.querySelectorAll<HTMLElement>("[data-motion-key]")];
    const at = new Map(items.map((el) => [el.dataset.motionKey!, { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight }]));
    const before = last.current;
    last.current = { order, instant, at };
    const shift = root.scrollTop - scrolled.current;
    scrolled.current = root.scrollTop;
    if (!before || before.order === order || before.instant !== instant || !root.animate) return;
    const changed = items.flatMap((el): { el: HTMLElement; was?: Place; now: Place }[] => {
      const place = before.at.get(el.dataset.motionKey!);
      const now = at.get(el.dataset.motionKey!)!;
      if (!place) return [{ el, now }];
      // Where it showed, in the list as it is scrolled now.
      const was = shift ? { ...place, y: place.y + shift } : place;
      const resized = el.hasAttribute("data-motion-resize") && (was.w !== now.w || was.h !== now.h);
      return was.x !== now.x || was.y !== now.y || resized ? [{ el, was, now }] : [];
    });
    // Only what shows, before or after, moves, so a long list moves like a short one.
    const view = root.getBoundingClientRect();
    const [top, bottom] = [Math.max(view.top, 0), Math.min(view.bottom, window.innerHeight)];
    const shown = changed.filter(({ el, was, now }) => {
      const r = el.getBoundingClientRect();
      const dy = was ? was.y - now.y : 0;
      return Math.max(r.bottom, r.bottom + dy) > top && Math.min(r.top, r.top + dy) < bottom;
    });
    if (!shown.length || shown.length > MAX_MOVES) return;
    const move = !calm();
    const past = new Set(wentPast(shown.flatMap(({ el, was, now }) => (was ? [{ el, was, now, parent: el.offsetParent }] : []))).map((m) => m.el));
    // When items move down or right to make room, such as the groups under one that opens, or a frame
    // that grows, what comes waits until they nearly have their places, so they never pass over it.
    const room = move && shown.some(({ el, was, now }) => was && (now.y > was.y || now.x > was.x || (el.hasAttribute("data-motion-resize") && (now.w > was.w || now.h > was.h))));
    for (const { el, was, now } of shown) {
      if (!was) {
        const swapped = el.dataset.motionSwap ?? "";
        const from = before.at.get(swapped);
        const to = at.get(swapped);
        if (from) {
          // It takes the place of what showed there, such as an open frame's name where its folded
          // node was, and moves with it, so the name rides the frame's corner as the frame grows.
          const shift = move && to ? `translate(${from.x - to.x}px, ${from.y - to.y}px)` : "none";
          el.animate([{ opacity: 0.5, transform: shift }, { opacity: 1, transform: "none" }], { duration: BASE, easing: ARRIVE });
          continue;
        }
        // It comes 4px from above, the way the items around it slide.
        el.animate([{ opacity: 0, transform: move ? `translateY(${-RISE}px)` : "none" }, { opacity: 1, transform: "none" }], { duration: BASE, easing: ARRIVE, delay: room ? 80 : 0, fill: "backwards" });
        continue;
      }
      if (!move) {
        // With less motion, an item that went past others, such as a run that changed group, fades in where it went.
        if (past.has(el)) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: BASE, easing: ARRIVE });
        continue;
      }
      const from: Keyframe = { transform: `translate(${was.x - now.x}px, ${was.y - now.y}px)` };
      const to: Keyframe = { transform: "none" };
      if (el.hasAttribute("data-motion-resize")) {
        Object.assign(from, { width: `${was.w}px`, height: `${was.h}px` });
        Object.assign(to, { width: `${now.w}px`, height: `${now.h}px` });
      }
      const slide = el.animate([from, to], { duration: BASE, easing: ARRIVE });
      // An item that goes past others, such as a run that changes group, rides above them on the
      // list's own color, so their words don't show through it.
      if (past.has(el) && getComputedStyle(el).position === "static") {
        const back = getComputedStyle(el.closest("[data-surface]") ?? document.body).backgroundColor;
        Object.assign(el.style, { position: "relative", zIndex: "1", backgroundColor: back });
        const land = () => Object.assign(el.style, { position: "", zIndex: "", backgroundColor: "" });
        slide.finished.then(land, land);
      }
    }
  });
}
