import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import { ChevronDown } from "lucide-react";
import { useEffect, useMemo, useRef, type ReactNode, type RefObject } from "react";
import { setListMover } from "../shell/list-nav.ts";
import { toggleFolded, useFolded } from "../shell/prefs.ts";
import { useListMotion } from "../ui/motion.ts";
import type { ListGroup } from "./run-groups.ts";

// The scrolling part of the list column: headed groups of rows. Past a few hundred rows only the
// rows in view are drawn, so a long run history scrolls as fast as a short one. While all rows
// are drawn, a row that changes group slides to its new place, and a new row fades in.

/** From this many rows on, the list draws only the rows in view. */
const VIRTUAL_AFTER = 300;

/** The id of the list's scroll box, where the rows carry `data-row`. */
const BODY_ID = "list-body";
const BODY = "min-h-0 flex-1 overflow-y-auto px-2 pb-12";

/** The list's scroll box, for the loading, error and empty states too. */
export function ListBody({ children }: { children: ReactNode }) {
  return (
    <div id={BODY_ID} className={BODY}>
      {children}
    </div>
  );
}

type HeadingProps = { label: string; count: number; needs?: boolean; menu?: ReactNode; folded?: boolean; onToggle?: () => void };

/**
 * A section heading: 12px, muted, the count after the name, and the view menu on the first one.
 * With `onToggle`, a press folds the group, and a chevron shows on hover and while folded.
 */
export function GroupHeading({ label, count, needs = false, menu, folded = false, onToggle }: HeadingProps) {
  const text = (
    <>
      {label} <span className="ml-0.5 font-normal tabular-nums">{count}</span>
    </>
  );
  return (
    <div className="group/head flex min-h-7 items-center gap-1.5 pt-4 pl-2 max-[699px]:min-h-10">
      <h2 className={`min-w-0 flex-1 text-xs font-medium ${needs ? "text-needs-text" : "text-muted"}`}>
        {onToggle ? (
          <button type="button" aria-expanded={!folded} onClick={onToggle} className="-my-1 flex max-w-full items-center gap-1 py-1 text-left">
            {/* The fade falls on the 24px of padding, so only a label too long for the column fades. */}
            <span className="fade-end -mr-6 min-w-0 pr-6">{text}</span>
            <ChevronDown
              size={12}
              strokeWidth={2}
              aria-hidden="true"
              className={`flex-none text-icon transition-transform motion-reduce:transition-none ${folded ? "-rotate-90" : "opacity-0 group-hover/head:opacity-100 group-focus-within/head:opacity-100"}`}
            />
          </button>
        ) : (
          <span className="fade-end block">{text}</span>
        )}
      </h2>
      {menu}
    </div>
  );
}

/** Muted lines under a heading, such as what fills an empty list or why a search finds nothing. */
export function ColumnNote({ children }: { children: ReactNode }) {
  return <div className="flex flex-col items-start gap-2 px-2 pt-2 text-muted">{children}</div>;
}

type Line<T> = { kind: "head"; group: ListGroup<T>; first: boolean; folded: boolean } | { kind: "row"; item: T; index: number };

/** The headings and the rows under them. A folded group keeps its heading and hides its rows. */
function linesOf<T>(groups: readonly ListGroup<T>[], folded: ReadonlySet<string>): Line<T>[] {
  const lines: Line<T>[] = [];
  let index = 0;
  groups.forEach((group, g) => {
    const isFolded = folded.has(group.key);
    lines.push({ kind: "head", group, first: g === 0, folded: isFolded });
    if (!isFolded) for (const item of group.items) lines.push({ kind: "row", item, index: index++ });
  });
  return lines;
}

type ListProps<T> = {
  groups: readonly ListGroup<T>[];
  keyOf: (item: T) => string;
  /** The key of the row the route shows. */
  selected?: string;
  /** The view menu, on the first heading. */
  menu?: ReactNode;
  /** One row. Its link carries `data-row={index}`, which j and k use. */
  row: (item: T, index: number) => ReactNode;
  /** Changes when the person searches, filters or regroups the list. The rows then take their places at once. */
  filter?: string;
};

const rowAt = (box: HTMLElement | null, index: number) => box?.querySelector<HTMLElement>(`[data-row="${index}"]`) ?? null;

/**
 * Registers how j and k move focus in this list. The first press focuses the selected row, or the
 * first row. A row out of view scrolls in first.
 */
