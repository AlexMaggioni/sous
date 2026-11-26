// The graph of a saved workflow or of a run, as DESIGN.md says under "The graph". model.ts and
// overlay.ts make its parts, layout.ts places them to fit the box, and this file draws them: open
// boxes, then one SVG of edges, then the labels and the nodes as HTML. When a fold or a new step
// moves the nodes, they and their frames glide to their new places, and the edges and labels
// cross-fade from the old drawing to the new one, so an edge that stays in place stays as it is.
import { Scan, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Flow } from "../api/contract.ts";
import { IconButton } from "../ui/button.tsx";
import { useListMotion } from "../ui/motion.ts";
import { useMedia, useWidth } from "../ui/use-media.ts";
import { GraphBox, GraphBoxHead, GraphNode, type NodeActions } from "./graph-node.tsx";
import { GraphOutline } from "./graph-outline.tsx";
import { layoutGraph, type Layout } from "./layout.ts";
import { pageMeasure } from "./measure.ts";
import type { RunGraph } from "./overlay.ts";
import { kidsOf, pathTo, type Part, type Seq } from "./tree.ts";

export type FlowGraphProps = {
  /** The parts to draw, as planOf makes them. Null when there is nothing to draw yet. */
  plan: RunGraph | null;
  /** The text of the workflow, for the notes sous has about it. */
  flow?: Flow;
  /** The graph is a run's, so its nodes show what ran. */
  run?: boolean;
  /** The key of the selected part. The boxes around it open. */
  selected?: string;
  /** The person selected a part, by its key. */
  onSelect?: (key: string) => void;
  /** The graph's accessible name. */
  label?: string;
};

const ZOOMS = [1, 1.25, 1.5];
/** The width the layout takes before the box is measured, such as in tests. */
const FIRST_WIDTH = 960;

/** Under 700px the graph reads top to bottom, with 40px nodes for touch. */
const NARROW = "(max-width: 699px)";

/** Text widths in the page's fonts, measured again once the web fonts load. */
function useMeasure() {
  const [measure, setMeasure] = useState(pageMeasure);
  useEffect(() => {
    let live = true;
    document.fonts?.ready.then(() => {
      if (live) setMeasure(() => pageMeasure());
    });
    return () => {
      live = false;
    };
  }, []);
  return measure;
}

/** Each arrowhead as a small triangle, 6px long. */
function headsPath(heads: Layout["heads"]): string {
  const a = 6;
  const b = 3.5;
  return heads
    .map(({ x, y, dir }) => {
      const pts = {
        r: [x - a, y - b, x - a, y + b],
        l: [x + a, y - b, x + a, y + b],
        d: [x - b, y - a, x + b, y - a],
        u: [x - b, y + a, x + b, y + a],
      }[dir];
      return `M${x} ${y}L${pts[0]} ${pts[1]}L${pts[2]} ${pts[3]}Z`;
    })
    .join("");
}

/** The old edges and marks give way to the new ones over --base, as long as the nodes glide. */
const CROSS = {
  in: "mix-blend-plus-lighter animate-[fade-in_var(--base)_var(--ease-arrive)_both]",
  out: "mix-blend-plus-lighter animate-[fade-out_var(--base)_var(--ease-arrive)_both]",
};

/** True where the browser animates, so not in tests. */
function crossFades(): boolean {
  return typeof Element !== "undefined" && typeof Element.prototype.animate === "function";
}

/**
 * The edges, arrowheads and marks of a layout. They have no key of their own, so when the nodes
 * move, the old drawing fades out as the new one fades in. Both add their light, so where the two
 * drawings match, nothing changes.
 */
function Lines({ layout, fade, onEnd }: { layout: Layout; fade?: "in" | "out"; onEnd?: () => void }) {
  return (
    <div aria-hidden="true" onAnimationEnd={onEnd} className={`pointer-events-none absolute top-0 left-0 ${fade ? CROSS[fade] : ""}`}>
      <svg className="absolute top-0 left-0 overflow-visible" width={layout.width} height={layout.height}>
        <path d={layout.edges} className="fill-none stroke-edge" strokeWidth={1.5} strokeLinejoin="round" />
        <path d={headsPath(layout.heads)} className="fill-edge" />
        {layout.marks.map((m) =>
          m.kind === "start" ? (
            <circle key={`s${m.x} ${m.y}`} cx={m.x} cy={m.y} r={4.5} className="fill-side stroke-icon" strokeWidth={1.5} />
          ) : (
            <circle key={`${m.kind}${m.x} ${m.y}`} cx={m.x} cy={m.y} r={m.kind === "end" ? 5 : 2.5} className={m.kind === "end" ? "fill-icon" : "fill-edge"} />
          ),
        )}
      </svg>
    </div>
  );
}

/**
 * The labels of a layout, such as a loop's limit. Each takes a key from its text, so it glides to
 * its new place with the nodes, where a cross-fade would show it twice.
 */
