// The text readers learn room(). `sous check` refuses each wrong option the text shows, in the
// words room() uses when it refuses the same option before its first turn, and leaves alone the
// options and members a script builds in code, which room() checks when it starts. The graph draws
// a room as one step with its members, and the script's reader and the outline list it.

import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { WorkflowError, WorkflowErrorCode } from "../../src/errors.js";
import { SAYS } from "../../src/room/options.js";
import { createSteps } from "../../src/steps/steps.js";
import { runWorkflow } from "../../src/workflow.js";
import { checkWorkflow } from "../../src/workflows/check.js";
import { workflowFlow, type FlowNode, type FlowStep } from "../../src/workflows/flow.js";
import { workflowOutline } from "../../src/workflows/outline.js";
import { readWorkflowScript } from "../../src/workflows/script.js";
import { fakePlace, onFakes } from "../helpers/fake-steps.js";
import { write } from "../helpers/files.js";
import { setup } from "../runs/fixture.js";

for (const name of ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) delete process.env[name];

const META = "export const meta = { name: 'rooms', description: 'sessions in a room', inputs: {} }";
const NO_INPUTS = "declares no inputs, so it takes any";

/** Three handles on lines 2 to 4, so a room on the next line is on line 5. */
const HANDLES = ["const a = session({ label: 'a', model: 'claude/haiku' })", "const b = session({ label: 'b', model: 'claude/haiku' })", "const c = session({ label: 'c', model: 'claude/haiku' })"];

/** The problems and notes `sous check` gives a workflow whose body is the given lines. The meta is line 1. */
function check(...lines: string[]): { problems: string[]; notes: string[] } {
  const { paths, projectDir } = setup({ rooms: [META, ...lines].join("\n") });
  const result = checkWorkflow(paths, projectDir, "rooms");
  return { problems: result.problems, notes: result.notes.filter((note) => note !== NO_INPUTS) };
}

/** The message room() fails with when the workflow's body is the given lines. No turn runs. */
async function refused(...lines: string[]): Promise<string> {
  const place = fakePlace();
  const agent = createSteps(onFakes(place));
  try {
    await runWorkflow([META, ...lines].join("\n"), { agent, persistLogs: false, cwd: place.cwd });
  } catch (error) {
    assert.ok(error instanceof WorkflowError, String(error));
    assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, error.message);
    assert.deepEqual(place.lines(), [], "no turn ran");
    return error.message;
  } finally {
    await agent.dispose();
  }
  assert.fail(`room() ran:\n${lines.join("\n")}`);
}

/** Every step of a flow, nested ones too, in order. */
function steps(nodes: FlowNode[]): FlowStep[] {
  return nodes.flatMap((node) => {
    const inner = node.t === "step" ? [node.body ?? []] : node.t === "loop" ? [node.body] : node.t === "if" ? [node.then, node.else ?? []] : node.t === "parallel" ? node.branches : node.t === "pipeline" ? node.stages : [];
    return [...(node.t === "step" ? [node] : []), ...inner.flatMap(steps)];
  });
}

/** Each room() call with one wrong option, and what both the check and room() say of it. */
const WRONG: Array<[string, string]> = [
  ["room('talk')", SAYS.options],
  ["room({ members: [a, b] })", SAYS.goal],
  ["room({ goal: '  ', members: [a, b] })", SAYS.goal],
  ["room({ goal: 'x' })", SAYS.members],
  ["room({ goal: 'x', members: [a] })", SAYS.members],
  ["room({ goal: 'x', members: a })", SAYS.members],
  ["room({ goal: 'x', members: [a, 'b'] })", SAYS.member(1)],
  ["room({ goal: 'x', members: [a, { session: b, role: 'r', label: 'b' }] })", SAYS.memberKeys(1, ["label"])],
  ["room({ goal: 'x', members: [a, { session: 'b' }] })", SAYS.session(1)],
  ["room({ goal: 'x', members: [a, { role: 'r' }] })", SAYS.session(1)],
  ["room({ goal: 'x', members: [a, { session: b, role: '' }] })", SAYS.role(1)],
  ["room({ goal: 'x', members: [a, session({ label: 'all' })] })", SAYS.all],
  ["room({ goal: 'x', members: [a, a] })", SAYS.twice("a")],
  ["room({ goal: 'x', members: [a, b], rounds: 3 })", SAYS.key("rounds")],
  ["room({ goal: 'x', members: [a, b], name: '' })", SAYS.name],
  ["room({ goal: 'x', members: [a, b], turns: 'random' })", SAYS.turns("random")],
  ["room({ goal: 'x', members: [a, b], hears: 'none' })", SAYS.hears("none")],
  ["room({ goal: 'x', members: [a, b], turns: 'moderated' })", SAYS.moderated],
  ["room({ goal: 'x', members: [a, b], schema: { type: 'object' } })", SAYS.schemaDecider],
  ["room({ goal: 'x', members: [a, b], decider: a, schema: 'a design' })", SAYS.schema],
  ["room({ goal: 'x', members: [a, b], decider: c })", SAYS.decider],
  ["room({ goal: 'x', members: [a, b], decider: 'a' })", SAYS.decider],
  ["room({ goal: 'x', members: [a, b], maxRounds: 0 })", SAYS.maxRounds(0)],
  ["room({ goal: 'x', members: [a, b], maxRounds: 2.5 })", SAYS.maxRounds(2.5)],
  ["room({ goal: 'x', members: [a, b], opening: 'hi' })", SAYS.opening],
  ["room({ goal: 'x', members: [a, b], opening: ['hi'] })", SAYS.message(0)],
  ["room({ goal: 'x', members: [a, b], opening: [{ from: 'a', to: 'b', text: 'hi', round: 1 }] })", SAYS.messageKeys(0, ["round"])],
  ["room({ goal: 'x', members: [a, b], opening: [{ from: 'c', to: 'all', text: 'hi' }] })", SAYS.from(0, "c")],
  ["room({ goal: 'x', members: [a, b], opening: [{ from: 'a', to: 'z', text: 'hi' }] })", SAYS.to(0, "z")],
  ["room({ goal: 'x', members: [a, b], opening: [{ from: 'a', to: 'a', text: 'hi' }] })", SAYS.self(0, "a")],
  ["room({ goal: 'x', members: [a, b], opening: [{ from: 'a', to: 'b', text: 3 }] })", SAYS.text(0, 3)],
];

