import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { workflowFlow, type FlowNode, type FlowStep } from "../src/workflows/flow.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** A workflow text whose body starts on line 2. */
const wf = (body: string) => `export const meta = { name: "demo", description: "A demo" }\n${body.trim()}\n`;

/** The flow as indented lines, so a test reads like the graph. */
function outline(nodes: FlowNode[], depth = 0): string[] {
  const pad = "  ".repeat(depth);
  return nodes.flatMap((node): string[] => {
    switch (node.t) {
      case "step": {
        const extras = [
          node.agent && `@${node.agent}`,
          node.model && `model ${node.model}`,
          node.retries !== undefined && `retries ${node.retries}`,
          node.workflow && `runs ${node.workflow}`,
          node.dynamic && "dynamic",
        ].filter(Boolean);
        return [`${pad}${node.kind} ${node.label}${extras.length ? ` (${extras.join(", ")})` : ""}`, ...outline(node.body ?? [], depth + 1)];
      }
      case "loop":
        return [`${pad}${node.loop}${node.label ? ` ${node.label}` : ""}${node.limit ? ` limit ${node.limit}` : ""}`, ...outline(node.body, depth + 1)];
      case "if":
        return [`${pad}if ${node.cond}`, ...outline(node.then, depth + 1), ...(node.else ? [`${pad}else`, ...outline(node.else, depth + 1)] : [])];
      case "end":
        return [`${pad}end`];
      case "parallel":
        return [`${pad}parallel`, ...node.branches.flatMap((branch) => [`${pad}  branch`, ...outline(branch, depth + 2)])];
      case "pipeline":
        return [`${pad}pipeline over ${node.over}`, ...node.stages.flatMap((stage) => [`${pad}  stage`, ...outline(stage, depth + 2)])];
    }
  });
}

/** Every node of a flow, nested ones too, in order. */
function allNodes(nodes: FlowNode[]): FlowNode[] {
  return nodes.flatMap((node) => {
    const inner =
      node.t === "step" ? [node.body ?? []] : node.t === "loop" ? [node.body] : node.t === "if" ? [node.then, node.else ?? []] : node.t === "parallel" ? node.branches : node.t === "pipeline" ? node.stages : [];
    return [node, ...inner.flatMap(allNodes)];
  });
}

const steps = (nodes: FlowNode[]) => allNodes(nodes).filter((node): node is FlowStep => node.t === "step");

/** One field of each step, next to its label. */
const each = <K extends keyof FlowStep>(nodes: FlowNode[], field: K) => steps(nodes).map((step) => [step.label, step[field]]);

test("reads each kind of step, in the order they run", () => {
  const flow = workflowFlow(
    wf(`
const planner = session({ label: "plan", agentType: "planner", model: "claude/opus" })
const plan = await planner.send("plan", { retries: 2 })
await planner.send("more", { label: "plan again" })
await sh("pnpm test", { label: "tests", retries: 1 })
await js("return 1", null, { label: "count" })
await py("print(1)", null, { label: "python" })
await run("scripts/x.sh", { label: "script" })
await waitUntil("curl -f localhost", { label: "server up", every: "5s" })
const color = await ask("Pick a color", { choices: ["red"] })
const ok = await checkpoint("Go on?", { kind: "confirm" })
await breakpoint("Look at it")
await workflow("ticket", { ticket: "x" }, { label: "child" })
await choose("Pick one", { workflows: ["ticket"], label: "pick", agentType: "triager" })
return plan
`),
  );
  assert.deepEqual(outline(flow.nodes), [
    "agent plan (@planner, model claude/opus, retries 2)",
    "agent plan again (@planner, model claude/opus)",
    "sh tests (retries 1)",
    "js count",
    "py python",
    "run script",
    "wait server up",
    "ask Pick a color",
    "breakpoint Look at it",
    "workflow child (runs ticket)",
    "choose pick (@triager)",
  ]);
  assert.deepEqual(flow.notes, ["The checkpoint() on line 11 is gone. Use ask() to ask the person."]);
});

test("reads a step anywhere in an expression, after the steps of its arguments", () => {
  const flow = workflowFlow(
    wf(`
const r = (await agent("a", { label: "first" })).trim()
const s = \`x \${(await sh("ls", { label: "inside a template" })).stdout}\`
await agent(\`use \${await js("return 1", null, { label: "argument" })}\`, { label: "after its argument" })
log(JSON.stringify(await py("1", null, { label: "deep" })))
`),
  );
  assert.deepEqual(outline(flow.nodes), ["agent first", "sh inside a template", "js argument", "agent after its argument", "py deep"]);
});

test("a label falls back to the title of an ask or a breakpoint, then to the kind", () => {
  const flow = workflowFlow(
    wf(`
await agent("a")
await sh("ls")
await ask("Which one?")
await ask(\`Ready?\`)
await breakpoint("Check", () => agent("b"))
await workflow("ticket")
`),
  );
  assert.deepEqual(outline(flow.nodes), ["agent agent", "sh sh", "ask Which one?", "ask Ready?", "breakpoint Check", "  agent agent", "workflow workflow (runs ticket)"]);
});

