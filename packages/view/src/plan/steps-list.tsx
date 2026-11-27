// The Steps view: the plan the graph draws, as rows in the order the text runs them, each group's
// steps indented under it. On a workflow, the right column shows what each step does. On a run,
// it shows each step's time on one axis, with a bar for each time it ran. Under 900px the axis
// hides. A row selects its part, and the panel under the view shows it.
import { ChevronRight, CircleStop, GitBranch, GitFork, Repeat, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { Flow, FlowStep, RunPage, Step } from "../api/contract.ts";
import { formatDuration, tickLabel } from "../format.ts";
import { kindOf } from "../graph/graph-node.tsx";
import { boxIcon, kidsOf, type Leaf, type Part } from "../graph/tree.ts";
import { barOf, lastMoment, runAxis, stepDuration, ticksOf, type Axis } from "../pages/run/time-axis.ts";
import { isLive } from "../status.ts";
import { useListMotion, useWash } from "../ui/motion.ts";
import { StatusIcon, type Status } from "../ui/status-icon.tsx";
import { nameOf, nodeOf, type Plan } from "./plan.ts";
import { groupsAround, planRows, startFolded, type PlanRow } from "./rows.ts";

/** Running, failed and needs-you bars take their color. Every other bar is gray. */
const BAR: Partial<Record<Status, string>> = {
  running: "border-run bg-run-tint",
  failed: "border-fail bg-fail-tint",
  needs: "border-needs bg-needs-tint",
};
const GRAY_BAR = "border-line-strong bg-done-tint";

export const rowId = (key: string) => `plan-row-${key.replace(/[^\w-]/g, "_")}`;
const pct = (n: number) => `${Math.round(n * 1000) / 1000}%`;
const firstLine = (s: string | undefined) => s?.split("\n").find((l) => l.trim())?.trim();

/** The icon of a part that has no status: its kind, in gray. */
function iconOf(part: Part): LucideIcon {
  if (part.t === "leaf") return kindOf(part.kind).icon;
  if (part.t === "box") return part.kind === "loop" ? Repeat : kindOf(boxIcon(part)).icon;
  if (part.t === "par") return part.conds ? GitBranch : GitFork;
  if (part.t === "iff") return GitBranch;
  return CircleStop;
}

function PartIcon({ part }: { part: Part }) {
  const status = part.t === "leaf" || part.t === "box" ? part.status : undefined;
  if (status) return <StatusIcon status={status} />;
  const Icon = iconOf(part);
  return <Icon size={14} strokeWidth={1.5} aria-hidden="true" className="flex-none text-icon" />;
}

/** What a step does, in one line, for the right column of a saved workflow. */
function settingOf(part: Part, node: ReturnType<typeof nodeOf>): { text: string; code?: boolean } | null {
  if (part.t === "box" && part.kind === "loop") return part.again ? { text: part.again } : null;
  if (node?.t !== "step") return null;
  const step: FlowStep = node;
  switch (step.kind) {
    case "agent":
    case "choose":
      return step.prompt ? { text: firstLine(step.prompt) ?? "" } : step.model ? { text: step.model } : null;
    case "sh":
    case "js":
    case "py":
    case "run":
    case "wait":
      return step.code ? { text: firstLine(step.code) ?? "", code: true } : null;
    case "ask":
      return step.options?.choices?.length ? { text: step.options.choices.join(" / ") } : { text: "asks you" };
    case "breakpoint":
      return { text: "waits for your yes" };
    case "workflow":
      return step.workflow && step.workflow !== step.label ? { text: step.workflow } : null;
    case "room":
      return step.prompt ? { text: firstLine(step.prompt) ?? "" } : step.members?.length ? { text: step.members.join(", ") } : null;
  }
}

/** The steps of each leaf inside a part, for the time a group took. */
function leavesOf(part: Part, out: Leaf[] = []): Leaf[] {
  if (part.t === "leaf") out.push(part);
  for (const kid of kidsOf(part)) leavesOf(kid, out);
  return out;
}

/** Each time a part ran, as steps of the run. A group's are the steps of every leaf inside it. */
function stepsOfPart(part: Part, byKey: ReadonlyMap<string, Step>): Step[] {
  return leavesOf(part).flatMap((leaf) => (leaf.calls ?? (leaf.step ? [leaf.step] : [])).map((k) => byKey.get(k)).filter((s): s is Step => !!s));
}

const startOf = (s: Step) => (s.startedAt ? Date.parse(s.startedAt) : undefined);
const endOf = (s: Step, until: number) => {
  const start = startOf(s);
  const ms = stepDuration(s, until);
  return start !== undefined && ms !== undefined ? start + ms : until;
};

function Ticks({ axis }: { axis: Axis }) {
  return ticksOf(axis).map((t) => <span key={t} className="absolute inset-y-0 w-px bg-line" style={{ left: pct((t / axis.end) * 100) }} />);
}

/** The header row: "Step" over the rows, the tick labels over the timeline. It stays on top as the page scrolls. */
function AxisRow({ axis }: { axis: Axis }) {
  const labels = ticksOf(axis).filter((t) => axis.open || axis.end - t > axis.step * 0.45);
  return (
    <div aria-hidden="true" className="sticky top-0 z-[4] grid h-8 grid-cols-[var(--lc)_minmax(0,1fr)] border-b border-line bg-base text-xs text-muted max-[899px]:grid-cols-1">
      <div className="flex items-center pr-3 pl-1">
        <span className="flex-1">Step</span>
        <span>Duration</span>
      </div>
      <div className="relative overflow-hidden border-l border-line max-[899px]:hidden">
        <span className="absolute top-2 pl-1 font-mono">0s</span>
        {labels.map((t) => (
          <span key={t} className="absolute top-2 -translate-x-1/2 font-mono whitespace-nowrap" style={{ left: pct((t / axis.end) * 100) }}>
            {tickLabel(t)}
          </span>
        ))}
      </div>
    </div>
  );
}

/** A bar for each time the part ran. A group has one bar, thinner, from its first start to its last end. */
function TimelineCell({ part, steps, axis, until }: { part: Part; steps: Step[]; axis: Axis; until: number }) {
  const leaf = part.t === "leaf";
  const shape = leaf ? "top-[9px] h-[18px] rounded-sm" : "top-[15px] h-1.5 rounded-[3px]";
  const spans: Array<{ start: number | undefined; end: number; status: Status; open: boolean }> = leaf
    ? steps.map((s) => ({ start: startOf(s), end: endOf(s, until), status: s.status, open: !s.endedAt && isLive(s.status) }))
    : steps.length
      ? [
          {
            start: Math.min(...steps.map((s) => startOf(s) ?? Infinity)),
            end: Math.max(...steps.map((s) => endOf(s, until))),
            status: (part.t === "box" && part.status) || "done",
            open: steps.some((s) => !s.endedAt && isLive(s.status)),
          },
        ]
      : [];
  return (
    <div aria-hidden="true" className="relative overflow-hidden border-b border-l border-line max-[899px]:hidden">
      <Ticks axis={axis} />
      {spans.map((span, i) => {
        const bar = barOf(axis, Number.isFinite(span.start) ? span.start : undefined, span.end);
        if (!bar) return null;
        return (
          <span
            key={i}
            className={`absolute min-w-[3px] border ${shape} ${BAR[span.status] ?? GRAY_BAR} ${span.open ? "rounded-r-none border-r-0" : ""}`}
            style={{ left: `min(${pct(bar.left)}, calc(100% - 3px))`, width: pct(bar.width) }}
          />
        );
      })}
    </div>
  );
}

/** The time a row shows: the part's own, else the span of the steps inside it. */
function durationText(part: Part, steps: Step[], until: number): string {
  const status = part.t === "leaf" || part.t === "box" ? part.status : undefined;
  if (status === "skipped") return "skipped";
  if (part.t === "leaf" || part.t === "box") return part.duration ?? "";
  const starts = steps.map(startOf).filter((t): t is number => t !== undefined);
  if (!starts.length) return "";
  return formatDuration(Math.max(...steps.map((s) => endOf(s, until))) - Math.min(...starts));
}

type RowProps = {
  row: PlanRow;
  selected: boolean;
  folded: boolean;
  onSelect: () => void;
  onFold: () => void;
  right: ReactNode;
  side?: ReactNode;
};

function Row({ row, selected, folded, onSelect, onFold, right, side }: RowProps) {
  const { part, depth } = row;
  const wash = useWash(part.t === "leaf" || part.t === "box" ? (part.status === "needs" || part.needs ? "needs" : part.status) : undefined);
  const quiet = (part.t === "leaf" || part.t === "box") && (part.status === "queued" || part.status === "skipped");
  const sub = part.t === "leaf" ? part.sub : part.t === "box" ? part.sub : undefined;
  const guides = Array.from({ length: depth }, (_, i) => (
    <span key={i} aria-hidden="true" className="relative w-4 flex-none self-stretch before:absolute before:inset-y-0 before:left-[7px] before:w-px before:bg-line-strong" />
  ));
  const cols = side ? "grid-cols-[var(--lc)_minmax(0,1fr)] max-[899px]:grid-cols-1" : "grid-cols-1";
  if (row.lane) {
    return (
      <div className={`grid ${cols}`}>
        <div className="flex h-8 min-w-0 items-center gap-1.5 border-b border-line pr-3 pl-1 text-xs text-muted">
          {guides}
          <span className="w-5 flex-none" />
          <span className="min-w-0 truncate font-mono">{row.lane}</span>
        </div>
        {side}
      </div>
    );
  }
  return (
    <div className={`grid ${cols} transition-colors ${selected ? "bg-selected" : ""} ${wash}`}>
      <div className="flex h-9 min-w-0 items-stretch border-b border-line pl-1 max-[699px]:h-10">
        {guides}
        {row.group ? (
          <button
            type="button"
            aria-label={`${folded ? "Open" : "Fold"} ${nameOf(part)}`}
            aria-expanded={!folded}
            onClick={onFold}
            className="flex w-5 flex-none items-center justify-center rounded-sm text-icon hover:bg-hover"
          >
            <ChevronRight size={14} strokeWidth={1.5} aria-hidden="true" className={`transition-transform motion-reduce:transition-none ${folded ? "" : "rotate-90"}`} />
          </button>
        ) : (
          <span className="w-5 flex-none" />
        )}
        <button
          type="button"
          id={rowId(part.key)}
          aria-current={selected ? "true" : undefined}
          onClick={onSelect}
          className={`flex min-w-0 flex-1 items-center gap-1.5 pr-3 pl-1 text-left transition-colors ${selected ? "" : "hover:bg-hover"}`}
        >
          <PartIcon part={part} />
          <span className={`min-w-0 truncate text-xs ${part.t === "leaf" ? "font-mono" : "font-medium"} ${quiet ? "text-muted" : ""}`}>{nameOf(part)}</span>
          {sub && <span className="min-w-0 flex-none truncate text-xs text-muted">{sub}</span>}
          <span className="min-w-0 flex-1" />
          {right}
        </button>
      </div>
      {side}
    </div>
  );
}

export type StepsListProps = {
  plan: Plan;
  flow?: Flow;
  flows?: Record<string, Flow>;
  /** Set on a run's page: the right column shows time instead of what each step does. */
  run?: RunPage;
  now: number;
  selected?: string;
  onSelect: (key: string) => void;
};

export function StepsList({ plan, flow, flows, run, now, selected, onSelect }: StepsListProps) {
  const graph = plan.graph;
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map());
  // A part selected elsewhere, such as in the graph, opens the groups around it once. A press on
  // one of those groups after that folds it, even with the part still selected.
  const [shownFor, setShownFor] = useState(selected);
  if (selected !== shownFor) {
    setShownFor(selected);
    const around = selected ? groupsAround(graph, selected) : [];
    if (around.length) setToggled((map) => new Map([...map, ...around.map((key) => [key, false] as const)]));
  }
  const folded = useMemo(() => {
    const out = startFolded(graph);
    for (const key of shownFor ? groupsAround(graph, shownFor) : []) out.delete(key);
    for (const [key, isFolded] of toggled) (isFolded ? out.add(key) : out.delete(key));
    return out;
  }, [graph, toggled, shownFor]);
  const rows = planRows(graph, folded);
  // A fold or a new step slides the rows below to their new places, and the new rows fade in.
  const list = useRef<HTMLUListElement>(null);
  useListMotion(list, rows.map((r) => r.key).join(" "));
  const byKey = useMemo(() => new Map((run?.steps ?? []).map((s) => [s.key, s])), [run?.steps]);

  // A part selected elsewhere comes into view, without taking the focus from where the person is.
  useEffect(() => {
    if (!selected) return;
    const button = document.getElementById(rowId(selected));
    if (button && button !== document.activeElement) button.scrollIntoView?.({ block: "nearest" });
  }, [selected]);

  const axis = run ? runAxis(run, now) : null;
  const until = run ? lastMoment(run, now) : now;
  const style = axis ? ({ "--now": String(Math.min(1, (now - axis.from) / axis.end)) } as CSSProperties) : undefined;
  return (
    <section aria-labelledby="steps-heading" className={`relative ${axis ? "[--lc:360px] max-[1099px]:[--lc:300px]" : ""}`} style={style}>
      <h2 id="steps-heading" className="sr-only">
        Steps
      </h2>
      {axis && <AxisRow axis={axis} />}
      <ul ref={list} className={`m-0 list-none p-0 ${axis ? "" : "border-t border-line"}`}>
        {rows.map((row) => {
          const steps = run ? stepsOfPart(row.part, byKey) : [];
          let right: ReactNode = null;
          if (run) {
            right = <span className="min-w-[54px] flex-none text-right font-mono text-xs text-muted tabular-nums">{durationText(row.part, steps, until)}</span>;
          } else {
            const setting = settingOf(row.part, nodeOf(row.part, flow, flows));
            if (setting?.text)
              right = <span className={`max-w-[55%] min-w-0 truncate text-right text-xs text-muted ${setting.code ? "font-mono" : ""}`}>{setting.text}</span>;
          }
          return (
            <li key={row.key} data-motion-key={row.key}>
              <Row
                row={row}
                selected={row.part.key === selected}
                folded={folded.has(row.part.key)}
                onSelect={() => onSelect(row.part.key)}
                onFold={() => setToggled((map) => new Map(map).set(row.part.key, !folded.has(row.part.key)))}
                right={right}
                side={axis ? <TimelineCell part={row.part} steps={steps} axis={axis} until={until} /> : undefined}
              />
            </li>
          );
        })}
      </ul>
      {axis?.open && run && isLive(run.status) && (
        <div aria-hidden="true" className="pointer-events-none absolute top-8 bottom-0 left-[calc(var(--lc)+(100%-var(--lc))*var(--now))] z-[2] w-0 border-l border-dashed border-run max-[899px]:hidden" />
      )}
    </section>
  );
}