describe("sous check reads a room's options", () => {
  for (const [call, says] of WRONG) {
    it(`refuses ${call} as room() does`, async () => {
      assert.deepEqual(check(...HANDLES, `return await ${call}`).problems, [`room (line 5): ${says}`]);
      assert.equal(await refused(...HANDLES, `return await ${call}`), `room(): ${says}`);
    });
  }

  it("names the room by its name, and reads a room in a workflow it starts", () => {
    const { paths, projectDir } = setup({
      rooms: [META, "return await workflow('inner')"].join("\n"),
      inner: ["export const meta = { name: 'inner', description: 'd', inputs: {} }", ...HANDLES, "return await room({ name: 'pick', goal: 'x', members: [a, b], hears: 'some' })"].join("\n"),
    });
    const { problems } = checkWorkflow(paths, projectDir, "rooms");
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.match(problems[0]!, /inner/);
    assert.ok(problems[0]!.endsWith(`room "pick" (line 5): ${SAYS.hears("some")}`), problems[0]);
  });

  it("gives every problem it sees, not only the first", () => {
    assert.deepEqual(check(...HANDLES, "return await room({ goal: 'x', members: [a, b], turns: 'moderated', maxRounds: -1, size: 2 })").problems, [
      `room (line 5): ${SAYS.key("size")}`,
      `room (line 5): ${SAYS.maxRounds(-1)}`,
      `room (line 5): ${SAYS.moderated}`,
    ]);
  });

  it("finds nothing wrong in the design's example", () => {
    const result = check(
      "const claude = session({ label: 'claude', model: 'claude/haiku' })",
      "const gpt = session({ label: 'gpt', model: 'codex/gpt-fake' })",
      "const mediator = session({ label: 'mediator', model: 'claude/haiku' })",
      "const proposals = await parallel([claude, gpt].map((s) => () => s.send('Propose a design.')))",
      "return await room({",
      "  name: 'design',",
      "  goal: 'Agree on one design.',",
      "  members: [claude, { session: gpt, role: 'You argue for the queue.' }, mediator],",
      "  opening: [{ from: 'claude', to: 'all', text: proposals[0] }, { from: 'gpt', to: 'all', text: proposals[1] }],",
      "  decider: mediator,",
      "  schema: { type: 'object', properties: { design: { type: 'string' } }, required: ['design'] },",
      "  turns: 'moderated',",
      "  hears: 'addressed',",
      "  maxRounds: 6,",
      "})",
    );
    assert.deepEqual(result, { problems: [], notes: [] });
  });

  it("leaves members, labels and options built in code to room(), which refuses them before its first turn", async () => {
    const built = [
      "const panel = [{ label: 'left', model: 'claude/haiku' }, { label: 'right', model: 'claude/haiku' }]",
      "const proposers = panel.map((p) => session(p))",
      "const mediator = session({ label: args.who ?? 'mediator', model: 'claude/haiku' })",
    ];
    const fine = check(...built, "return await room({ goal: 'x', members: [...proposers, mediator], decider: mediator, opening: [{ from: 'left', to: 'mediator', text: 'hi' }], turns: 'moderated' })");
    assert.deepEqual(fine.problems, [], "a member made at run time may be the decider, and a label the text can't see may be the one an opening message names");

    const options = [...HANDLES, "const options = { goal: 'x', members: [a, b] }", "options.turns = 'random'"];
    assert.deepEqual(check(...options, "return await room(options)").problems, []);
    assert.equal(await refused(...options, "return await room(options)"), `room(): ${SAYS.turns("random")}`);

    const spread = [...HANDLES, "const more = { turns: 'moderated' }"];
    assert.deepEqual(check(...spread, "return await room({ goal: 'x', members: [a, b], ...more })").problems, [], "a spread may bring the decider");
    assert.equal(await refused(...spread, "return await room({ goal: 'x', members: [a, b], ...more })"), `room(): ${SAYS.moderated}`);

    const twins = [...HANDLES, "const twins = [1, 2].map(() => a)"];
    assert.deepEqual(check(...twins, "return await room({ goal: 'x', members: twins })").problems, []);
    assert.equal(await refused(...twins, "return await room({ goal: 'x', members: twins })"), `room(): ${SAYS.twice("a")}`);
  });

  it("checks a member's agent and model as it checks any session's", () => {
    const { paths, projectDir } = setup({
      rooms: [META, "const a = session({ label: 'a', agentType: 'fixer', model: 'claude/haiku' })", "const b = session({ label: 'b', model: 'claude/haiku' })", "return await room({ goal: 'x', members: [a, b] })"].join("\n"),
    });
    write(join(projectDir, ".codex", "agents", "fixer.toml"), 'name = "fixer"\ndescription = "fixes"\ndeveloper_instructions = "Fix it."\n');
    const { problems } = checkWorkflow(paths, projectDir, "rooms");
    assert.ok(
      problems.some((problem) => /^agent "fixer" comes from .*fixer\.toml, a Codex folder, so it runs only on Codex, and this step sends it to Claude Code/.test(problem)),
      problems.join("\n"),
    );
  });
});

