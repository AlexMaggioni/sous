import { useState } from "react";
import { FlowGraph } from "../graph/flow-graph.tsx";
import { useNow } from "../pages/run/use-now.ts";
import { GRAPH_STATES, planOfState } from "./fixtures.ts";
import { KitSection } from "./kit-section.tsx";

/** The graph of a saved workflow and of a run, in each state. A click on a node selects it and says which. */
export function GraphSection() {
  const [selected, setSelected] = useState<{ graph: string; key: string }>();
  // The running steps' times count up, as on a run's page.
  const now = useNow(true);
  return (
    <KitSection id="kit-graph" title="Graph">
      <p role="status" className="mb-6 text-muted">
        {selected ? `Selected ${selected.key} of "${selected.graph}".` : "Nothing selected yet. Select a node."}
      </p>
      <div className="flex flex-col gap-10">
        {GRAPH_STATES.map((s) => (
          <div key={s.title}>
            <h3 className="mb-1">{s.title}</h3>
            <p className="mb-3 text-muted">{s.note}</p>
            <FlowGraph
              plan={planOfState(s.props, now)}
              flow={s.props.flow}
              run={!!s.props.steps}
              label={`Graph, ${s.title.toLowerCase()}`}
              selected={selected?.graph === s.title ? selected.key : undefined}
              onSelect={(key) => setSelected({ graph: s.title, key })}
            />
          </div>
        ))}
      </div>
    </KitSection>
  );
}