function EdgeLabels({ layout }: { layout: Layout }) {
  const seen = new Map<string, number>();
  return (
    <div aria-hidden="true" className="pointer-events-none">
      {layout.labels.map((l) => {
        const n = seen.get(l.text) ?? 0;
        seen.set(l.text, n + 1);
        const key = `label ${l.text} ${n}`;
        return (
          <span
            key={key}
            data-motion-key={key}
            className={`absolute text-xs leading-[14px] whitespace-nowrap text-muted ${
              l.align === "c" ? "-translate-x-1/2 -translate-y-1/2" : l.align === "l" ? "-translate-y-1/2" : "-translate-x-full -translate-y-1/2"
            }`}
            style={{ left: l.x, top: l.y }}
          >
            {l.text}
          </span>
        );
      })}
    </div>
  );
}

/**
 * The drawing the graph showed before its parts last changed, while it fades out, and what to call
 * once it faded. Null the rest of the time, and on the first drawing. It goes when its fade ends,
 * not after a set time, so a slow frame never cuts the fade short.
 */
function useOldLines(order: string, layout: Layout | null): [Layout | null, () => void] {
  const last = useRef<{ order: string; layout: Layout | null } | null>(null);
  const [old, setOld] = useState<Layout | null>(null);
  useLayoutEffect(() => {
    const before = last.current;
    last.current = { order, layout };
    if (before && before.order !== order && before.layout && layout && crossFades()) setOld(before.layout);
  }, [order, layout]);
  return [old, () => setOld(null)];
}

type Focusable = { t: "node"; n: Layout["nodes"][number] } | { t: "head"; b: Layout["boxes"][number] };

/** The nodes and the heads of open boxes in the order the graph reads, which is the order Tab takes. */
function readingOrder(graph: Seq, layout: Layout): Focusable[] {
  const nodes = new Map(layout.nodes.map((n) => [n.part.key, n]));
  const boxes = new Map(layout.boxes.map((b) => [b.part.key, b]));
  const out: Focusable[] = [];
  const visit = (p: Part) => {
    const n = nodes.get(p.key);
    if (n) {
      out.push({ t: "node", n });
      nodes.delete(p.key);
      return;
    }
    const b = boxes.get(p.key);
    if (b) out.push({ t: "head", b });
    kidsOf(p).forEach(visit);
  };
  visit(graph);
  // A node the walk missed still draws, last.
  for (const n of nodes.values()) out.push({ t: "node", n });
  return out;
}

/** A faded edge on each side that has more, while the box scrolls. */
function fadeMask(left: boolean, right: boolean): CSSProperties | undefined {
  if (!left && !right) return undefined;
  const across = left && right ? "transparent, black 56px, black calc(100% - 56px), transparent" : left ? "transparent, black 56px" : "black calc(100% - 56px), transparent";
  // The second layer keeps the scroll bar along the bottom clear of the fade.
  const image = `linear-gradient(to right, ${across}), linear-gradient(black, black)`;
  return { maskImage: image, maskRepeat: "no-repeat", maskSize: "100% 100%, 100% 10px", maskPosition: "0 0, 0 100%", maskComposite: "add" };
}

