// Both readers find a handle the same way. A name declared with a session() or a fork() and never
// assigned again holds that handle, whether the text declares it with const or let. A name
// assigned more than once, or declared with no value and assigned later, holds a handle made at
// run time: the graph draws its sends with the run-time note, and the script's reader lists them
// with no label.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { workflowFlow, type FlowNode, type FlowStep } from "../../src/workflows/flow.js";
import { readWorkflowScript } from "../../src/workflows/script.js";

const META = `export const meta = { name: "demo", description: "A demo" }`;

/** A workflow text whose body starts on line 2. */
const wf = (body: string) => `${META}\n${body.trim()}\n`;

function steps(nodes: FlowNode[]): FlowStep[] {
  return nodes.flatMap((node) => {
    const inner = node.t === "step" ? [node.body ?? []] : node.t === "loop" ? [node.body] : node.t === "if" ? [node.then, node.else ?? []] : node.t === "parallel" ? node.branches : node.t === "pipeline" ? node.stages : [];
    return [...(node.t === "step" ? [node] : []), ...inner.flatMap(steps)];
  });
}

describe("a handle kept in a name", () => {
  it("a let assigned once is a handle for both readers", () => {
    const text = wf(`
let impl = session({ label: "impl", agentType: "implementer" })
await impl.send("Go.")
`);
    const flow = workflowFlow(text);
    assert.deepEqual(
      steps(flow.nodes).map((step) => [step.label, step.agent, step.options?.session]),
      [["impl", "implementer", "impl"]],
    );
    assert.deepEqual(flow.notes, []);
    assert.deepEqual(readWorkflowScript(text).refs.calls, [{ kind: "agent", label: "impl", agent: "implementer", session: "impl" }]);
  });

  it("a name assigned again holds a handle made at run time for both readers", () => {
    const text = wf(`
let impl = session({ label: "one", agentType: "a" })
impl = session({ label: "two", agentType: "b" })
await impl.send("Go.")
let later
later = session({ label: "later", agentType: "c" })
await later.send("Go.")
`);
    const flow = workflowFlow(text);
    assert.deepEqual(
      steps(flow.nodes).map((step) => [step.label, step.agent, step.dynamic]),
      [
        ["{impl}", undefined, true],
        ["{later}", undefined, true],
      ],
    );
    assert.deepEqual(flow.notes, [
      "The send() on line 4 goes to a session made at run time, so its label is not known.",
      "The send() on line 7 goes to a session made at run time, so its label is not known.",
    ]);
    assert.deepEqual(readWorkflowScript(text).refs.calls, [{ kind: "agent" }, { kind: "agent" }]);
  });
});