test("a label made at run time is dynamic, with each expression as its source", () => {
  const flow = workflowFlow(
    wf(`
await agent("x", { label: \`ticket \${t.id}\` })
await sh("ls", { label: name })
await ask(\`Build \${list.length} tickets?\`)
`),
  );
  assert.deepEqual(outline(flow.nodes), ["agent ticket {t.id} (dynamic)", "sh {name} (dynamic)", "ask Build {list.length} tickets? (dynamic)"]);
  assert.deepEqual(flow.notes, ["The label of the sh step on line 3 is made at run time."]);
});

test("a label joined with + reads like a template", () => {
  const flow = workflowFlow(wf(`await sh("ls", { label: "check " + part + " now" })\nawait sh("ls", { label: a + b })\n`));
  assert.deepEqual(outline(flow.nodes), ["sh check {part} now (dynamic)", "sh {a + b} (dynamic)"]);
  assert.deepEqual(flow.notes, ["The label of the sh step on line 3 is made at run time."]);
});

test("options the text does not write in place leave the label unknown, with a note", () => {
  const flow = workflowFlow(
    wf(`
await agent("x", opts)
await sh("ls", { ...common, allowFail: true })
await sh("ls", { ...common, label: "own" })
`),
  );
  assert.deepEqual(outline(flow.nodes), ["agent agent", "sh sh", "sh own"]);
  assert.deepEqual(flow.notes, [
    "The agent step on line 2 takes options from opts, so its label is not known.",
    "The sh step on line 3 takes options from common, so its label is not known.",
  ]);
});

test("workflow() names the saved workflow it starts, and only a literal name", () => {
  const flow = workflowFlow(
    wf(`
await workflow("docs-sync", { ref: "HEAD" }, { label: "docs" })
await workflow(\`export const meta = { name: "inline", description: "x" }\nreturn 1\`)
await workflow(args.next)
`),
  );
  assert.deepEqual(outline(flow.nodes), ["workflow docs (runs docs-sync)", "workflow workflow", "workflow workflow"]);
  assert.deepEqual(flow.notes, ["The workflow step on line 5 starts a workflow named at run time."]);
});

test("a breakpoint's step is its body", () => {
  const flow = workflowFlow(
    wf(`
const notes = await breakpoint("Notes look right?", (note) => agent(\`write \${note}\`, { label: "draft", agentType: "writer" }), { show: (x) => x })
const draft = () => sh("make docs", { label: "docs" })
await breakpoint("Docs look right?", draft)
await breakpoint("Just stop", { show: notes })
`),
  );
  assert.deepEqual(outline(flow.nodes), ["breakpoint Notes look right?", "  agent draft (@writer)", "breakpoint Docs look right?", "  sh docs", "breakpoint Just stop"]);
  assert.equal((flow.nodes[2] as FlowStep).body, undefined);
});

test("parallel() and Promise.all() give one branch per element", () => {
  const flow = workflowFlow(
    wf(`
const [a, b] = await parallel([
  () => agent("a", { label: "left" }),
  async () => {
    await sh("ls", { label: "right 1" })
    await sh("ls", { label: "right 2" })
  },
  () => "no step",
])
const [c, d] = await Promise.all([agent("c", { label: "one" }), sh("ls", { label: "two" })])
`),
  );
  assert.deepEqual(outline(flow.nodes), [
    "parallel",
    "  branch",
    "    agent left",
    "  branch",
    "    sh right 1",
    "    sh right 2",
    "parallel",
    "  branch",
    "    agent one",
    "  branch",
    "    sh two",
  ]);
});

test("a .map() over items inside parallel() or Promise.all() is a pipeline of one stage", () => {
  const flow = workflowFlow(
    wf(`
await parallel(files.map((f) => () => agent(f, { label: "read" })))
await Promise.all(tickets.map(async (t) => {
  await workflow("ticket", { t }, { label: \`ticket \${t.id}\` })
}))
await parallel([() => sh("ls", { label: "list" }), ...docs.map((d) => () => agent(d, { label: "doc" }))])
`),
  );
  assert.deepEqual(outline(flow.nodes), [
    "pipeline over files",
    "  stage",
    "    agent read",
    "pipeline over tickets",
    "  stage",
    "    workflow ticket {t.id} (runs ticket, dynamic)",
    "parallel",
    "  branch",
    "    sh list",
    "  branch",
    "    pipeline over docs",
    "      stage",
    "        agent doc",
  ]);
  assert.deepEqual(flow.notes, []);
});

test("pipeline() gives one stage per function, over the source of its items", () => {
  const flow = workflowFlow(
    wf(`
const check = (built, item) => sh(\`test \${item}\`, { label: "test" })
await pipeline(args.items, (item) => agent(item, { label: "build" }), check, () => "no step")
`),
  );
  assert.deepEqual(outline(flow.nodes), ["pipeline over args.items", "  stage", "    agent build", "  stage", "    sh test"]);
});

