// The graph in words, for a screen reader: the steps in order as nested lists, with each branch,
// condition, loop and box. It shows every step, folded or not.
import type { ReactNode } from "react";
import { describeNode } from "./graph-node.tsx";
import type { Part, Seq } from "./tree.ts";

function items(seq: Seq, run: boolean): ReactNode {
  return seq.items.map((p) => <OutlineItem key={p.key} part={p} run={run} />);
}

function OutlineItem({ part, run }: { part: Part; run: boolean }): ReactNode {
  switch (part.t) {
    case "start":
      return null;
    case "end":
      return <li>The workflow ends.</li>;
    case "leaf":
      return <li>{describeNode(part, run)}</li>;
    case "seq":
      return items(part, run);
    case "ret":
      return <li>{`If ${part.edge}, the workflow ${part.outcome}.`}</li>;
    case "iff":
      return (
        <li>
          {`${part.label[0].toUpperCase()}${part.label.slice(1)}:`}
          <ol>{items(part.body, run)}</ol>
        </li>
      );
    case "par":
      return (
        <li>
          {part.conds ? "One of these, by condition:" : `${part.lanes.length} branches at once:`}
          <ul>
            {part.lanes.map((lane, i) => (
              <li key={lane.key}>
                {part.conds ? `${part.conds[i]}:` : `Branch ${i + 1}:`}
                <ol>{items(lane, run)}</ol>
              </li>
            ))}
          </ul>
        </li>
      );
    case "box": {
      const head = part.kind === "loop" ? [part.title, part.sub, `repeats, ${part.again}`].filter(Boolean).join(", ") : describeNode(part, run);
      return (
        <li>
          {part.body ? `${head}:` : head}
          {part.body && <ol>{items(part.body, run)}</ol>}
        </li>
      );
    }
  }
}

/** The steps in order, hidden from sight. */
export function GraphOutline({ graph, run }: { graph: Seq; run: boolean }) {
  return (
    <ol aria-label="The graph's steps, in order" className="sr-only">
      {items(graph, run)}
    </ol>
  );
}