/** The graph of a workflow or a run. */
export function FlowGraph({ plan: made, flow, run = false, selected, onSelect, label }: FlowGraphProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const width = useWidth(wrap);
  const narrow = useMedia(NARROW);
  const measure = useMeasure();
  const [folds, setFolds] = useState<Record<string, boolean>>({});
  const [zoom, setZoom] = useState(1);
  const [cut, setCut] = useState({ left: false, right: false });
  const focusNext = useRef<{ attr: string; key: string } | null>(null);
  const canvas = useRef<HTMLDivElement>(null);

  // A part selected elsewhere, such as in Steps, opens the boxes around it once, so it shows.
  const [shownFor, setShownFor] = useState<string>();
  if (selected !== shownFor) {
    setShownFor(selected);
    const around = selected && made ? (pathTo(made.graph, selected) ?? []).filter((p) => p.t === "box" && p.foldable) : [];
    if (around.length) setFolds((f) => ({ ...f, ...Object.fromEntries(around.map((p) => [p.key, false])) }));
  }
  const layout = useMemo(
    () => (made ? layoutGraph(made.graph, { width: width || FIRST_WIDTH, narrow, measure, folds }) : null),
    [made, width, narrow, measure, folds],
  );

  // After a fold, focus moves to what took the place of the control the person used.
  useLayoutEffect(() => {
    const next = focusNext.current;
    if (!next || !scroller.current) return;
    focusNext.current = null;
    const el = [...scroller.current.querySelectorAll<HTMLElement>(`[${next.attr}]`)].find((e) => e.getAttribute(next.attr) === next.key);
    el?.focus();
  });

  const edges = () => {
    const sc = scroller.current;
    if (!sc) return;
    const left = sc.scrollLeft > 1;
    const right = sc.scrollLeft + sc.clientWidth < sc.scrollWidth - 1;
    setCut((c) => (c.left === left && c.right === right ? c : { left, right }));
  };
  useLayoutEffect(edges, [layout, zoom, width]);
  // What the person or the run changed: the folds and the parts drawn. A new width only lays it out again.
  const order = layout ? `${JSON.stringify(folds)} ${layout.nodes.map((n) => n.part.key).join(" ")}` : "";
  useListMotion(canvas, order);
  const [oldLines, faded] = useOldLines(order, layout);

  const actions: NodeActions = {
    run,
    selected,
    onSelect,
    onFold: (key, folded) => {
      focusNext.current = { attr: folded ? "data-gnode" : "data-gfold", key };
      setFolds((f) => ({ ...f, [key]: folded }));
    },
  };

  const name = label ?? (run ? "Graph of the run's steps" : "Graph of the workflow");
  const notes = [...(flow?.notes ?? [])];
  if (run && made?.asRan)
    notes.push(flow ? "Some steps of this run match no step of the text, so the graph shows the steps as they ran." : "sous could not read the text of this run, so the graph shows the steps as they ran.");

  if (!made || !layout) {
    return (
      <div ref={wrap} className="rounded-lg border border-line bg-side px-4 py-3 text-muted">
        {run ? "No step has started yet." : "This workflow has no steps."}
      </div>
    );
  }
  const zi = ZOOMS.indexOf(zoom);
  return (
    <div>
      <div ref={wrap} className="relative flex flex-col rounded-lg border border-line bg-side">
        <div role="group" aria-label="Zoom" className="z-[2] mt-1 mr-1 -mb-2 flex self-end">
          <IconButton icon={ZoomOut} label="Zoom out" disabled={zi <= 0 ? "At 100%, the smallest" : false} onClick={() => setZoom(ZOOMS[Math.max(0, zi - 1)])} />
          <IconButton icon={ZoomIn} label="Zoom in" disabled={zi >= ZOOMS.length - 1 ? "At 150%, the largest" : false} onClick={() => setZoom(ZOOMS[Math.min(ZOOMS.length - 1, zi + 1)])} />
          <IconButton icon={Scan} label="Back to 100%" disabled={zi <= 0 ? "At 100%, every node shows" : false} onClick={() => setZoom(1)} />
        </div>
        <div
          ref={scroller}
          role="region"
          aria-label={name}
          tabIndex={0}
          data-scroll-x
          data-mode={layout.mode}
          onScroll={edges}
          className={`overflow-auto rounded-lg [scrollbar-color:var(--border-strong)_transparent] [scrollbar-width:thin] ${zoom > 1 ? "max-h-[70vh]" : ""}`}
          style={fadeMask(cut.left, cut.right)}
        >
          <div className="relative" style={{ width: Math.round(layout.width * zoom), height: Math.round(layout.height * zoom) }}>
            <div ref={canvas} className="absolute top-0 left-0 origin-top-left" style={{ width: layout.width, height: layout.height, transform: zoom > 1 ? `scale(${zoom})` : undefined }}>
              {layout.under.map((u) =>
                u.t === "box" ? (
                  <GraphBox key={u.part.key} part={u.part} x={u.x} y={u.y} w={u.w} h={u.h} selected={u.part.key === selected} />
                ) : (
                  <div
                    key={`plate ${u.key}`}
                    aria-hidden="true"
                    data-motion-key={`plate ${u.key}`}
                    data-motion-resize
                    className={`absolute border border-line-strong ${u.open ? "rounded-lg bg-base" : "rounded-md bg-raised"}`}
                    style={{ left: u.x, top: u.y, width: u.w, height: u.h }}
                  />
                ),
              )}
              <div className="absolute top-0 left-0 isolate">
                {oldLines && <Lines key={`old ${order}`} layout={oldLines} fade="out" onEnd={faded} />}
                <Lines key={order} layout={layout} fade={oldLines ? "in" : undefined} />
              </div>
              <EdgeLabels layout={layout} />
              {readingOrder(made.graph, layout).map((f) =>
                f.t === "node" ? (
                  <GraphNode key={f.n.part.key} part={f.n.part} x={f.n.x} y={f.n.y} w={f.n.w} h={f.n.h} actions={actions} measure={measure} />
                ) : (
                  <GraphBoxHead key={`head ${f.b.part.key}`} part={f.b.part} x={f.b.x} y={f.b.y} w={f.b.w} inset={f.b.inset} actions={actions} />
                ),
              )}
            </div>
          </div>
        </div>
      </div>
      <GraphOutline graph={made.graph} run={run} />
      {notes.length > 0 && (
        <ul className="mt-1.5 text-xs text-muted">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