test("a counted for loop has its rounds as the limit, as the text writes them", () => {
  const flow = workflowFlow(
    wf(`
let feedback
for (let round = 0; round < args.rounds; round++) {
  if (feedback) await agent(feedback, { label: "fix" })
  feedback = (await agent("review", { label: "review" })).review
}
for (let i = 1; i <= 2; i++) {
  await agent("w", { label: "work" })
  await agent("good?", { label: "check" })
}
for (let i = 0; i <= 2; i++) await sh("flaky", { label: "flaky" })
for (let i = 1; i < 3; i++) await sh("from one", { label: "from one" })
for (let i = 1; i < args.n; i++) await sh("shifted", { label: "shifted input" })
for (let i = 0; i < 6; i += 2) await sh("by two", { label: "by two" })
while (true) await sh("again", { label: "no limit" })
for (let i = 0; i < 3; i++) log(i)
`),
  );
  assert.deepEqual(outline(flow.nodes), [
    "for round < args.rounds limit args.rounds",
    "  if feedback",
    "    agent fix",
    "  agent review",
    "for i <= 2 limit 2",
    "  agent work",
    "  agent check",
    "for i <= 2 limit 3",
    "  sh flaky",
    "for i < 3 limit 2",
    "  sh from one",
    "for i < args.n",
    "  sh shifted input",
    "for i < 6",
    "  sh by two",
    "while true",
    "  sh no limit",
  ]);
});

test("a counted for loop's limit is a whole number of rounds, at least one, or the name the text bounds it by", () => {
  const flow = workflowFlow(
    wf(`
for (let i = 0; i < 4; i++) await sh("a", { label: "four" })
for (let i = 1; i <= 4; i++) await sh("a", { label: "four from one" })
for (let i = 0; i < 2.5; i++) await sh("a", { label: "a fraction" })
for (let i = 0; i < 0; i++) await sh("a", { label: "none" })
for (let i = 1; i < 1; i++) await sh("a", { label: "none from one" })
for (let i = 0; i < -1; i++) await sh("a", { label: "below none" })
for (let i = 0; i < "3"; i++) await sh("a", { label: "a string" })
for (let i = 0; i < args.n; i++) await sh("a", { label: "an input" })
`),
  );
  assert.deepEqual(
    flow.nodes.map((node) => (node.t === "loop" ? [node.label, node.limit] : [])),
    [
      ["i < 4", "4"],
      ["i <= 4", "4"],
      ["i < 2.5", undefined],
      ["i < 0", undefined],
      ["i < 1", undefined],
      ["i < -1", undefined],
      ['i < "3"', undefined],
      ["i < args.n", "args.n"],
    ],
  );
});

test("checkpoint() is no step: it gives a note that ask() takes its place", () => {
  const flow = workflowFlow(
    wf(`
const ok = await checkpoint("Go on?", { kind: "confirm" })
if (ok) await checkpoint("Pick", { kind: "select", choices: ["x", (await agent("c", { label: "choice" }))] })
`),
  );
  assert.deepEqual(outline(flow.nodes), ["if ok", "  agent choice"]);
  assert.deepEqual(flow.notes, ["The checkpoint() on line 2 is gone. Use ask() to ask the person.", "The checkpoint() on line 3 is gone. Use ask() to ask the person."]);
});

test("gate() and retry() are no loops: the steps of their functions are left out with a note", () => {
  const flow = workflowFlow(
    wf(`
await gate(() => agent("w", { label: "work" }), (v) => agent("good?", { label: "check" }), { attempts: 2 })
await retry(() => sh("flaky", { label: "flaky" }), { attempts: 3, until: (r) => r.code === 0 })
`),
  );
  assert.deepEqual(outline(flow.nodes), []);
  assert.deepEqual(flow.notes, [
    "The step on line 2 is inside a function sous can't follow, so the graph leaves it out.",
    "The step on line 3 is inside a function sous can't follow, so the graph leaves it out.",
  ]);
});

test("for and while loops are labeled with what they go over or their condition", () => {
  const flow = workflowFlow(
    wf(`
for (const t of tickets) await agent(t, { label: "each" })
for (const k in groups) await sh(k, { label: "group" })
for (let i = 0; i < args.n; i++) await sh("x", { label: "count" })
while (!done) {
  done = (await agent("again?", { label: "again" })).done
}
do {
  await sh("poll", { label: "poll" })
} while (busy)
for (const x of xs) log(x)
`),
  );
  assert.deepEqual(outline(flow.nodes), [
    "for tickets",
    "  agent each",
    "for groups",
    "  sh group",
    "for i < args.n limit args.n",
    "  sh count",
    "while !done",
    "  agent again",
    "while busy",
    "  sh poll",
  ]);
});

test("if, else and a conditional expression branch, and a return before the end is an end", () => {
  const flow = workflowFlow(
    wf(`
const plan = await agent("plan", { label: "plan" })
if (!plan.ok) return { failed: true }
if (plan.big) {
  await agent("split", { label: "split" })
} else if (plan.small) {
  await sh("quick", { label: "quick" })
} else {
  log("medium")
}
const out = plan.fast ? await sh("fast", { label: "fast" }) : await agent("slow", { label: "slow" })
if (plan.debug) log("debug")
plan.ship && (await sh("ship", { label: "ship" }))
return out
`),
  );
  assert.deepEqual(outline(flow.nodes), [
    "agent plan",
    "if !plan.ok",
    "  end",
    "if plan.big",
    "  agent split",
    "else",
    "  if plan.small",
    "    sh quick",
    "if plan.fast",
    "  sh fast",
    "else",
    "  agent slow",
    "if plan.ship",
    "  sh ship",
  ]);
});

