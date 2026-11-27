// The text readers learn session() and <handle>.send(). A send is an agent step: the graph draws
// it with its handle's agent, the script's reader lists it with the handle's agent, model, skills
// and MCP servers, and `sous check` notes a send whose prompt starts with a value made at run time.

import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { checkWorkflow } from "../../src/workflows/check.js";
import { workflowFlow, type FlowNode, type FlowStep } from "../../src/workflows/flow.js";
import { readWorkflowScript } from "../../src/workflows/script.js";
import { write } from "../helpers/files.js";
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

describe("the graph reads a send as an agent step", () => {
  it("impl.send() is an agent node labelled with the handle's label and the agentType of its session()", () => {
    const flow = workflowFlow(
      wf(`
const impl = session({ label: "implementer", agentType: "implementer", model: "claude/haiku", effort: "high", skills: ["tdd"] })
const built = await impl.send("Implement the ticket.")
`),
    );
    const [send] = steps(flow.nodes);
    assert.deepEqual(
      { kind: send?.kind, label: send?.label, agent: send?.agent, model: send?.model, prompt: send?.prompt, result: send?.result },
      { kind: "agent", label: "implementer", agent: "implementer", model: "claude/haiku", prompt: "Implement the ticket.", result: "built" },
    );
    assert.deepEqual(send?.options, { effort: "high", skills: ["tdd"], session: "implementer" });
    assert.deepEqual(flow.notes, []);
  });

  it("a send with its own label gets that label, and the handle's agent", () => {
    const flow = workflowFlow(
      wf(`
const impl = session({ label: "implementer", agentType: "implementer" })
await impl.send("Fix the review's points.", { label: "fix", timeout: "10m", until: "turn" })
`),
    );
    const [send] = steps(flow.nodes);
    assert.deepEqual([send?.kind, send?.label, send?.agent], ["agent", "fix", "implementer"]);
    assert.deepEqual(send?.options, { timeout: "10m", until: "turn", session: "implementer" });
  });

  it("a send's model wins over its handle's", () => {
    const flow = workflowFlow(
      wf(`
const impl = session({ label: "implementer", agentType: "implementer", model: "claude/haiku" })
await impl.send("Go.", { model: "claude/opus" })
`),
    );
    assert.equal(steps(flow.nodes)[0]?.model, "claude/opus");
  });

  it("the second send on a handle continues the first, and a send on another handle does not", () => {
    const flow = workflowFlow(
      wf(`
const impl = session({ label: "implementer", agentType: "implementer" })
const other = session({ label: "other", agentType: "reviewer" })
await impl.send("Implement the ticket.")
await other.send("Look.")
await impl.send("Fix the review's points.", { label: "fix" })
await impl.send("Once more.", { label: "again" })
`),
    );
    assert.deepEqual(
      steps(flow.nodes).map((step) => [step.label, step.agent, step.options?.continues]),
      [
        ["implementer", "implementer", undefined],
        ["other", "reviewer", undefined],
        ["fix", "implementer", "implementer"],
        ["again", "implementer", "fix"],
      ],
    );
  });

  it("a send on session({...}) written in place, and on a const that holds the options, reads the same", () => {
    const flow = workflowFlow(
      wf(`
const opts = { label: "kept", agentType: "planner" }
await session({ label: "inline", agentType: "writer" }).send("Write.")
const kept = session(opts)
await kept.send("Plan.")
`),
    );
    assert.deepEqual(
      steps(flow.nodes).map((step) => [step.label, step.agent]),
      [
        ["inline", "writer"],
        ["kept", "planner"],
      ],
    );
    assert.deepEqual(flow.notes, []);
  });

  it("a handle made at run time gives a note, and its sends are still agent steps", () => {
    const flow = workflowFlow(
      wf(`
const panel = await agent("Pick reviewers.", { label: "pick" })
const handles = panel.map((p) => session(p))
await parallel(handles.map((h) => () => h.send("Review it.")))
const made = session(args.options)
await made.send("Go.")
`),
    );
    const sends = steps(flow.nodes).filter((step) => step.label !== "pick");
    assert.deepEqual(
      sends.map((step) => [step.kind, step.label, step.dynamic]),
      [
        ["agent", "{h}", true],
        ["agent", "{made}", true],
      ],
    );
    assert.deepEqual(flow.notes, [
      "The session on line 3 takes its options from p, so its label is not known.",
      "The send() on line 4 goes to a session made at run time, so its label is not known.",
      "The session on line 5 takes its options from args.options, so its label is not known.",
      "The send() on line 6 goes to a session made at run time, so its label is not known.",
    ]);
  });

  it("a fork's send has the parent's agent and options, and goes on from the parent's last send", () => {
    const flow = workflowFlow(
      wf(`
const mediator = session({ label: "mediator", agentType: "mediator", model: "claude/opus", mode: "plan" })
await mediator.send("Decide.")
const critic = mediator.fork({ label: "critic" })
const risks = await critic.send("Name the weakest point.")
await critic.send("And the next one.", { label: "more" })
`),
    );
    assert.deepEqual(
      steps(flow.nodes).map((step) => [step.label, step.agent, step.model, step.options]),
      [
        ["mediator", "mediator", "claude/opus", { mode: "plan", session: "mediator" }],
        ["critic", "mediator", "claude/opus", { mode: "plan", session: "critic", continues: "mediator" }],
        ["more", "mediator", "claude/opus", { mode: "plan", session: "critic", continues: "critic" }],
      ],
    );
  });

  it("gate() and retry() are no loops now: the steps of their functions are left out with a note", () => {
    const flow = workflowFlow(
      wf(`
await gate(() => agent("w", { label: "work" }), (r) => r.ok, { attempts: 2 })
await retry(() => sh("flaky", { label: "flaky" }), { attempts: 3 })
`),
    );
    assert.deepEqual(flow.nodes, []);
    assert.deepEqual(flow.notes, [
      "The step on line 2 is inside a function sous can't follow, so the graph leaves it out.",
      "The step on line 3 is inside a function sous can't follow, so the graph leaves it out.",
    ]);
  });

  it("an agent step's options leave keepSession, continue, isolation and answeredBy out, and read place and until", () => {
    const flow = workflowFlow(
      wf(`
await agent("a", { label: "old", keepSession: true, isolation: "worktree", answeredBy: "anyone", ask: true })
await agent("b", { label: "older", continue: "old" })
await agent("c", { label: "new", place: "worktree", until: "turn" })
`),
    );
    assert.deepEqual(
      steps(flow.nodes).map((step) => [step.label, step.agent, step.options]),
      [
        ["old", undefined, { asks: true }],
        ["older", undefined, undefined],
        ["new", undefined, { place: "worktree", until: "turn" }],
      ],
    );
  });

  it("an agent step's options read check, maxTurns and maxRepairs, a check function as function", () => {
    const flow = workflowFlow(
      wf(`
const review = async (result) => true
const impl = session({ label: "impl" })
await impl.send("a", { check: "npm test", maxTurns: 12 })
await agent("b", { label: "listed", check: ["npm test", review, (result) => true], maxRepairs: 2 })
`),
    );
    assert.deepEqual(
      steps(flow.nodes).map((step) => [step.label, step.options]),
      [
        ["impl", { session: "impl", check: ["npm test"], maxTurns: 12 }],
        ["listed", { check: ["npm test", "function", "function"], maxRepairs: 2 }],
      ],
    );
  });
});

