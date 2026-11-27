// A .send() is a step only on a session handle. When the text shows that the target is something
// else, such as an object literal, a new expression or another function's result, the call is no
// step: the graph draws nothing, the script's reader lists no call, and `sous check` gives no
// prompt note. A target the readers can't resolve, such as a function's parameter, is still a send
// on a handle made at run time, with its note.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkWorkflow } from "../../src/workflows/check.js";
import { workflowFlow, type FlowNode, type FlowStep } from "../../src/workflows/flow.js";
import { readWorkflowScript } from "../../src/workflows/script.js";
import { setup } from "../runs/fixture.js";

const META = `export const meta = { name: "demo", description: "A demo" }`;

/** A workflow text whose body starts on line 2. */
const wf = (body: string) => `${META}\n${body.trim()}\n`;

/** Every step of a flow, nested ones too, in order. */
function steps(nodes: FlowNode[]): FlowStep[] {
  return nodes.flatMap((node) => {
    const inner = node.t === "step" ? [node.body ?? []] : node.t === "loop" ? [node.body] : node.t === "if" ? [node.then, node.else ?? []] : node.t === "parallel" ? node.branches : node.t === "pipeline" ? node.stages : [];
    return [...(node.t === "step" ? [node] : []), ...inner.flatMap(steps)];
  });
}

/** Lines 2 to 11: sends on targets the text shows are no handle, then a send on a handle, then one on a parameter. */
const TEXT = wf(`
const ws = { send: (x) => x }
ws.send(args.m)
const socket = new WebSocket("ws://x")
socket.send(args.m)
new WebSocket("ws://y").send(args.m)
const client = connect()
client.send(args.m)
client.fork({ label: "copy" }).send(args.m)
const impl = session({ label: "impl", agentType: "implementer" })
await impl.send("Go.")
await parallel(args.reviewers.map((p) => () => p.send("Review it.")))
`);

describe("a .send() on a target that is no handle", () => {
  it("is no step in the graph, and a send on a parameter is a step with the run-time note", () => {
    const flow = workflowFlow(TEXT);
    assert.deepEqual(
      steps(flow.nodes).map((step) => [step.kind, step.label, step.agent, step.dynamic]),
      [
        ["agent", "impl", "implementer", undefined],
        ["agent", "{p}", undefined, true],
      ],
    );
    assert.deepEqual(flow.notes, ["The send() on line 12 goes to a session made at run time, so its label is not known."]);
  });

  it("gives no lost-step note from inside a function the graph can't follow", () => {
    const flow = workflowFlow(
      wf(`
const ws = { send: (x) => x }
const impl = session({ label: "impl" })
register(() => ws.send("x"))
register(() => impl.send("y"))
`),
    );
    assert.deepEqual(flow.notes, ["The step on line 5 is inside a function sous can't follow, so the graph leaves it out."]);
  });

  it("is no call for the script's reader, and is no run-time prompt", () => {
    const { refs } = readWorkflowScript(TEXT);
    assert.deepEqual(refs.calls, [{ kind: "agent", label: "impl", agent: "implementer", session: "impl" }, { kind: "agent" }]);
    assert.deepEqual(refs.runTimePrompts, []);
  });

  it("gives no prompt note in sous check", () => {
    const { paths, projectDir } = setup({
      sends: [`export const meta = { name: 'sends', description: 'd' }`, "const ws = { send: (x) => x }", "ws.send(args.m)", "const socket = new WebSocket('ws://x')", "socket.send(args.m)", "const p = pick()", "p.send(args.m)"].join("\n"),
    });
    const notes = checkWorkflow(paths, projectDir, "sends").notes.filter((note) => note !== "declares no inputs, so it takes any");
    assert.deepEqual(notes, []);
  });
});