test("the last top-level return is no end, even with functions after it", () => {
  const flow = workflowFlow(
    wf(`
const done = await helper()
return done
async function helper() {
  return agent("go", { label: "go" })
}
`),
  );
  assert.deepEqual(outline(flow.nodes), ["agent go"]);
});

test("try and catch: the try block's steps, then the catch block's as an if on error", () => {
  const flow = workflowFlow(
    wf(`
try {
  await sh("build", { label: "build" })
} catch (error) {
  await agent(\`fix \${error}\`, { label: "fix build" })
} finally {
  await sh("clean", { label: "clean" })
}
await sh("deploy", { label: "deploy" }).catch(() => agent("roll back", { label: "roll back" }))
`),
  );
  assert.deepEqual(outline(flow.nodes), ["sh build", "if error", "  agent fix build", "sh clean", "sh deploy", "if error", "  agent roll back"]);
});

test("a function the text declares is inlined where it is called", () => {
  const flow = workflowFlow(
    wf(`
async function review(topic) {
  return agent(topic, { label: "review" })
}
const build = async (what) => {
  await sh(what, { label: "build" })
  await review(what)
}
await build("a")
await review("b")
`),
  );
  assert.deepEqual(outline(flow.nodes), ["sh build", "agent review", "agent review"]);
  const ids = steps(flow.nodes).map((step) => step.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(
    steps(flow.nodes).map((step) => step.line),
    [6, 3, 3],
  );
});

test("inlining stops at recursion and three functions deep, with a note", () => {
  const flow = workflowFlow(
    wf(`
async function again(n) {
  await agent("try", { label: "try" })
  if (n > 0) await again(n - 1)
}
await again(3)
const one = () => agent("deep", { label: "deep" })
const two = () => one()
const three = () => two()
const four = () => three()
await four()
await three()
`),
  );
  assert.deepEqual(outline(flow.nodes), ["agent try", "agent deep"]);
  assert.deepEqual(flow.notes, [
    "again() calls itself on line 4, so the graph stops there.",
    "The call to one() on line 8 is more than 3 functions deep, so the graph leaves it out.",
  ]);
});

test("a step in a function sous can't follow is a note", () => {
  const flow = workflowFlow(
    wf(`
const judged = items.filter(async (x) => (await agent(x, { label: "judge" })).ok)
onDone(() => sh("late", { label: "late" }))
await choose("pick", { steps: { build: { description: "b", run: () => workflow("ticket") } } })
const tasks = items.map((x) => () => agent(x))
`),
  );
  assert.deepEqual(outline(flow.nodes), ["choose choose"]);
  assert.deepEqual(flow.notes, [
    "The step on line 2 is inside a function sous can't follow, so the graph leaves it out.",
    "The step on line 3 is inside a function sous can't follow, so the graph leaves it out.",
    "The step on line 4 runs only when choose() picks it, so the graph leaves it out.",
    "The step on line 5 is inside a function sous can't follow, so the graph leaves it out.",
  ]);
});

test("each node has the 1-based line it starts on and an id unique in the flow", () => {
  const text = wf(`
await sh("a", { label: "a" })
if (x) {
  await parallel([() => sh("b", { label: "b" })])
}
`);
  const flow = workflowFlow(text);
  assert.deepEqual(
    allNodes(flow.nodes).map((node) => [node.t, node.line]),
    [
      ["step", 2],
      ["if", 3],
      ["parallel", 4],
      ["step", 4],
    ],
  );
  const ids = allNodes(flow.nodes).map((node) => node.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(workflowFlow(text), flow);
});

test("ids stay the same when a line is added after the node", () => {
  const before = `await sh("a", { label: "a" })\nlet r\nfor (let i = 0; i < 2; i++) r = await agent("w", { label: "w" })\nif (!r.ok) return\n`;
  const after = "await sh(\"z\", { label: \"added\" })\n";
  const one = workflowFlow(wf(before + `await sh("c", { label: "c" })`));
  const two = workflowFlow(wf(before + after + `await sh("c", { label: "c" })`));
  const ids = (nodes: FlowNode[]) => allNodes(nodes).map((node) => node.id);
  assert.deepEqual(ids(two.nodes).slice(0, 5), ids(one.nodes).slice(0, 5));
  assert.equal(outline(two.nodes).length, outline(one.nodes).length + 1);
});

test("a step's phase is its own phase option, else the last phase() call before it", () => {
  const flow = workflowFlow(
    wf(`
await agent("a", { label: "before" })
phase("plan")
await agent("b", { label: "planner" })
if (big) {
  phase("build")
  await sh("make", { label: "make" })
}
await sh("test", { label: "after the branch" })
await agent("c", { label: "own", phase: "review" })
const ship = async () => {
  phase("ship")
  await sh("deploy", { label: "deploy" })
}
await sh("x", { label: "before the call" })
await ship()
await sh("y", { label: "after the call" })
phase(\`round \${n}\`)
await sh("z", { label: "made" })
`),
  );
  assert.deepEqual(each(flow.nodes, "phase"), [
    ["before", undefined],
    ["planner", "plan"],
    ["make", "build"],
    ["after the branch", "build"],
    ["own", "review"],
    ["before the call", "build"],
    ["deploy", "ship"],
    ["after the call", "ship"],
    ["made", "round {n}"],
  ]);
});

test("an agent's prompt and a code step's code read as the text writes them, with each expression as {source}", () => {
  const flow = workflowFlow(
    wf(`
await agent(\`Review \${args.ticket} now\`, { label: "template" })
await agent("Check " + part + \` with \${tool}\`, { label: "joined" })
await agent(feedback, { label: "variable" })
await choose("Pick one", { workflows: ["ticket"], label: "pick" })
await sh(\`pnpm test \${filter}\`, { label: "sh" })
await js("return input + 1", 2, { label: "js" })
await py(\`print(\${n})\`, null, { label: "py" })
await run("scripts/x.sh", { label: "run" })
await waitUntil("curl -f localhost", { label: "wait" })
await ask("Which one?")
`),
  );
  assert.deepEqual(each(flow.nodes, "prompt"), [
    ["template", "Review {args.ticket} now"],
    ["joined", "Check {part} with {tool}"],
    ["variable", "{feedback}"],
    ["pick", "Pick one"],
    ["sh", undefined],
    ["js", undefined],
    ["py", undefined],
    ["run", undefined],
    ["wait", undefined],
    ["Which one?", undefined],
  ]);
  assert.deepEqual(each(flow.nodes, "code"), [
    ["template", undefined],
    ["joined", undefined],
    ["variable", undefined],
    ["pick", undefined],
    ["sh", "pnpm test {filter}"],
    ["js", "return input + 1"],
    ["py", "print({n})"],
    ["run", "scripts/x.sh"],
    ["wait", "curl -f localhost"],
    ["Which one?", undefined],
  ]);
});

test("a step's result is the name the text keeps it under, and each name of a destructured parallel", () => {
  const flow = workflowFlow(
    wf(`
const review = await agent("r", { label: "review" })
let out = await sh("ls", { label: "let" })
out = await sh("ls", { label: "assigned" })
const [left, right] = await parallel([
  () => agent("a", { label: "left" }),
  async () => {
    await sh("x", { label: "unnamed" })
    return sh("y", { label: "right" })
  },
])
const [one, two] = await Promise.all([agent("c", { label: "one" }), sh("d", { label: "two" })])
const text = (await agent("t", { label: "derived" })).trim()
const { stdout } = await sh("ls", { label: "destructured" })
await agent("z", { label: "not kept" })
`),
  );
  assert.deepEqual(each(flow.nodes, "result"), [
    ["review", "review"],
    ["let", "out"],
    ["assigned", "out"],
    ["left", "left"],
    ["unnamed", undefined],
    ["right", "right"],
    ["one", "one"],
    ["two", "two"],
    ["derived", undefined],
    ["destructured", undefined],
    ["not kept", undefined],
  ]);
});

test("a step reads earlier results, inputs as args.<name> and the names of its callbacks, in order and once", () => {
  const flow = workflowFlow(
    wf(`
const plan = await agent("plan", { label: "plan" })
await agent(\`Build \${plan.summary} for \${args.ticket}, see \${plan.notes} and \${args["ticket"]}\`, { label: "build", agentType: args.agent })
await parallel(reviews.map((feedback, attempt) => () => agent(\`fix \${feedback}\`, { label: "fix" })))
await pipeline(args.items, (item) => sh(\`test \${item}\`, { label: "test" }))
await pipeline(items, async (item) => {
  const inner = () => agent(\`build \${item}\`, { label: "inner" })
  await inner()
})
for (const { id } of tickets) await workflow("ticket", { id, plan }, { label: "ticket" })
try {
  await sh("build", { label: "try" })
} catch (error) {
  await agent(\`fix \${error}\`, { label: "catch" })
}
await agent(\`\${cwd} \${other} \${later} \${args}\`, { label: "globals", show: (plan) => plan })
const later = await sh("x", { label: "later" })
`),
  );
  assert.deepEqual(each(flow.nodes, "reads"), [
    ["plan", undefined],
    ["build", ["plan", "args.ticket", "args.agent"]],
    ["fix", ["feedback"]],
    ["test", ["item"]],
    ["inner", ["item"]],
    ["ticket", ["id", "plan"]],
    ["try", undefined],
    ["catch", ["error"]],
    ["globals", undefined],
    ["later", undefined],
  ]);
});

test("an agent's options as the text writes them", () => {
  const flow = workflowFlow(
    wf(`
await agent("a", { label: "full", timeout: "10m", effort: "high", mode: "plan", place: "worktree", skills: ["tdd", "review"], mcp: ["github"], until: "turn" })
const impl = session({ label: "impl", effort: "low", mode: "plan", skills: ["tdd"], mcp: ["github"] })
await impl.send("b", { label: "first", until: "done" })
await impl.send("c", { label: "asks", ask: true, timeout: 600, effort: "high" })
await agent("d", { label: "odd", place: "home", until: "never", ask: false })
await sh("make", { label: "code", timeout: "5m", allowFail: true, effort: "high", place: "worktree", until: "turn" })
await agent("e", { label: "none", model: "x", retries: 2 })
`),
  );
  assert.deepEqual(each(flow.nodes, "options"), [
    ["full", { timeout: "10m", effort: "high", mode: "plan", place: "worktree", skills: ["tdd", "review"], mcp: ["github"], until: "turn" }],
    ["first", { effort: "low", mode: "plan", skills: ["tdd"], mcp: ["github"], until: "done", session: "impl" }],
    ["asks", { timeout: "600", effort: "high", mode: "plan", skills: ["tdd"], mcp: ["github"], asks: true, session: "impl", continues: "first" }],
    ["odd", undefined],
    ["code", { timeout: "5m", allowFail: true }],
    ["none", undefined],
  ]);
});

test("the options of ask and breakpoint", () => {
  const flow = workflowFlow(
    wf(`
await ask("Which?", { choices: ["a", "b"], answeredBy: "people" })
await ask("Pick", { choices: ["x", "y"], answeredBy: "anyone" })
await ask("Go on?")
await breakpoint("Check", () => agent("b", { label: "draft" }), { max: 3 })
await breakpoint("Stop here", { max: 2 })
`),
  );
  assert.deepEqual(each(flow.nodes, "options"), [
    ["Which?", { choices: ["a", "b"], answeredBy: "people" }],
    ["Pick", { choices: ["x", "y"], answeredBy: "anyone" }],
    ["Go on?", undefined],
    ["Check", { max: 3 }],
    ["draft", undefined],
    ["Stop here", { max: 2 }],
  ]);
});

test("workflow() gives its inputs and place, choose what it may pick, waitUntil how often it checks", () => {
  const flow = workflowFlow(
    wf(`
await workflow("ticket", { ticket: args.ticket, rounds: 2, "dry-run": true, plan }, { label: "child", place: "worktree" })
await workflow("ticket", { ...args, x: 1 }, { label: "spread" })
await choose("Pick", { steps: { build: () => 1, "skip it": { description: "s", run: () => 1 } }, workflows: ["ticket", { name: "docs", description: "d" }], any: true, label: "pick" })
await waitUntil("curl -f localhost", { label: "server", every: "5s", timeout: "2m" })
await waitUntil("curl -f localhost", { label: "seconds", every: 10 })
`),
  );
  assert.deepEqual(each(flow.nodes, "options"), [
    ["child", { inputs: { ticket: "args.ticket", rounds: "2", "dry-run": "true", plan: "plan" }, place: "worktree" }],
    ["spread", undefined],
    ["pick", { steps: ["build", "skip it"], workflows: ["ticket", "docs"], any: true }],
    ["server", { timeout: "2m", every: "5s" }],
    ["seconds", { every: "10" }],
  ]);
});

test("a schema's field names, from an object, from Type.Object, or from a const that holds one", () => {
  const flow = workflowFlow(
    wf(`
const Verdict = Type.Object({ approved: Type.Boolean(), review: Type.String() })
const shape = { type: "object", properties: { passed: { type: "boolean" } } }
await agent("a", { label: "object", schema: { type: "object", properties: { a: {}, "b-c": {} }, required: ["a"] } })
await agent("b", { label: "typebox", schema: Type.Object({ x: Type.Number() }) })
await agent("c", { label: "named typebox", schema: Verdict })
await agent("d", { label: "named object", schema: shape })
await agent("e", { label: "made", schema: makeSchema() })
`),
  );
  assert.deepEqual(
    steps(flow.nodes).map((step) => [step.label, step.options?.schema]),
    [
      ["object", ["a", "b-c"]],
      ["typebox", ["x"]],
      ["named typebox", ["approved", "review"]],
      ["named object", ["passed"]],
      ["made", undefined],
    ],
  );
});

test("an option the text makes at run time is left out, with no note", () => {
  const flow = workflowFlow(
    wf(`
let level = "high"; if (args.fast) level = "low"
await agent("a", { label: "made", timeout: limit, effort: level, skills: [first, "b"], place: where, until: how, schema: { properties: { ...base } } })
await agent("b", opts)
await ask("Which?", { choices: list })
await breakpoint("Check", { max: args.max })
await workflow("ticket", inputs, { place: args.place, label: "child" })
`),
  );
  assert.deepEqual(each(flow.nodes, "options"), [
    ["made", undefined],
    ["agent", undefined],
    ["Which?", undefined],
    ["Check", undefined],
    ["child", undefined],
  ]);
  assert.deepEqual(flow.notes, ["The agent step on line 4 takes options from opts, so its label is not known."]);
});

test("a while loop's and a do-while loop's condition on one line, and a for loop's limit", () => {
  const flow = workflowFlow(
    wf(`
while (!check(review)) review = await agent("w", { label: "work" })
do {
  r = await sh("flaky", { label: "flaky" })
} while (r.code !==
  0)
for (let i = 0; i < tries; i++) await sh("again", { label: "again" })
`),
  );
  assert.deepEqual(
    allNodes(flow.nodes).flatMap((node) => (node.t === "loop" ? [[node.loop, node.label, node.limit]] : [])),
    [
      ["while", "!check(review)", undefined],
      ["while", "r.code !== 0", undefined],
      ["for", "i < tries", "tries"],
    ],
  );
});

test("a text that does not parse gives no node and a note with the reason", () => {
  const flow = workflowFlow(wf(`await agent("a", { label: "a" }`));
  assert.deepEqual(flow.nodes, []);
  assert.equal(flow.notes.length, 1);
  assert.match(flow.notes[0], /^The text does not parse: Unexpected token \(\d+:\d+\)$/);
});

test("never throws, whatever the string", () => {
  const odd = ["", " ", "}", "return", "export const meta = {}", "\u0000", "a".repeat(10_000), "[".repeat(50_000), `${"[".repeat(3_000)}agent()${"]".repeat(3_000)}`, "agent(".repeat(2_000)];
  for (const text of odd) {
    const flow = workflowFlow(text);
    assert.ok(Array.isArray(flow.nodes) && Array.isArray(flow.notes));
  }
  assert.deepEqual(workflowFlow(undefined as unknown as string).nodes, []);
});

// The mock's graphs, written by hand from the same texts, that the owner accepted.

interface MockNode {
  t: string;
  kind?: string;
  label?: string;
  title?: string;
  agent?: string;
  model?: string;
  wf?: string;
  cond?: string;
  find?: string;
  max?: number;
  maxArg?: string;
  body?: MockNode[];
  branches?: MockNode[][];
}

/** Labels the mock shortened by hand, and the label the text gives. */
const MOCK_LABELS: Record<string, string> = {
  "Build these?": "The triager found {clear.length} clear tickets. Build these?",
  "ticket {letter}": 'ticket {"ABCDEFGH"[i]}',
  "pick what to run": "choose",
};

function mockShape(node: MockNode): unknown {
  switch (node.t) {
    case "step":
      return { step: `${node.kind} ${MOCK_LABELS[node.label!] ?? node.label}`, agent: node.agent, model: node.model, workflow: node.wf };
    case "bp":
      return { step: `breakpoint ${node.title}`, body: node.body!.map(mockShape) };
    case "gate":
    case "retry":
      return { loop: node.t, limit: node.maxArg ? `args.${node.maxArg}` : String(node.max), body: node.body!.map(mockShape) };
    case "if":
      return { if: node.cond, then: node.body!.map(mockShape) };
    case "dec":
      return { if: node.find!.slice("if (".length, -1), then: ["end"] };
    case "par":
      return { parallel: node.branches!.map((branch) => branch.map(mockShape)) };
    case "pipe":
      return { pipeline: node.body!.map((stage) => [mockShape(stage)]) };
    default:
      throw new Error(`a mock node of type ${node.t}`);
  }
}

function flowShape(node: FlowNode): unknown {
  switch (node.t) {
    case "step": {
      const shape = { step: `${node.kind} ${node.label}`, agent: node.agent, model: node.model, workflow: node.workflow };
      return node.body ? { step: shape.step, body: node.body.map(flowShape) } : shape;
    }
    case "loop":
      return { loop: node.loop, limit: node.limit, body: node.body.map(flowShape) };
    case "if":
      return { if: node.cond, then: node.then.map(flowShape) };
    case "end":
      return "end";
    case "parallel":
      return { parallel: node.branches.map((branch) => branch.map(flowShape)) };
    case "pipeline":
      return { pipeline: node.stages.map((stage) => stage.map(flowShape)) };
  }
}

// The mock is a browser script. Its values come back through JSON, so their arrays are this realm's.
const mock = JSON.parse(vm.runInNewContext(`${readFileSync(join(ROOT, "docs/features/view/mock/data.js"), "utf8")}\n;JSON.stringify({ WF_TEXT, G })`, {})) as {
  WF_TEXT: Record<string, string>;
  G: Record<string, MockNode[]>;
};

/** The mock texts that use gate(), retry() or keepSession. Their ports, below, take their place. */
const PORTED = new Set(["ticket", "fix-flaky"]);

/** The mock still draws a checkpoint() as a step. The reader draws none, and gives a note instead. */
const notCheckpoint = (node: MockNode) => !(node.t === "step" && node.kind === "checkpoint");

for (const name of Object.keys(mock.G).filter((name) => !PORTED.has(name))) {
  test(`the mock's ${name} reads as its hand-written graph`, () => {
    const flow = workflowFlow(mock.WF_TEXT[name]);
    assert.deepEqual(flow.nodes.map(flowShape), mock.G[name].filter(notCheckpoint).map(mockShape));
    const checkpoints = mock.G[name].length - mock.G[name].filter(notCheckpoint).length;
    assert.equal(flow.notes.filter((note) => note.includes("checkpoint()")).length, checkpoints);
    const ids = allNodes(flow.nodes).map((node) => node.id);
    assert.equal(new Set(ids).size, ids.length);
  });
}

/** The mock's ticket and fix-flaky, written with session() and a counted for loop, and their graphs. */
const PORTS: Record<string, { text: string; graph: unknown[] }> = {
  ticket: {
    text: `export const meta = { name: "ticket", description: "Implement a ticket, then review it until the reviewer approves" }

const impl = session({ agentType: "implementer", label: "implementer" })
const built = await impl.send(\`Implement this ticket:\\n\${args.ticket}\`, { ask: true })

let review
for (let round = 0; round < args.rounds; round++) {
  if (review) await impl.send(\`Address this review:\\n\${review.review}\`, { label: "address review" })
  review = await agent(\`Review the change for: \${args.ticket}\`, {
    agentType: "reviewer", label: "reviewer",
    schema: { approved: "boolean", review: "string" },
  })
  if (review.approved) break
}
if (!review.approved) return { summary: built, approved: false }

await sh("pnpm test", { label: "tests" })
await sh(\`git add -A && git commit -m "\${args.ticket}"\`, { label: "commit" })

return { summary: built }
`,
    graph: [
      { step: "agent implementer", agent: "implementer", model: undefined, workflow: undefined },
      {
        loop: "for",
        limit: "args.rounds",
        body: [
          { if: "review", then: [{ step: "agent address review", agent: "implementer", model: undefined, workflow: undefined }] },
          { step: "agent reviewer", agent: "reviewer", model: undefined, workflow: undefined },
        ],
      },
      { if: "!review.approved", then: ["end"] },
      { step: "sh tests", agent: undefined, model: undefined, workflow: undefined },
      { step: "sh commit", agent: undefined, model: undefined, workflow: undefined },
    ],
  },
  "fix-flaky": {
    text: `export const meta = { name: "fix-flaky", description: "Find why a test fails now and then, and fix it" }

const repro = await run("scripts/flaky.sh", { label: "reproduce", args: [args.test, args.tries] })

const cause = await agent(\`This test fails now and then:\\n\${args.test}\\n\\n\${repro.stdout}\`, {
  agentType: "investigator", label: "investigate", ask: true,
})

for (let attempt = 1; attempt <= 2; attempt++) {
  await agent(\`Fix the cause (attempt \${attempt}):\\n\${cause}\`, { agentType: "implementer", label: "fix" })
  const check = await sh(\`pnpm vitest run \${args.test} --repeat 5\`, { label: "check", allowFail: true })
  if (check.code === 0) break
}

await sh(\`pnpm vitest run \${args.test} --repeat \${args.tries}\`, { label: "verify", retries: 2 })
`,
    graph: [
      { step: "run reproduce", agent: undefined, model: undefined, workflow: undefined },
      { step: "agent investigate", agent: "investigator", model: undefined, workflow: undefined },
      {
        loop: "for",
        limit: "2",
        body: [
          { step: "agent fix", agent: "implementer", model: undefined, workflow: undefined },
          { step: "sh check", agent: undefined, model: undefined, workflow: undefined },
        ],
      },
      { step: "sh verify", agent: undefined, model: undefined, workflow: undefined },
    ],
  },
};

for (const [name, port] of Object.entries(PORTS)) {
  test(`the mock's ${name}, written with session() and a for loop, reads as its hand-written graph`, () => {
    assert.ok(PORTED.has(name));
    const flow = workflowFlow(port.text);
    assert.deepEqual(flow.nodes.map(flowShape), port.graph);
    assert.deepEqual(flow.notes, []);
    const ids = allNodes(flow.nodes).map((node) => node.id);
    assert.equal(new Set(ids).size, ids.length);
  });
}

test("the mock's pipelines go over the items as the text writes them", () => {
  const over = (name: string) => allNodes(workflowFlow(mock.WF_TEXT[name]).nodes).flatMap((node) => (node.t === "pipeline" ? [node.over] : []));
  assert.deepEqual(over("deps-update"), ["packages"]);
  assert.deepEqual(over("factory"), ["chosen"]);
  assert.match(over("release-train")[0], /^\[ "@sous\/engine", "@sous\/cli", .* "@sous\/mcp-proxy", \]$/);
});

// Every workflow file in the repo, each also cut short at every line.

function workflowFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (["node_modules", "dist", ".git"].includes(entry.name)) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return workflowFiles(path);
    return entry.name.endsWith(".js") && basename(dir) === "workflows" ? [path] : [];
  });
}

test("every workflow file in the repo reads, whole and cut short", () => {
  const files = workflowFiles(ROOT);
  assert.ok(files.length >= 20, `found only ${files.length} workflow files`);
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const flow = workflowFlow(text);
    assert.ok(steps(flow.nodes).length > 0, `${relative(ROOT, file)} has no step`);
    assert.ok(!flow.notes.some((note) => note.startsWith("The text does not parse")), `${relative(ROOT, file)}: ${flow.notes.join(" ")}`);
    const lines = text.split("\n");
    for (let cut = 1; cut < lines.length; cut++) {
      const part = workflowFlow(lines.slice(0, cut).join("\n"));
      assert.ok(Array.isArray(part.nodes) && Array.isArray(part.notes));
    }
  }
});
