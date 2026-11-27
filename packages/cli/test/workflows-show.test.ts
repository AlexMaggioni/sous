// Piece 10, workflows show, diff and agents. An agent needs everything it must know to reason
// about a workflow, and it edits and saves workflows only with the person's consent. So
// `sous workflows show <name> --json` gives the outline, `--diff` shows what changed since the
// person's last yes, which is what the person reads before they say yes again, and `sous agents
// --json` lists the agents a step can name. Piece 9's not_approved refusal gives the call
// `sous workflows show <name> --diff --json`, and these tests run that call as the refusal gives it.
//
// Decisions taken here, where the design leaves a choice:
// - The outline's step key is `step`, the label, as the proposal's example writes it. `asks` is a
//   number, as the design types it and as the run reply already gives it.
// - `approved` is the approval of the file's current text when one of its kept approvals matches
//   it, with changedSince false. Otherwise it is the newest approval, with changedSince true. So
//   changedSince is false exactly when an agent's run of the text would start. The other option,
//   comparing with the newest approval only, said "changed" for a text put back to one the person
//   approved before, which runs. The diff compares with the same approval.
// - A seeded workflow shows `approved: {by: "sous", seeded: true, changedSince: false, at}`. The
//   seed is a real approval: an agent's run starts. The other option, null, would send the agent
//   to ask the person for a yes that sous does not need.
// - `next` gives the calls that work now. A new or changed workflow gives the check and the
//   approve call, and no run call, since an agent's run would be refused. An approved one gives
//   run and check, and no approve call. Each call keeps the command's --project, as the calls in
//   an error do, and parses against COMMANDS.
// - `--diff` gives `diff`, a list of lines from lineDiff, with `name`, `file` and `approved`. A
//   new file shows in full, each line with "+ ". An unchanged workflow gives an empty diff and a
//   note. The approve call in next is the one the not_approved refusal's change gives, word for
//   word.
// - The diff is cut at 200 lines, with a note that says so and names the file. A change far down
//   a long file still shows inside the 200 lines: the cli keeps only enough matching lines around
//   each change. The other option, the whole file cut at line 200, hid a change at line 250 from
//   the person who must approve it.
// - The outline stays under 8,000 characters, as every read does (design, Replies). A long
//   workflow's steps are cut with a note naming --full, which gives every step, as decision 7
//   does for `sous show`.
// - lastRuns lists the last 3 runs of the workflow's file, newest first, whatever their status,
//   as {runId, status, seconds, tokens}. A dry run of `sous check` is left out: it ran stand-in
//   agents, so its cost says nothing about a real run.
// - `sous agents --json` gives {agents: [{name, description, harness, only, model, file}]}, for the
//   project's folders and the home's, as lookupAgents finds them. `model` is the model on the
//   agent's own harness, where its file names one.
// - A show adds no line to events.jsonl. It only reads.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { rememberProject, type HomePaths } from "@sous-run/engine";
import { inProcess, testHome, type InnerRunner, type InProcessWorkers } from "@sous-run/engine/testing";
import { callProblem, words } from "./helpers/calls.js";
import { sous } from "./sous.js";

const PERSON: NodeJS.ProcessEnv = {};
const CLAUDE: NodeJS.ProcessEnv = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s1" };

const HELLO = readFileSync(join(import.meta.dirname, "fixtures", "workflows", "hello.js"), "utf8");

/** A workflow with no input that runs one sh step and returns `result`. */
const plain = (name: string, result = `${name} ran`, step = "echo ok") =>
  `export const meta = { name: "${name}", description: "${name}", place: "none" }\n\nawait sh(${JSON.stringify(step)}, { label: "${name} step" })\nreturn ${JSON.stringify(result)}\n`;