describe("the script's reader reads a send as an agent call", () => {
  it("lists a send with its handle's agent, model, skills and MCP servers, and the handle's label", () => {
    const { refs } = readWorkflowScript(
      wf(`
const impl = session({ label: "implementer", agentType: "implementer", model: "claude/haiku", skills: ["tdd"], mcp: ["github"] })
await impl.send("Implement the ticket.")
await impl.send("Fix it.", { label: "fix", model: "claude/opus" })
const critic = impl.fork({ label: "critic" })
await critic.send("Find the weak point.")
`),
    );
    assert.deepEqual(refs.calls, [
      { kind: "agent", label: "implementer", agent: "implementer", model: "claude/haiku", skills: ["tdd"], mcp: ["github"], session: "implementer" },
      { kind: "agent", label: "fix", agent: "implementer", model: "claude/opus", skills: ["tdd"], mcp: ["github"], session: "implementer" },
      { kind: "agent", label: "critic", agent: "implementer", model: "claude/haiku", skills: ["tdd"], mcp: ["github"], session: "critic" },
    ]);
  });

  it("gives check the handle's agent with the send's model", () => {
    const { refs } = readWorkflowScript(
      wf(`
const impl = session({ label: "implementer", agentType: "implementer", mcp: ["github"] })
await impl.send("Fix it.", { model: "codex/gpt-5" })
`),
    );
    assert.ok(
      refs.steps.some((step) => step.agentType === "implementer" && step.model === "codex/gpt-5" && step.setsModel && step.mcp.join() === "github"),
      JSON.stringify(refs.steps),
    );
  });

  it("reads no checkpoint() call, and counts no checkpoint among the asks", () => {
    const { refs } = readWorkflowScript(
      wf(`
await checkpoint("Go on?", { kind: "confirm" })
await ask("Which?")
`),
    );
    assert.deepEqual(
      refs.calls.map((call) => call.kind),
      ["ask"],
    );
    assert.equal(refs.asks, 1);
  });

  it("no call carries keepsSession, even when the text sets keepSession", () => {
    const { refs } = readWorkflowScript(wf(`await agent("a", { label: "a", keepSession: true })`));
    assert.deepEqual(refs.calls, [{ kind: "agent", label: "a" }]);
  });
});