function useMover<T>(box: RefObject<HTMLDivElement | null>, lines: readonly Line<T>[], selectedIndex: number, virtualizer?: Virtualizer<HTMLDivElement, Element>) {
  const state = useRef({ lines, selectedIndex, virtualizer });
  state.current = { lines, selectedIndex, virtualizer };
  useEffect(
    () =>
      setListMover((delta) => {
        const { lines, selectedIndex, virtualizer } = state.current;
        const rows = lines.length - lines.filter((line) => line.kind === "head").length;
        if (!rows) return;
        const focused = document.activeElement instanceof HTMLElement && box.current?.contains(document.activeElement) ? document.activeElement.closest<HTMLElement>("[data-row]") : null;
        const from = focused ? Number(focused.dataset.row) : -1;
        const target = from < 0 ? (selectedIndex >= 0 ? selectedIndex : delta === 1 ? 0 : rows - 1) : Math.min(rows - 1, Math.max(0, from + delta));
        const el = rowAt(box.current, target);
        if (el) {
          el.focus();
          el.scrollIntoView?.({ block: "nearest" });
          return;
        }
        const line = lines.findIndex((l) => l.kind === "row" && l.index === target);
        if (!virtualizer || line < 0) return;
        virtualizer.scrollToIndex(line, { align: "auto" });
        requestAnimationFrame(() => rowAt(box.current, target)?.focus());
      }),
    [box],
  );
}

type LinesProps<T> = Omit<ListProps<T>, "groups" | "selected" | "filter"> & { lines: readonly Line<T>[] };

function Lines<T>({ lines, keyOf, menu, row }: LinesProps<T>) {
  return lines.map((line) =>
    line.kind === "head" ? (
      <div key={`h:${line.group.key}`} data-motion-key={`h:${line.group.key}`}>
        <GroupHeading
          label={line.group.label}
          count={line.group.items.length}
          needs={line.group.needs}
          menu={line.first ? menu : undefined}
          folded={line.folded}
          onToggle={() => toggleFolded(line.group.key)}
        />
      </div>
    ) : (
      <div key={keyOf(line.item)} data-motion-key={keyOf(line.item)}>
        {row(line.item, line.index)}
      </div>
    ),
  );
}

function PlainList<T>({ lines, selectedIndex, filter, ...props }: LinesProps<T> & { selectedIndex: number; filter: string }) {
  const box = useRef<HTMLDivElement>(null);
  useMover(box, lines, selectedIndex);
  // A search, a filter or a regroup takes effect at once. A group that folds or opens moves like a
  // fold in Steps: the rows below glide, and the rows that come fade in.
  useListMotion(box, lines.map((l) => (l.kind === "head" ? `h:${l.group.key}` : props.keyOf(l.item))).join(" "), filter);
  // A row picked elsewhere, such as from ⌘K, scrolls into view.
  useEffect(() => {
    rowAt(box.current, selectedIndex)?.scrollIntoView?.({ block: "nearest" });
  }, [selectedIndex]);
  return (
    <div ref={box} id={BODY_ID} className={BODY}>
      <Lines lines={lines} {...props} />
    </div>
  );
}

function VirtualList<T>({ lines, selectedIndex, keyOf, menu, row }: LinesProps<T> & { selectedIndex: number }) {
  const box = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => box.current,
    estimateSize: (i) => (lines[i]?.kind === "head" ? 44 : 28),
    getItemKey: (i) => {
      const line = lines[i];
      return !line ? i : line.kind === "head" ? `h:${line.group.key}` : keyOf(line.item);
    },
    overscan: 12,
  });
  useMover(box, lines, selectedIndex, virtualizer);
  useEffect(() => {
    const line = lines.findIndex((l) => l.kind === "row" && l.index === selectedIndex);
    if (line >= 0) virtualizer.scrollToIndex(line, { align: "auto" });
    // Only a new pick scrolls, not a list that grows.
  }, [selectedIndex]);
  return (
    <div ref={box} id={BODY_ID} className={BODY}>
      <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const line = lines[item.index];
          if (!line) return null;
          return (
            <div key={item.key} data-index={item.index} ref={virtualizer.measureElement} className="absolute inset-x-0 top-0" style={{ transform: `translateY(${item.start}px)` }}>
              <Lines lines={[line]} keyOf={keyOf} menu={menu} row={row} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The groups of one list, drawn whole up to a few hundred rows and in view only past that. */
export function GroupedList<T>({ groups, selected, filter = "", ...props }: ListProps<T>) {
  const folded = useFolded();
  const lines = useMemo(() => linesOf(groups, folded), [groups, folded]);
  const selectedIndex = useMemo(() => {
    const line = selected === undefined ? undefined : lines.find((l) => l.kind === "row" && props.keyOf(l.item) === selected);
    return line?.kind === "row" ? line.index : -1;
    // keyOf reads the same key from an item on every render.
  }, [lines, selected]);
  const rows = lines.filter((line) => line.kind === "row").length;
  return rows > VIRTUAL_AFTER ? (
    <VirtualList lines={lines} selectedIndex={selectedIndex} {...props} />
  ) : (
    <PlainList lines={lines} selectedIndex={selectedIndex} filter={filter} {...props} />
  );
}