/** A workflow of every kind of step, an ask and a breakpoint, and a nested greet. */
const TICKET = `export const meta = {
  name: "ticket",
  description: "Implement a ticket, review it",
  inputs: { ticket: { type: "string", description: "What to build", required: true } },
  place: "none",
}

const impl = session({ agentType: "implementer", label: "implementer", model: "claude/haiku" })
const built = await impl.send(\`Implement this ticket:\\n\${args.ticket}\`)
await sh("git diff", { label: "diff" })
const color = await ask("Which color?", { choices: ["red", "blue"] })
await breakpoint("Approve the change", () => js("return 1", null, { label: "summary" }))
await workflow("greet", {}, { label: "nested greet" })
return { built, color }
`;

/** A new file of `count` lines: the meta, comments "// line N", and a return. */
function long(name: string, count: number): string {
  const lines = [`export const meta = { name: "${name}", description: "${name}", place: "none" }`];
  for (let n = lines.length + 1; n < count; n++) lines.push(`// line ${n}`);
  lines.push("return 1");
  return `${lines.join("\n")}\n`;
}

/** These workflows run sh and js steps, so no agent runs. */
const runner = { run: async () => "unused" } as unknown as InnerRunner;

const workflowFile = (projectDir: string, name: string) => join(projectDir, ".sous", "workflows", `${name}.js`);
const events = (paths: HomePaths) => {
  try {
    return readFileSync(join(paths.home, "events.jsonl"), "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
};
const pause = () => new Promise((done) => setTimeout(done, 5));

/** The JSON sous printed. */
function json(printed: { code: number; out: string }): Record<string, any> {
  let parsed: unknown;
  assert.doesNotThrow(() => (parsed = JSON.parse(printed.out)), `sous printed no JSON object (exit ${printed.code}):\n${printed.out}`);
  return parsed as Record<string, any>;
}

/** The reply of `sous workflows show ...`, which must exit 0 and be the outline of `name`. */
async function show(paths: HomePaths, projectDir: string, name: string, extra: string[] = [], env: NodeJS.ProcessEnv = PERSON): Promise<Record<string, any>> {
  const printed = await sous(paths, ["workflows", "show", name, ...extra, "--json", "--project", projectDir], { env });
  assert.equal(printed.code, 0, `workflows show ${name} ${extra.join(" ")} exits 0:\n${printed.out}`);
  const reply = json(printed);
  assert.ok(Array.isArray(reply.notes) && Array.isArray(reply.next), `the reply has notes and next:\n${printed.out}`);
  isShow(reply, printed.out);
  return reply;
}

/** Fails unless the reply is one workflow's outline or diff. Today `workflows show` lists them all. */
function isShow(reply: Record<string, any>, printed: string): void {
  assert.ok(Array.isArray(reply.steps) || Array.isArray(reply.diff), `the reply is no workflow's outline or diff:\n${printed}`);
}

const calls = (reply: Record<string, any>): string[] => (reply.next as Array<{ call: string }>).map((next) => next.call);

/** Each call in next parses against the commands sous has. */
function parses(reply: Record<string, any>): void {
  for (const call of calls(reply)) assert.equal(callProblem(call), undefined, `next: ${call}`);
}

/** The approve call that `workflows show` gives, the same as the not_approved refusal's change. */
const approveCall = (name: string, projectDir: string) => `sous workflows approve ${name} --by person --json --project ${projectDir}`;

/** The not_approved refusal of an agent's run of `name`: its call, and the approve call its change gives. */
async function refusalOf(paths: HomePaths, projectDir: string, name: string, workers: InProcessWorkers, inputs: string[] = []): Promise<{ call: string; approve: string }> {
  const refused = await sous(paths, ["run", name, ...inputs, "--json", "--project", projectDir], { env: CLAUDE, launch: workers.launch });
  assert.equal(refused.code, 66, `an agent's run of ${name} is refused:\n${refused.out}`);
  const { error } = json(refused);
  assert.equal(error.code, "not_approved", refused.out);
  const approve = /sous workflows approve [^\s,]+ --by person --json(?: --project [^\s,]+)?/.exec(error.change)?.[0];
  assert.ok(approve, `the change gives the approve call: ${error.change}`);
  return { call: error.call as string, approve };
}

/** Seed the approvals of the project's workflows as they are now, as a first command does. */
async function seed(paths: HomePaths, projectDir: string): Promise<void> {
  rememberProject(paths, projectDir);
  assert.equal((await sous(paths, ["workflows", "--json", "--project", projectDir])).code, 0);
}

/** Start a run and wait for its worker. Fails when sous refuses it. */
async function ran(paths: HomePaths, env: NodeJS.ProcessEnv, argv: string[], workers: InProcessWorkers): Promise<string> {
  const run = await sous(paths, [...argv, "--json"], { env, launch: workers.launch });
  assert.equal(run.code, 0, `${argv.join(" ")}:\n${run.out}`);
  const runId = json(run).runId as string;
  await workers.ended(runId).catch(() => undefined);
  return runId;
}

/** Let every worker the test started end, so none outlives it. */
async function settle(workers: InProcessWorkers): Promise<void> {
  for (const { runId } of workers.launched) await workers.ended(runId).catch(() => undefined);
}

describe("piece 10: sous workflows show", () => {
  it("a new file gives its outline with approved null, and next gives the check and the approve call, not a run", async () => {
    const { paths, projectDir } = testHome({ hello: HELLO });
    await seed(paths, projectDir);
    writeFileSync(workflowFile(projectDir, "greet"), plain("greet"));
    const before = events(paths);

    const outline = await show(paths, projectDir, "greet");
    assert.equal(outline.name, "greet");
    assert.equal(outline.file, workflowFile(projectDir, "greet"));
    assert.equal(outline.from, "project");
    assert.equal(outline.description, "greet");
    assert.deepEqual(outline.inputs, {});
    assert.equal(outline.startedBy, "anyone");
    assert.deepEqual(outline.steps.map((step: Record<string, unknown>) => [step.kind, step.step]), [["sh", "greet step"]]);
    assert.equal(outline.asks, 0);
    assert.deepEqual(outline.workflows, []);
    assert.deepEqual(outline.check.problems, []);
    assert.ok(Array.isArray(outline.check.notes), JSON.stringify(outline.check));
    assert.equal(outline.approved, null, "a new file has no approval");
    assert.deepEqual(outline.lastRuns, []);

    assert.ok(calls(outline).includes(approveCall("greet", projectDir)), `next gives the approve call: ${calls(outline).join("\n")}`);
    assert.ok(calls(outline).some((call) => call.startsWith("sous check greet ")), `next gives the check: ${calls(outline).join("\n")}`);
    assert.ok(!calls(outline).some((call) => call.startsWith("sous run greet")), `next gives no run, which would be refused: ${calls(outline).join("\n")}`);
    parses(outline);
    await show(paths, projectDir, "greet", ["--diff"]);
    assert.equal((await sous(paths, ["agents", "--json", "--project", projectDir])).code, 0);
    assert.equal(events(paths), before, "a show, a diff and the agents list add no line to events.jsonl");
  });

  it("after the person approves, approved holds by, at and changedSince false, and next gives run and check, not approve", async () => {
    const { paths, projectDir } = testHome({ hello: HELLO });
    await seed(paths, projectDir);
    writeFileSync(workflowFile(projectDir, "greet"), plain("greet"));
    const approved = await sous(paths, ["workflows", "approve", "greet", "--json", "--project", projectDir], { env: PERSON });
    assert.equal(approved.code, 0, approved.out);

    const outline = await show(paths, projectDir, "greet");
    assert.equal(outline.approved?.by, "person", JSON.stringify(outline.approved));
    assert.ok(!Number.isNaN(Date.parse(outline.approved.at)), `at is a time: ${outline.approved.at}`);
    assert.equal(outline.approved.changedSince, false);
    assert.ok(calls(outline).some((call) => call.startsWith("sous run greet")), `next gives the run: ${calls(outline).join("\n")}`);
    assert.ok(calls(outline).some((call) => call.startsWith("sous check greet ")), `next gives the check: ${calls(outline).join("\n")}`);
    assert.ok(!calls(outline).some((call) => call.startsWith("sous workflows approve")), `next gives no approve: ${calls(outline).join("\n")}`);
    parses(outline);
  });

  it("after an edit, changedSince is true and next gives the approve call again", async () => {
    const { paths, projectDir } = testHome({ hello: HELLO });
    await seed(paths, projectDir);
    writeFileSync(workflowFile(projectDir, "greet"), plain("greet"));
    assert.equal((await sous(paths, ["workflows", "approve", "greet", "--json", "--project", projectDir], { env: PERSON })).code, 0);
    writeFileSync(workflowFile(projectDir, "greet"), plain("greet", "greet ran again"));

    const outline = await show(paths, projectDir, "greet");
    assert.equal(outline.approved?.by, "person", JSON.stringify(outline.approved));
    assert.equal(outline.approved.changedSince, true);
    assert.ok(calls(outline).includes(approveCall("greet", projectDir)), `next gives the approve call: ${calls(outline).join("\n")}`);
    assert.ok(!calls(outline).some((call) => call.startsWith("sous run greet")), `next gives no run: ${calls(outline).join("\n")}`);
  });

  it("a seeded workflow shows the seed's approval, by sous, and next gives the run", async () => {
    const { paths, projectDir } = testHome({ hello: HELLO });
    rememberProject(paths, projectDir);

    const outline = await show(paths, projectDir, "hello");
    assert.equal(outline.approved?.by, "sous", JSON.stringify(outline.approved));
    assert.equal(outline.approved.seeded, true);
    assert.equal(outline.approved.changedSince, false);
    assert.deepEqual(Object.keys(outline.inputs), ["name"]);
    assert.deepEqual(outline.steps.map((step: Record<string, unknown>) => [step.kind, step.step]), [["js", "greet"]]);
    assert.ok(calls(outline).some((call) => call.startsWith("sous run hello")), `next gives the run: ${calls(outline).join("\n")}`);
    assert.ok(!calls(outline).some((call) => call.startsWith("sous workflows approve")), `next gives no approve: ${calls(outline).join("\n")}`);
  });

  it("a text the person approved before, put back, has changedSince false, as an agent's run of it starts", async () => {
    const { paths, projectDir } = testHome({ hello: HELLO });
    const workers = inProcess({ inner: runner });
    try {
      await seed(paths, projectDir);
      const first = plain("greet");
      writeFileSync(workflowFile(projectDir, "greet"), first);
      assert.equal((await sous(paths, ["workflows", "approve", "greet", "--json", "--project", projectDir], { env: PERSON })).code, 0);
      writeFileSync(workflowFile(projectDir, "greet"), plain("greet", "second"));
      assert.equal((await sous(paths, ["workflows", "approve", "greet", "--json", "--project", projectDir], { env: PERSON })).code, 0);
      writeFileSync(workflowFile(projectDir, "greet"), first);

      const outline = await show(paths, projectDir, "greet");
      assert.equal(outline.approved?.changedSince, false, JSON.stringify(outline.approved));
      const diffed = await show(paths, projectDir, "greet", ["--diff"]);
      assert.deepEqual(diffed.diff, [], "the text matches an approval, so nothing shows as changed");
      await ran(paths, CLAUDE, ["run", "greet", "--project", projectDir], workers);
    } finally {
      await settle(workers);
    }
  });

  it("gives each step in the order written with its kind, label, agent and model, the asks, the nested workflows and the check's problems", async () => {
    const { paths, projectDir } = testHome({ greet: plain("greet"), ticket: TICKET });

    const outline = await show(paths, projectDir, "ticket");
    assert.deepEqual(outline.steps.map((step: Record<string, unknown>) => [step.kind, step.step]), [
      ["agent", "implementer"],
      ["sh", "diff"],
      ["ask", undefined],
      ["breakpoint", undefined],
      ["js", "summary"],
      ["workflow", "nested greet"],
    ]);
    const implementer = outline.steps[0];
    assert.equal(implementer.agent, "implementer");
    assert.equal(implementer.model, "claude/haiku");
    assert.equal(implementer.session, "implementer");
    assert.equal(outline.asks, 2, "the ask and the breakpoint");
    assert.deepEqual(outline.workflows, ["greet"]);
    assert.deepEqual(Object.keys(outline.inputs), ["ticket"]);
    assert.ok(outline.check.problems.some((problem: string) => /no agent "implementer"/.test(problem)), `the check finds no agent implementer: ${JSON.stringify(outline.check)}`);
    assert.ok(outline.notes.some((note: string) => /order/i.test(note)), `a note says the steps are in the order written: ${JSON.stringify(outline.notes)}`);
    const text = await sous(paths, ["workflows", "show", "ticket", "--project", projectDir], { env: PERSON });
    assert.match(text.out, /^ {2}agent {2}implementer {2}\(agent implementer, claude\/haiku, in session implementer\)$/m);
  });

  it("from is home for a workflow in the home's folder and path for a file given by its path", async () => {
    const { paths, projectDir } = testHome({ hello: HELLO });
    mkdirSync(paths.workflows, { recursive: true });
    writeFileSync(join(paths.workflows, "tidy.js"), plain("tidy"));
    const loose = join(mkdtempSync(join(tmpdir(), "sous-loose-")), "loose.js");
    writeFileSync(loose, plain("loose"));

    const home = await show(paths, projectDir, "tidy");
    assert.equal(home.from, "home");
    assert.equal(home.file, join(paths.workflows, "tidy.js"));
    const path = await show(paths, projectDir, loose);
    assert.equal(path.from, "path");
    assert.equal(path.file, loose);
  });

  it("lastRuns gives the last 3 runs of this workflow, newest first, and leaves out other workflows and dry runs", async () => {
    const { paths, projectDir } = testHome({ hello: HELLO, greet: plain("greet") });
    const workers = inProcess({ inner: runner });
    try {
      const runIds: string[] = [];
      for (let n = 0; n < 4; n++) {
        runIds.push(await ran(paths, PERSON, ["run", "greet", "--project", projectDir], workers));
        await pause();
      }
      await ran(paths, PERSON, ["run", "hello", "--name", "Ada", "--project", projectDir], workers);
      await pause();
      const dry = await sous(paths, ["check", "greet", "--dry-run", "--json", "--project", projectDir], { env: PERSON });
      assert.equal(dry.code, 0, dry.out);

      const outline = await show(paths, projectDir, "greet");
      assert.deepEqual(outline.lastRuns.map((run: Record<string, unknown>) => run.runId), [runIds[3], runIds[2], runIds[1]]);
      for (const run of outline.lastRuns) {
        assert.equal(run.status, "completed", JSON.stringify(run));
        assert.equal(typeof run.seconds, "number", JSON.stringify(run));
        assert.equal(typeof run.tokens, "number", JSON.stringify(run));
      }
    } finally {
      await settle(workers);
    }
  });

  it("a long workflow's outline stays under 8,000 characters, with a note naming --full, which gives every step", async () => {
    const steps = Array.from({ length: 120 }, (_, n) => `await sh("echo step ${n + 1} of the long workflow", { label: "step ${n + 1} of the long workflow" })`);
    const { paths, projectDir } = testHome({ big: `export const meta = { name: "big", description: "big", place: "none" }\n${steps.join("\n")}\nreturn 1\n` });

    const printed = await sous(paths, ["workflows", "show", "big", "--json", "--project", projectDir]);
    assert.equal(printed.code, 0, printed.out);
    assert.ok(printed.out.length < 8000, `the reply is ${printed.out.length} characters`);
    const outline = json(printed);
    isShow(outline, printed.out);
    assert.ok(outline.steps.length < 120, "the steps are cut");
    assert.ok(outline.notes.some((note: string) => note.includes("--full")), `a note names --full: ${JSON.stringify(outline.notes)}`);
    const full = await show(paths, projectDir, "big", ["--full"]);
    assert.equal(full.steps.length, 120);
  });

  it("an unknown name exits 65 with no_such_workflow and the call that lists the workflows", async () => {
    const { paths, projectDir } = testHome({ hello: HELLO });
    for (const extra of [[], ["--diff"]]) {
      const printed = await sous(paths, ["workflows", "show", "nosuch", ...extra, "--json", "--project", projectDir]);
      assert.equal(printed.code, 65, printed.out);
      const { error } = json(printed);
      assert.equal(error.code, "no_such_workflow");
      assert.equal(error.call, `sous workflows --json --project ${projectDir}`);
    }
    const bare = await sous(paths, ["workflows", "show", "--json", "--project", projectDir]);
    assert.equal(bare.code, 64, `workflows show with no name is a usage error:\n${bare.out}`);
  });
});

describe("piece 10: sous workflows show --diff", () => {
  it("a new file shows in full, each line with +, and next holds the approve call", async () => {
    const { paths, projectDir } = testHome({ hello: HELLO });
    await seed(paths, projectDir);
    const text = plain("greet");
    writeFileSync(workflowFile(projectDir, "greet"), text);

    const diffed = await show(paths, projectDir, "greet", ["--diff"]);
    assert.equal(diffed.name, "greet");
    assert.equal(diffed.file, workflowFile(projectDir, "greet"));
    assert.equal(diffed.approved, null);
    assert.deepEqual(diffed.diff, text.replace(/\n$/, "").split("\n").map((line) => `+ ${line}`));
    assert.ok(calls(diffed).includes(approveCall("greet", projectDir)), `next gives the approve call: ${calls(diffed).join("\n")}`);
    parses(diffed);
  });

  it("an edited workflow shows the edited line against the approved text, and next holds the approve call the refusal's change gives", async () => {
    const { paths, projectDir } = testHome({ hello: HELLO });
    const workers = inProcess({ inner: runner });
    try {
      await seed(paths, projectDir);
      writeFileSync(workflowFile(projectDir, "hello"), HELLO.replace("Say hello", "Say hi"));
      const { approve } = await refusalOf(paths, projectDir, "hello", workers, ["--name", "Ada"]);

      const diffed = await show(paths, projectDir, "hello", ["--diff"]);
      assert.equal(diffed.approved?.changedSince, true, JSON.stringify(diffed.approved));
      assert.deepEqual(diffed.diff.filter((line: string) => line.startsWith("- ")), ['-   description: "Say hello to someone",']);
      assert.deepEqual(diffed.diff.filter((line: string) => line.startsWith("+ ")), ['+   description: "Say hi to someone",']);
      assert.ok(calls(diffed).includes(approve), `next holds ${approve}: ${calls(diffed).join("\n")}`);
      assert.equal(approve, approveCall("hello", projectDir));
    } finally {
      await settle(workers);
    }
  });

  it("an unchanged workflow says so in a note, with an empty diff and no approve call", async () => {
    const { paths, projectDir } = testHome({ hello: HELLO });
    await seed(paths, projectDir);

    const diffed = await show(paths, projectDir, "hello", ["--diff"]);
    assert.deepEqual(diffed.diff, []);
    assert.equal(diffed.approved?.changedSince, false);
    assert.ok(diffed.notes.some((note: string) => /approved/i.test(note)), `a note says the text is approved as it is: ${JSON.stringify(diffed.notes)}`);
    assert.ok(!calls(diffed).some((call) => call.startsWith("sous workflows approve")), `next gives no approve: ${calls(diffed).join("\n")}`);
  });

  it("a long new file is cut at 200 lines, with a note that says so and names the file", async () => {
    const { paths, projectDir } = testHome();
    writeFileSync(workflowFile(projectDir, "big"), long("big", 300));

    const diffed = await show(paths, projectDir, "big", ["--diff"]);
    assert.equal(diffed.diff.length, 200);
    assert.ok(diffed.diff.every((line: string) => line.startsWith("+ ")));
    const note = diffed.notes.find((text: string) => text.includes("200"));
    assert.ok(note, `a note says the diff is cut at 200 lines: ${JSON.stringify(diffed.notes)}`);
    assert.ok(note.includes(workflowFile(projectDir, "big")), `the note names the file: ${note}`);
  });

  it("an edit far down a long approved file still shows inside the 200 lines", async () => {
    const { paths, projectDir } = testHome();
    const text = long("big", 300);
    writeFileSync(workflowFile(projectDir, "big"), text);
    assert.equal((await sous(paths, ["workflows", "approve", "big", "--json", "--project", projectDir], { env: PERSON })).code, 0);
    writeFileSync(workflowFile(projectDir, "big"), text.replace("// line 250\n", "// LINE 250\n"));

    const diffed = await show(paths, projectDir, "big", ["--diff"]);
    assert.ok(diffed.diff.length <= 200, `the diff has ${diffed.diff.length} lines`);
    assert.deepEqual(diffed.diff.filter((line: string) => line.startsWith("- ")), ["- // line 250"]);
    assert.deepEqual(diffed.diff.filter((line: string) => line.startsWith("+ ")), ["+ // LINE 250"]);
  });

  it("prints the diff in text too", async () => {
    const { paths, projectDir } = testHome({ hello: HELLO });
    await seed(paths, projectDir);
    writeFileSync(workflowFile(projectDir, "greet"), plain("greet"));

    const printed = await sous(paths, ["workflows", "show", "greet", "--diff", "--project", projectDir]);
    assert.equal(printed.code, 0, printed.out);
    assert.ok(printed.out.includes('+ await sh("echo ok", { label: "greet step" })'), printed.out);
  });
});

describe("piece 10: the call of the not_approved refusal works", () => {
  it("the call of a real refusal shows the new file, and the approve call it gives lets the agent's run start", async () => {
    const { paths, projectDir } = testHome({ hello: HELLO });
    const workers = inProcess({ inner: runner });
    try {
      await seed(paths, projectDir);
      const text = plain("greet");
      writeFileSync(workflowFile(projectDir, "greet"), text);
      const { call, approve } = await refusalOf(paths, projectDir, "greet", workers);
      assert.equal(callProblem(call), undefined, `the refusal's call parses: ${call}`);

      const shown = await sous(paths, words(call).slice(1), { env: CLAUDE });
      assert.equal(shown.code, 0, `${call} exits 0:\n${shown.out}`);
      const diffed = json(shown);
      isShow(diffed, shown.out);
      assert.deepEqual(diffed.diff, text.replace(/\n$/, "").split("\n").map((line) => `+ ${line}`));
      assert.ok(calls(diffed).includes(approve), `next holds ${approve}: ${calls(diffed).join("\n")}`);

      const approved = await sous(paths, words(approve).slice(1), { env: CLAUDE });
      assert.equal(approved.code, 0, `${approve}:\n${approved.out}`);
      await ran(paths, CLAUDE, ["run", "greet", "--project", projectDir], workers);
    } finally {
      await settle(workers);
    }
  });

  it("the call for a workflow file given by its path runs too", async () => {
    const { paths, projectDir } = testHome({ hello: HELLO });
    const workers = inProcess({ inner: runner });
    try {
      await seed(paths, projectDir);
      const loose = join(mkdtempSync(join(tmpdir(), "sous-loose-")), "loose.js");
      writeFileSync(loose, plain("loose"));
      const { call } = await refusalOf(paths, projectDir, loose, workers);

      const shown = await sous(paths, words(call).slice(1), { env: CLAUDE });
      assert.equal(shown.code, 0, `${call} exits 0:\n${shown.out}`);
      const diffed = json(shown);
      isShow(diffed, shown.out);
      assert.equal(diffed.file, loose);
      assert.ok(diffed.diff.length > 0 && diffed.diff.every((line: string) => line.startsWith("+ ")), JSON.stringify(diffed.diff));
    } finally {
      await settle(workers);
    }
  });
});

describe("piece 10: sous agents", () => {
  it("lists the agents of the project's folders and of the home, with name, description, harness, the harness it runs only on, model and file", async () => {
    const { paths, projectDir } = testHome();
    const implementer = join(projectDir, ".rulesync", "subagents", "implementer.md");
    const fixer = join(projectDir, ".codex", "agents", "fixer.toml");
    mkdirSync(join(projectDir, ".rulesync", "subagents"), { recursive: true });
    mkdirSync(join(projectDir, ".codex", "agents"), { recursive: true });
    writeFileSync(implementer, "---\nname: implementer\ndescription: builds\nclaudecode:\n  model: haiku\n---\nBuild it.\n");
    writeFileSync(fixer, 'name = "fixer"\ndescription = "fixes"\nmodel = "gpt-test"\ndeveloper_instructions = "Fix it."\n');
    // The home's Claude Code folder, in a folder of this test's own. Only the test home is touched.
    const claudeHome = mkdtempSync(join(tmpdir(), "sous-claude-home-"));
    const helper = join(claudeHome, "agents", "helper.md");
    mkdirSync(join(claudeHome, "agents"), { recursive: true });
    writeFileSync(helper, "---\nname: helper\ndescription: helps\nmodel: sonnet\n---\nHelp.\n");

    const before = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claudeHome;
    try {
      const printed = await sous(paths, ["agents", "--json", "--project", projectDir], { env: { ...process.env } });
      assert.equal(printed.code, 0, printed.out);
      const listed = json(printed);
      assert.ok(Array.isArray(listed.notes) && Array.isArray(listed.next), printed.out);
      const byName = new Map((listed.agents as Array<Record<string, any>>).map((agent) => [agent.name, agent]));
      assert.deepEqual([...byName.keys()].sort(), ["fixer", "helper", "implementer"], printed.out);

      assert.equal(byName.get("implementer")!.description, "builds");
      assert.equal(byName.get("implementer")!.harness, "claude");
      assert.match(String(byName.get("implementer")!.model), /haiku/);
      assert.equal(byName.get("implementer")!.file, implementer);

      assert.equal(byName.get("fixer")!.description, "fixes");
      assert.equal(byName.get("fixer")!.harness, "codex");
      assert.match(String(byName.get("fixer")!.model), /gpt-test/);
      assert.equal(byName.get("fixer")!.file, fixer);

      assert.equal(byName.get("helper")!.description, "helps");
      assert.equal(byName.get("helper")!.harness, "claude");
      assert.match(String(byName.get("helper")!.model), /sonnet/);
      assert.equal(byName.get("helper")!.file, helper);

      // A harness's own folder runs its agent on that harness only. A rulesync file runs on both.
      assert.equal(byName.get("implementer")!.only, undefined);
      assert.equal(byName.get("fixer")!.only, "codex");
      assert.equal(byName.get("helper")!.only, "claude");

      const text = await sous(paths, ["agents", "--project", projectDir], { env: { ...process.env } });
      assert.equal(text.code, 0, text.out);
      for (const name of ["implementer", "fixer", "helper"]) assert.ok(text.out.includes(name), `the text names ${name}:\n${text.out}`);
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = before;
    }
  });

  it("a project with no agent gives an empty list", async () => {
    const { paths, projectDir } = testHome();
    const claudeHome = mkdtempSync(join(tmpdir(), "sous-claude-home-"));
    const before = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claudeHome;
    try {
      const printed = await sous(paths, ["agents", "--json", "--project", projectDir], { env: { ...process.env } });
      assert.equal(printed.code, 0, printed.out);
      assert.deepEqual(json(printed).agents, []);
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = before;
    }
  });
});

describe("piece 10: the writing guide and the calls", () => {
  it("the writing topic sends the agent to workflows show --diff before the person approves", () => {
    const text = readFileSync(join(import.meta.dirname, "..", "guide", "writing.md"), "utf8");
    assert.ok(text.includes("sous workflows show"), "writing.md names sous workflows show");
    const diff = text.indexOf("--diff");
    const approve = text.indexOf("sous workflows approve <name> --by person");
    assert.ok(diff !== -1, "writing.md names --diff");
    assert.ok(approve !== -1, "writing.md gives the approve call");
    assert.ok(diff < approve, "writing.md shows the person the diff before it gives the approve call");
  });

  it("the show, diff, full and agents calls parse against the commands sous has", () => {
    for (const call of [
      "sous workflows show greet --json",
      "sous workflows show greet --diff --json",
      "sous workflows show greet --full --json --project /tmp/p",
      "sous agents --json",
      "sous agents --json --project /tmp/p",
    ]) {
      assert.equal(callProblem(call), undefined, call);
    }
  });
});