describe("sous check reads a send", () => {
  const NOTE_END = 'starts its prompt with a value made at run time. A value that starts with "/" would run a command. Start the prompt with fixed words.';
  const NO_INPUTS = "declares no inputs, so it takes any";

  /** The problems and the notes of a workflow whose body is the given lines. The meta is line 1. */
  function check(...lines: string[]): { problems: string[]; notes: string[]; projectDir: string } {
    const { paths, projectDir } = setup({ sends: [`export const meta = { name: 'sends', description: 'd' }`, ...lines].join("\n") });
    const result = checkWorkflow(paths, projectDir, "sends");
    return { problems: result.problems, notes: result.notes.filter((note) => note !== NO_INPUTS), projectDir };
  }

  it("gives the run-time prompt note for impl.send(args.task)", () => {
    const result = check("const impl = session({ label: 'implementer' })", "await impl.send(args.task)");
    assert.deepEqual(result.notes, [`agent "implementer" (line 3) ${NOTE_END}`]);
  });

  it("names a send by its own label when it has one", () => {
    const result = check("const impl = session({ label: 'implementer' })", "await impl.send(args.task, { label: 'fix' })");
    assert.deepEqual(result.notes, [`agent "fix" (line 3) ${NOTE_END}`]);
  });

  it('gives no note for impl.send("Fix it")', () => {
    const result = check("const impl = session({ label: 'implementer' })", 'await impl.send("Fix it")');
    assert.deepEqual(result, { ...result, problems: [], notes: [] });
  });

  it("checks the handle's agent on the model a send asks for", () => {
    const { paths, projectDir } = setup({
      sends: [`export const meta = { name: 'sends', description: 'd' }`, "const fix = session({ label: 'fix', agentType: 'fixer' })", "await fix.send('Fix it', { model: 'claude/haiku' })"].join("\n"),
    });
    write(join(projectDir, ".codex", "agents", "fixer.toml"), 'name = "fixer"\ndescription = "fixes"\ndeveloper_instructions = "Fix it."\n');
    const result = checkWorkflow(paths, projectDir, "sends");
    assert.ok(
      result.problems.some((problem) => /^agent "fixer" comes from .*fixer\.toml, a Codex folder, so it runs only on Codex, and this step sends it to Claude Code/.test(problem)),
      result.problems.join("\n"),
    );
  });
});