describe("the graph draws a room as one step", () => {
  const DESIGN = `${META}
const claude = session({ label: 'claude', model: 'claude/haiku' })
const gpt = session({ label: 'gpt', model: 'codex/gpt-fake' })
const mediator = session({ label: 'mediator', model: 'claude/haiku' })
const proposals = await parallel([claude, gpt].map((s) => () => s.send('Propose a design.')))
const design = await room({
  name: 'design',
  goal: 'Agree on one design.',
  members: [claude, { session: gpt, role: 'You argue for the queue.' }, mediator],
  opening: [{ from: 'claude', to: 'all', text: proposals[0] }],
  decider: mediator,
  schema: { type: 'object', properties: { design: { type: 'string' } }, required: ['design'] },
  turns: 'moderated',
  hears: 'addressed',
  maxRounds: 6,
})
const written = await mediator.send('Write the design down.', { label: 'write' })
return { design, written }
`;

  it("with its name, its members, its goal as the prompt, its options and what it returns", () => {
    const flow = workflowFlow(DESIGN);
    const room = steps(flow.nodes).find((step) => step.kind === "room");
    assert.ok(room, JSON.stringify(flow.nodes));
    assert.deepEqual(
      { label: room.label, line: room.line, members: room.members, prompt: room.prompt, options: room.options, result: room.result },
      {
        label: "design",
        line: 6,
        members: ["claude", "gpt", "mediator"],
        prompt: "Agree on one design.",
        options: { turns: "moderated", hears: "addressed", decider: "mediator", maxRounds: 6, schema: room.options?.schema },
        result: "design",
      },
    );
    assert.ok(room.options?.schema, "the decision's shape shows");
    assert.deepEqual(flow.notes, ["The send() on line 5 goes to a session made at run time, so its label is not known."], "only the proposals' map, not the room");
  });

  it("goes on from the room in a member's later send", () => {
    const [write] = steps(workflowFlow(DESIGN).nodes).filter((step) => step.label === "write");
    assert.equal(write?.options?.continues, "design");
  });

  it("names a room without a name room, and notes members it can't name", () => {
    const flow = workflowFlow(`${META}
const a = session({ label: 'a' })
const panel = ['x', 'y'].map((label) => session({ label }))
await room({ goal: 'x', members: [a, ...panel] })
await room(args.options)
`);
    const rooms = steps(flow.nodes).filter((step) => step.kind === "room");
    assert.deepEqual(
      rooms.map((room) => [room.label, room.members]),
      [
        ["room", ["a", "{...panel}"]],
        ["room", undefined],
      ],
    );
    assert.deepEqual(flow.notes, [
      "The room on line 4 has members made at run time, so the graph can't name each one.",
      "The room on line 5 takes its options from args.options, so its members are not known.",
    ]);
  });
});

describe("the script's reader and the outline list a room", () => {
  const TEXT = [META, ...HANDLES, "const panel = [c]", "return await room({ name: 'pick', goal: 'x', members: [a, { session: b, role: 'r' }, ...panel] })"].join("\n");

  it("lists the room with its name and the members the text names", () => {
    const { refs } = readWorkflowScript(TEXT);
    assert.deepEqual(refs.calls.at(-1), { kind: "room", label: "pick", members: ["a", "b"] });
    assert.deepEqual(refs.rooms.map((room) => room.line), [6]);
  });

  it("shows the room in sous workflows show", () => {
    const { paths, projectDir } = setup({ rooms: TEXT });
    const outline = workflowOutline(paths, projectDir, "rooms");
    assert.deepEqual(outline.steps.at(-1), { step: "pick", kind: "room", members: ["a", "b"] });
  });
});
