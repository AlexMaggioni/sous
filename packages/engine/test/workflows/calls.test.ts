// Piece 10, the parse's calls. readWorkflowScript reads each agent, sh, js, py, ask, breakpoint
// and workflow call of a script, in the order written, with its literal label. `sous workflows
// show` builds its steps from them, so an agent can say what a workflow does without running it.
//
// Decisions taken here, where the design leaves a choice:
// - The calls sit on `refs.calls`, next to the other names the parse reads (ScriptRefs). The
//   design says "readWorkflowScript gains calls", and refs is where that parse's results live.
// - A call is { kind, label?, title?, agent?, model?, session?, workflow? }. `label` is the
//   literal `label` option only. A label built at run time is left out, since the parse cannot
//   know it, and so is the label sous makes up at run time (such as "sh: echo ok").
// - ask() and breakpoint() take no label option. They carry `title`, their literal first
//   argument, so an agent can tell the person what the workflow will stop to ask. The other
//   option was a breakpoint with nothing but its kind, which tells the person little.
// - An agent call carries the step's literal agentType as `agent` and its literal model. A send
//   on a session handle is an agent call too: it carries its handle's agentType and model, its
//   own label or else its handle's, and the handle's label as `session`. A workflow call carries
//   the literal name it starts.
// - A loop shows its calls once, and a call on an object, such as tools.sh(), is not a step,
//   the same as the parse reads workflow() and run() today.
//
// The fixtures are the cli's, read as text from packages/cli/test/fixtures, so the outline the
// cli prints and this parse agree on the same files. Nothing is imported from the cli.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readWorkflowScript } from "../../src/workflows/script.js";

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "cli", "test", "fixtures", "workflows");
const fixture = (name: string) => readFileSync(join(FIXTURES, `${name}.js`), "utf8");

interface Call {
  kind: string;
  label?: string;
  title?: string;
  agent?: string;
  model?: string;
  session?: string;
  workflow?: string;
}

/** The calls the parse reads, or a failed assertion that says the parse has none. */
function callsOf(script: string): Call[] {
  const refs = readWorkflowScript(script).refs as unknown as { calls?: Call[] };
  assert.ok(Array.isArray(refs.calls), `readWorkflowScript(...).refs has no calls list: ${JSON.stringify(Object.keys(refs))}`);
  return refs.calls!;
}

const pairs = (calls: Call[]) => calls.map((call) => [call.kind, call.label]);

describe("piece 10: the calls of a workflow script", () => {
  it("the fails fixture gives sh prepare, then sh boom", () => {
    assert.deepEqual(pairs(callsOf(fixture("fails"))), [
      ["sh", "prepare"],
      ["sh", "boom"],
    ]);
  });

  it("the review fixture gives the breakpoint, with its title, then the js call labeled draft inside it", () => {
    const calls = callsOf(fixture("review"));
    assert.deepEqual(pairs(calls), [
      ["breakpoint", undefined],
      ["js", "draft"],
    ]);
    assert.equal(calls[0]!.title, "Approve the release notes");
  });

  it("an ask carries its question as its title", () => {
    const calls = callsOf(fixture("asks"));
    assert.deepEqual(calls.map((call) => [call.kind, call.title]), [["ask", "Which color?"]]);
  });

  it("reads every kind in the order written, with an agent's name, model and session, and the workflow a call starts", () => {
    const calls = callsOf(`export const meta = { name: "ticket", description: "Implement a ticket" }
const impl = session({ agentType: "implementer", label: "implementer", model: "claude/haiku" })
const built = await impl.send("Implement it")
await sh("git diff", { label: "diff" })
await py("print(1)", null, { label: "count" })
const color = await ask("Which color?", { choices: ["red", "blue"] })
await js("return 1", null, { label: "sum" })
await workflow("greet", {}, { label: "inner" })
await agent("Review it", { agentType: "reviewer", label: "reviewer" })
return built`);
    assert.deepEqual(pairs(calls), [
      ["agent", "implementer"],
      ["sh", "diff"],
      ["py", "count"],
      ["ask", undefined],
      ["js", "sum"],
      ["workflow", "inner"],
      ["agent", "reviewer"],
    ]);
    assert.equal(calls[0]!.agent, "implementer");
    assert.equal(calls[0]!.model, "claude/haiku");
    assert.equal(calls[0]!.session, "implementer");
    assert.equal(calls[5]!.workflow, "greet");
    assert.equal(calls[6]!.agent, "reviewer");
    assert.equal(calls[6]!.model, undefined, "a step that names no model has none in the parse");
    assert.equal(calls[6]!.session, undefined, "a step on no session says nothing of one");
  });

  it("shows a call in a loop once, leaves out a label made at run time, and skips calls on an object", () => {
    const calls = callsOf(`export const meta = { name: "loop", description: "Loop" }
const tools = { sh: async () => 1 }
for (let round = 1; round <= 3; round++) {
  await sh("echo again", { label: \`round \${round}\` })
}
await tools.sh("not a step", { label: "nope" })
await sh("echo done", { label: "done" })
return 1`);
    assert.deepEqual(pairs(calls), [
      ["sh", undefined],
      ["sh", "done"],
    ]);
  });
});
