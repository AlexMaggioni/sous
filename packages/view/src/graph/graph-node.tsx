// A graph's nodes and boxes, as HTML over the SVG of its edges. A node holds its icon, its name,
// then muted the agent, the retries, the count and the duration. Only the icon has color, except
// for a moment when a step fails or starts needing the person: its node washes in that tint once.
import {
  Bot,
  Code,
  Clock,
  GitFork,
  Inbox,
  Layers,
  MessageCircleQuestion,
  Minus,
  OctagonPause,
  SquareTerminal,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { IconButton } from "../ui/button.tsx";
import { useWash } from "../ui/motion.ts";
import { STATUS_LABEL, StatusIcon } from "../ui/status-icon.tsx";
import { Tip } from "../ui/tooltip.tsx";
import type { Measure } from "./measure.ts";
import type { Box, KindIcon, Leaf } from "./tree.ts";

const KIND: Record<KindIcon, { icon: LucideIcon; name: string }> = {
  agent: { icon: Bot, name: "agent" },
  sh: { icon: SquareTerminal, name: "sh" },
  run: { icon: SquareTerminal, name: "run" },
  js: { icon: Code, name: "js" },
  py: { icon: Code, name: "py" },
  wait: { icon: Clock, name: "waitUntil" },
  ask: { icon: MessageCircleQuestion, name: "ask" },
  checkpoint: { icon: Inbox, name: "checkpoint" },
  breakpoint: { icon: OctagonPause, name: "breakpoint" },
  workflow: { icon: Workflow, name: "workflow" },
  choose: { icon: GitFork, name: "choose" },
  pipeline: { icon: Layers, name: "pipeline" },
};

/** The icon of a kind of step, and its name as the text writes it. */
export const kindOf = (kind: KindIcon) => KIND[kind];

/** The icon of a node: its status in a run, else its kind in gray. */
function NodeIcon({ part }: { part: Leaf | Box }) {
  if (part.status) return <StatusIcon status={part.status} label={false} />;
  const kind: KindIcon = part.t === "leaf" ? part.kind : part.kind === "pipeline" ? "pipeline" : "workflow";
  const Icon = KIND[kind].icon;
  return <Icon size={14} strokeWidth={1.5} aria-hidden="true" className="flex-none text-icon" />;
}

export type NodeActions = {
  /** Set in a run's graph. */
  run: boolean;
  /** The key of the selected part, whose panel is open beside the graph. */
  selected?: string;
  /** The person selected a part, by its key. */
  onSelect?: (key: string) => void;
  onFold: (key: string, folded: boolean) => void;
};

/** The words a node shows, in the order they show, without the ↻ and × signs. */
function shownWords(part: Leaf | Box): string[] {
  const box = part.t === "box";
  const retries = part.t === "leaf" ? part.retries : undefined;
  return [box ? part.title : part.label, box ? part.foldSub : part.sub, retries?.slice(2), part.count?.slice(1), part.duration].filter((s): s is string => !!s);
}

/**
 * What a node says to a screen reader: the words it shows, together and in their order, as axe's
 * label-in-name rule asks, then what only its icon and signs say.
 */
export function describeNode(part: Leaf | Box, run: boolean): string {
  const box = part.t === "box";
  const name = box ? part.title : part.label;
  const retries = part.t === "leaf" ? part.retries?.slice(2) : undefined;
  const kind = !run && part.t === "leaf" ? KIND[part.kind].name : box ? (part.kind === "pipeline" ? "pipeline" : "workflow") : "";
  const rest = [
    kind && kind !== name ? kind : "",
    part.count ? `${part.count.slice(1)} items` : "",
    part.status ? STATUS_LABEL[part.status].toLowerCase() : "",
    retries ? (run ? `retried ${retries}` : `up to ${retries} retries`) : "",
    part.bad ? "a step inside failed" : "",
    part.needs && part.status !== "needs" ? "a step inside needs you" : "",
  ].filter(Boolean);
  return [shownWords(part).join(" "), ...rest].join(", ");
}

export function GraphNode({ part, x, y, w, h, actions, measure }: { part: Leaf | Box; x: number; y: number; w: number; h: number; actions: NodeActions; measure: Measure }) {
  const box = part.t === "box";
  const name = box ? part.title : part.label;
  const sub = box ? part.foldSub : part.sub;
  const retries = part.t === "leaf" ? part.retries : undefined;
  // The room the name has once the icon and the muted text took theirs.
  const room =
    w - 46 - [sub, retries].reduce((a, s) => a + (s ? 8 + measure(s, "label") : 0), 0) - [part.count, part.duration].reduce((a, s) => a + (s ? 8 + measure(s, "mono") : 0), 0);
  const cut = measure(name, "name") > room;
  // A press selects the part, so its panel opens beside the graph. A folded box opens too.
  const unfold = box && part.foldable && part.body;
  const select = actions.onSelect;
  const open = select || unfold ? () => {
    select?.(part.key);
    if (unfold) actions.onFold(part.key, false);
  } : undefined;
  const tip = part.tip ?? (cut ? name : "");
  const needs = part.needs || part.status === "needs";
  const quiet = part.status === "queued" || part.status === "skipped";
  const selected = actions.selected === part.key;
  const wash = useWash(needs ? "needs" : part.status);
  // The selected node takes the text color for its border, 1.5px like a node that needs the person.
  const border = needs ? "border-[1.5px] border-needs px-[9.5px]" : selected ? "border-[1.5px] border-fg px-[9.5px]" : `px-2.5 ${part.bad ? "border-fail" : "border-line"}`;
  const look = `absolute flex items-center gap-2 rounded-md border text-left text-sm text-fg transition-[border-color,background-color,scale] ${selected ? "bg-selected" : "bg-raised"} ${border} ${wash}`;
  const inside: ReactNode = (
    <>
      <NodeIcon part={part} />
      <span className={`min-w-0 flex-1 whitespace-nowrap ${cut ? "fade-end" : ""} ${quiet ? "text-muted" : ""}`}>{name}</span>
      {/* A space before each muted part keeps the words apart for axe. It doesn't render in a flex row. */}
      {sub && <> <span className="flex-none text-xs whitespace-nowrap text-muted">{sub}</span></>}
      {retries && <> <span className="flex-none text-xs whitespace-nowrap text-muted">{retries}</span></>}
      {part.count && <> <span className="mono flex-none text-muted">{part.count}</span></>}
      {part.duration && <> <span className="mono flex-none text-muted">{part.duration}</span></>}
    </>
  );
  const style = { left: x, top: y, width: w, height: h };
  const label = describeNode(part, actions.run);
  // A node with a tooltip is a button even when it opens nothing, as tooltip.tsx asks.
  const el =
    open || tip ? (
      <button
        type="button"
        data-gnode={part.key}
        data-motion-key={part.key}
        aria-label={label}
        aria-current={selected ? "true" : undefined}
        aria-expanded={unfold ? false : undefined}
        onClick={open}
        className={`${look} ${open ? `motion-safe:active:scale-[0.98] ${selected || needs ? "" : "hover:border-icon"}` : "cursor-default"}`}
        style={style}
      >
        {inside}
      </button>
    ) : (
      <div role="group" tabIndex={0} data-gnode={part.key} data-motion-key={part.key} aria-label={label} className={look} style={style}>
        {inside}
      </div>
    );
  return tip ? <Tip text={tip}>{el}</Tip> : el;
}

/**
 * The frame of an open loop, nested workflow or pipeline. Its head draws with the nodes. It takes
 * the key of its part, so the frame grows out of the folded node as it opens.
 */
export function GraphBox({ part, x, y, w, h, selected }: { part: Box; x: number; y: number; w: number; h: number; selected?: boolean }) {
  return (
    <div
      aria-hidden="true"
      data-motion-key={part.key}
      data-motion-resize
      className={`absolute rounded-lg border ${part.needs ? "border-needs" : selected ? "border-fg" : "border-line-strong"} ${part.kind !== "loop" ? "bg-base" : ""}`}
      style={{ left: x, top: y, width: w, height: h }}
    />
  );
}

/**
 * An open box's name at its top left, with its fold button. It draws in the nodes' order, just
 * before the box's first node, so Tab reaches the fold button where the box starts. As the box
 * opens, it brightens from half and rides the frame's corner from where the folded node was.
 */
export function GraphBoxHead({ part, x, y, w, inset, actions }: { part: Box; x: number; y: number; w: number; inset: number; actions: NodeActions }) {
  const filled = part.kind !== "loop";
  return (
    // Inside the frame's 1px border, where it drew as the frame's child.
    <div data-motion-key={`head ${part.key}`} data-motion-swap={part.key} className="absolute flex h-7 items-center gap-1.5 pr-1 text-xs text-muted" style={{ left: x + 1, top: y + 1, width: w - 2, paddingLeft: inset }}>
      {filled && <NodeIcon part={part} />}
      {actions.onSelect ? (
        <button
          type="button"
          aria-current={actions.selected === part.key ? "true" : undefined}
          onClick={() => actions.onSelect?.(part.key)}
          className={`flex-none rounded-sm font-medium whitespace-nowrap text-fg underline-offset-2 hover:underline ${actions.selected === part.key ? "underline" : ""}`}
        >
          {part.title}
        </button>
      ) : (
        <span className="flex-none font-medium whitespace-nowrap text-fg">{part.title}</span>
      )}
      {part.count && <span className="mono flex-none">{part.count}</span>}
      {part.sub && <span className="min-w-0 truncate">{part.sub}</span>}
      {part.status && filled && <span className="sr-only">{STATUS_LABEL[part.status]}</span>}
      {part.foldable && (
        <IconButton icon={Minus} label={`Fold ${part.title}`} size="sm" data-gfold={part.key} className="ml-auto" onClick={() => actions.onFold(part.key, true)} />
      )}
    </div>
  );
}
