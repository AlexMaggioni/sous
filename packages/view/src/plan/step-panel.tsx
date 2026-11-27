// The panel of the selected step, under the Graph or Steps view, so the person reads it and acts on
// it without leaving the view. It takes the page's width: what the step did and is on the left, its
// facts and settings on the right, and one column on a narrow page. Escape closes it. It rises in
// as it opens, brightens what it shows for another step from half, and fades out as it closes.
import { X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import type { FlowNode } from "../api/contract.ts";
import { kindOf } from "../graph/graph-node.tsx";
import { boxIcon, type Part } from "../graph/tree.ts";
import { LAYERS, pressOf } from "../shell/keys.ts";
import { COLUMN_ID } from "../shell/list-nav.ts";
import { IconButton } from "../ui/button.tsx";
import { leave, RISE, useArrive, useChanged } from "../ui/motion.ts";
import { StatusIcon } from "../ui/status-icon.tsx";
import { nameOf } from "./plan.ts";
import { rowId } from "./steps-list.tsx";

const KIND_WORDS: Record<string, string> = {
  agent: "Agent step",
  sh: "Shell command",
  js: "JavaScript step",
  py: "Python step",
  run: "Runs a file",
  wait: "Waits until a check passes",
  ask: "Question for you",
  breakpoint: "Breakpoint",
  workflow: "Nested workflow",
  choose: "Picks what runs next",
  room: "Room",
  pipeline: "Pipeline",
};
const LOOP_WORDS: Record<string, string> = { for: "For loop", while: "While loop" };

/** What kind of part it is, in a few words, such as "Agent step" or "For loop". */
function kindWords(part: Part, node: FlowNode | undefined): string {
  switch (part.t) {
    case "leaf":
      return KIND_WORDS[part.kind] ?? part.kind;
    case "box":
      if (part.kind === "loop") return node?.t === "loop" ? LOOP_WORDS[node.loop]! : "Loop";
      return KIND_WORDS[boxIcon(part)]!;
    case "par":
      return part.conds ? "If and else" : "Branches at once";
    case "iff":
      return "Runs on a condition";
    case "ret":
      return "Ends early";
    default:
      return "End";
  }
}

function HeadIcon({ part }: { part: Part }) {
  const status = part.t === "leaf" || part.t === "box" ? part.status : undefined;
  if (status) return <StatusIcon status={status} label={false} />;
  if (part.t !== "leaf" && !(part.t === "box" && part.kind !== "loop")) return null;
  const Icon = kindOf(part.t === "leaf" ? part.kind : boxIcon(part)).icon;
  return <Icon size={14} strokeWidth={1.5} aria-hidden="true" className="flex-none text-icon" />;
}

/** The view and, once a part is selected, its panel under it. Another `view`, such as Steps, arrives like a new page. */
export function PlanArea({ view, panel, children }: { view: string; panel: ReactNode; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useArrive(box, view);
  return (
    <div className="flex flex-col gap-4">
      <div ref={box} className="min-w-0">
        {children}
      </div>
      {panel}
    </div>
  );
}

export type ColumnsProps = {
  /** What the person can do about the step, such as answering its question. It comes first. */
  lead?: ReactNode;
  /** The facts of the call, such as its status and time. Right column, or after the lead in one column. */
  facts?: ReactNode;
  /** What the step did, such as its activity or output. */
  did?: ReactNode;
  /** What the step is, such as its prompt or code. */
  is: ReactNode;
  /** Its settings and where it sits. Right column, or last in one column. */
  side: ReactNode;
};

/**
 * The panel's body. From 760px of panel, two columns: the lead, what the step did and what it is on
 * the left, its facts and settings on the right. Narrower, one column, in the order a person needs
 * them: the lead, the facts, what it did, what it is, then the settings.
 */
export function PanelColumns({ lead, facts, did, is, side }: ColumnsProps) {
  const block = (node: ReactNode, order: string, extra = "") => (node ? <div className={`min-w-0 ${order} ${extra}`}>{node}</div> : null);
  return (
    <div className="@container">
      <div className="flex flex-col gap-6 @min-[760px]:grid @min-[760px]:grid-cols-[minmax(0,1fr)_minmax(260px,320px)] @min-[760px]:items-start @min-[760px]:gap-x-12">
        <div className="contents @min-[760px]:flex @min-[760px]:min-w-0 @min-[760px]:flex-col @min-[760px]:gap-6">
          {block(lead, "order-1")}
          {block(did, "order-3")}
          {block(is, "order-4", lead || did ? "border-t border-line pt-6" : "")}
        </div>
        <div className="contents @min-[760px]:flex @min-[760px]:min-w-0 @min-[760px]:flex-col @min-[760px]:gap-6">
          {block(facts, "order-2")}
          {block(side, "order-5", facts ? "border-t border-line pt-6 @min-[760px]:border-t-0 @min-[760px]:pt-0" : "")}
        </div>
      </div>
    </div>
  );
}

export type StepPanelProps = {
  part: Part;
  node: FlowNode | undefined;
  onClose: () => void;
  children: ReactNode;
};

/** How much of the panel's top shows before it counts as out of sight. */
const IN_SIGHT = 160;

export function StepPanel({ part, node, onClose, children }: StepPanelProps) {
  const name = nameOf(part);
  const ref = useRef<HTMLElement>(null);
  // The part shown now, so a close still fading out gives way when the person picks another part.
  const shown = useRef(part.key);
  shown.current = part.key;
  const closing = useRef<{ key: string; stop: () => void } | null>(null);
  useLayoutEffect(() => {
    if (!closing.current || closing.current.key === part.key) return;
    closing.current.stop();
    closing.current = null;
  }, [part.key]);
  // Closed from inside, the focus goes back to the part's node or row, so the person goes on from there.
  const closeRef = useRef(onClose);
  closeRef.current = () => {
    if (closing.current) return;
    const active = document.activeElement;
    const inside = !!ref.current?.contains(active) || active === document.body;
    const key = part.key;
    const stop = leave(ref.current, () => {
      if (shown.current !== key) return;
      closing.current = null;
      onClose();
      if (!inside) return;
      requestAnimationFrame(() => {
        const back = document.querySelector<HTMLElement>(`[data-gnode="${CSS.escape(key)}"]`) ?? document.getElementById(rowId(key));
        back?.focus({ preventScroll: true });
      });
    }, { drop: RISE });
    if (shown.current === key && ref.current?.animate) closing.current = { key, stop };
  };
  const close = () => closeRef.current();
  // Escape closes it, unless something open over the page, such as a menu, takes the key. It
  // leaves the panel open while the person types, so a draft stays, and while they are in the
  // list column open over the page, whose own Escape closes it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector(LAYERS)) return;
      if (pressOf(event).typing) return;
      const column = document.getElementById(COLUMN_ID);
      if (column?.hasAttribute("data-overlay") && (column.contains(event.target as Node) || column.contains(document.activeElement))) return;
      closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  // A part selected while its panel's top is out of sight brings the top into sight: under a tall
  // graph, or after a link at the bottom of the panel selected another part.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el?.scrollIntoView) return;
    const top = el.getBoundingClientRect().top;
    if (top >= 0 && top <= window.innerHeight - IN_SIGHT) return;
    const calm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "start", behavior: calm ? "auto" : "smooth" });
  }, [part.key]);
  const sub = part.t === "leaf" ? part.sub : part.t === "box" ? part.sub : undefined;
  // Another part, picked while the panel shows, brightens its name and body from half. The first one only rises with the panel.
  const swap = useChanged(part.key) ? "animate-swap" : "";
  return (
    <section
      ref={ref}
      aria-label={`Details of ${name}`}
      className="min-w-0 scroll-mt-4 animate-arrive rounded-lg border border-line bg-raised"
    >
      <header className="flex items-start gap-2.5 border-b border-line py-3 pr-2 pl-4">
        <span className="mt-[3px] flex-none">
          <HeadIcon part={part} />
        </span>
        <div key={part.key} className={`flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5 ${swap}`}>
          <h2 className="text-md leading-snug font-medium [overflow-wrap:anywhere]">{name}</h2>
          <p className="text-xs text-muted">
            {kindWords(part, node)}
            {sub && ` · ${sub}`}
          </p>
        </div>
        <span className="-my-1.5 flex-none">
          <IconButton icon={X} label="Close" shortcut="Esc" onClick={close} />
        </span>
      </header>
      <div key={part.key} className={`px-4 pt-4 pb-5 text-sm ${swap}`}>
        {children}
      </div>
    </section>
  );
}
