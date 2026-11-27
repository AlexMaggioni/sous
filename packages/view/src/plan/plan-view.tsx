// The Graph or the Steps view of a workflow or a run, with the selected part's panel under it. Both
// pages use it, so a workflow and its runs read the same way. A press on a step selects it and
// opens its panel. Nothing navigates away.
import { type ReactNode } from "react";
import type { Flow, FlowNode, RunPage } from "../api/contract.ts";
import { FlowGraph } from "../graph/flow-graph.tsx";
import { findPart, type Box, type Leaf, type Part } from "../graph/tree.ts";
import { nodeOf, type Plan } from "./plan.ts";
import { useStepAbout, type About } from "./step-about.tsx";
import { PanelColumns, PlanArea, StepPanel } from "./step-panel.tsx";
import { StepsList } from "./steps-list.tsx";

export type PlanViewProps = {
  view: "graph" | "steps";
  plan: Plan | null;
  flow?: Flow;
  flows?: Record<string, Flow>;
  /** Set on a run's page. */
  run?: RunPage;
  now: number;
  /** The selected part, by its key or by a run step's key. */
  selected?: string;
  onSelect: (key: string | undefined) => void;
  /** The graph's accessible name. */
  label: string;
  /** The project the catalogs are read from. */
  project?: string;
  /** The name of the file the text is in. */
  file?: string;
  /** Shows a line of the text, of the root's or of the nested workflow's. */
  onLine?: (line: number, flow: string | undefined) => void;
  /** The run's side of a step's panel, laid out around what the step is. */
  call?: (leaf: Leaf, about: About, node: FlowNode | undefined) => ReactNode;
  /** The run's side of a room's panel: what its members said. */
  room?: (box: Box, about: About) => ReactNode;
  /** What shows in place of the Steps view when there is no plan. */
  empty: ReactNode;
};

type BodyProps = Pick<PlanViewProps, "flow" | "flows" | "run" | "project" | "onLine" | "file" | "call" | "room"> & {
  part: Part;
  node: FlowNode | undefined;
  plan: Plan;
  onSelect: (key: string) => void;
};

/** The panel's body: the run's side around what the step is, or only what the step is. */
function PanelBody({ part, node, plan, flow, flows, run, project, onSelect, onLine, file, call, room }: BodyProps) {
  const about = useStepAbout({ part, node, flow, flows, graph: plan.graph, project, onSelect, onLine, file });
  // A name made at run time can't be matched to a step of the run until the step starts.
  const unmatched = run && part.t === "leaf" && node?.t === "step" && node.dynamic && !part.step;
  return (
    <>
      {unmatched && <p className="mb-4 max-w-[70ch] text-pretty text-muted">Its name is made at run time, so sous can tell which step of the run it is only once one starts.</p>}
      {run && call && part.t === "leaf" ? (
        call(part, about, node)
      ) : run && room && part.t === "box" && part.kind === "room" ? (
        room(part, about)
      ) : (
        <PanelColumns is={about.main} side={about.side} />
      )}
    </>
  );
}

export function PlanView({ view, plan, flow, flows, run, now, selected, onSelect, label, project, file, onLine, call, room, empty }: PlanViewProps) {
  const part = selected && plan ? findPart(plan.graph, selected) : undefined;
  const node = part ? nodeOf(part, flow, flows) : undefined;
  const panel = part && plan && (
    <StepPanel part={part} node={node} onClose={() => onSelect(undefined)}>
      <PanelBody key={part.key} part={part} node={node} plan={plan} flow={flow} flows={flows} run={run} project={project} onSelect={onSelect} onLine={onLine} file={file} call={call} room={room} />
    </StepPanel>
  );
  return (
    <PlanArea view={view} panel={panel}>
      {view === "graph" ? (
        <FlowGraph plan={plan} flow={flow} run={!!run} selected={part?.key} onSelect={onSelect} label={label} />
      ) : plan ? (
        <StepsList plan={plan} flow={flow} flows={flows} run={run} now={now} selected={part?.key} onSelect={onSelect} />
      ) : (
        empty
      )}
    </PlanArea>
  );
}
