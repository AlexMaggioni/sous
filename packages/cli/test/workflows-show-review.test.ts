// Piece 10's review fixes. The calls `sous workflows show` and the not_approved refusal give work
// when pasted, with a space in a workflow's name or in its path. The outline of a workflow that
// starts a saved workflow with no yes gives no run call, since that run would be refused. The
// outline stays under 8,000 characters however many problems the check finds, and the diff says
// where each part of the file it shows starts.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { rememberProject, type HomePaths } from "@sous-run/engine";
import { inProcess, testHome, type InnerRunner, type InProcessWorkers } from "@sous-run/engine/testing";
import { callProblem, words } from "./helpers/calls.js";
import { sous } from "./sous.js";

const PERSON: NodeJS.ProcessEnv = {};
const CLAUDE: NodeJS.ProcessEnv = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s1" };

/** A workflow with no input that runs one sh step, and `more` after it. */
const plain = (name: string, more = "") =>
  `export const meta = { name: "${name}", description: "${name}", place: "none" }\n\nawait sh("echo ok", { label: "${name} step" })\n${more}return "${name} ran"\n`;

/** These workflows run sh steps, so no agent runs. */
const runner = { run: async () => "unused" } as unknown as InnerRunner;

const workflowFile = (projectDir: string, name: string) => join(projectDir, ".sous", "workflows", `${name}.js`);

function json(printed: { code: number; out: string }): Record<string, any> {
  let parsed: unknown;
  assert.doesNotThrow(() => (parsed = JSON.parse(printed.out)), `sous printed no JSON object (exit ${printed.code}):\n${printed.out}`);
  return parsed as Record<string, any>;
}

const calls = (reply: Record<string, any>): string[] => (reply.next as Array<{ call: string }>).map((next) => next.call);

/** Run a call as a shell gives it to sous: its words, quotes removed. */
async function paste(paths: HomePaths, call: string, env: NodeJS.ProcessEnv, workers?: InProcessWorkers): Promise<Record<string, any>> {
  assert.equal(callProblem(call), undefined, `the call parses: ${call}`);
  const printed = await sous(paths, words(call).slice(1), { env, ...(workers ? { launch: workers.launch } : {}) });
  assert.equal(printed.code, 0, `${call} exits 0:\n${printed.out}`);
  return json(printed);
}

async function seed(paths: HomePaths, projectDir: string): Promise<void> {
  rememberProject(paths, projectDir);
  assert.equal((await sous(paths, ["workflows", "--json", "--project", projectDir])).code, 0);
}

/** The not_approved refusal of an agent's run of `name`. */
async function refused(paths: HomePaths, projectDir: string, name: string, workers: InProcessWorkers): Promise<{ call: string; change: string }> {
  const printed = await sous(paths, ["run", name, "--json", "--project", projectDir], { env: CLAUDE, launch: workers.launch });
  assert.equal(printed.code, 66, `an agent's run of ${name} is refused:\n${printed.out}`);
  const { error } = json(printed);
  assert.equal(error.code, "not_approved", printed.out);
  return { call: error.call as string, change: error.change as string };
}

async function settle(workers: InProcessWorkers): Promise<void> {
  for (const { runId } of workers.launched) await workers.ended(runId).catch(() => undefined);
}

describe("piece 10 review: calls with a space in a name or a path", () => {
  it("a workflow named my flow gives a refusal call and an approve call that work when pasted", async () => {
    const { paths, projectDir } = testHome();
    const workers = inProcess({ inner: runner });
    try {
      await seed(paths, projectDir);
      writeFileSync(workflowFile(projectDir, "my flow"), plain("my flow"));
      const { call, change } = await refused(paths, projectDir, "my flow", workers);

      const diffed = await paste(paths, call, CLAUDE);
      assert.equal(diffed.name, "my flow");
      const approve = calls(diffed).find((next) => next.startsWith("sous workflows approve"));
      assert.ok(approve, `next gives the approve call: ${calls(diffed).join("\n")}`);
      assert.ok(change.includes(approve), `the refusal's change gives the same approve call, ${approve}: ${change}`);
      await paste(paths, approve, CLAUDE);

      const outline = await paste(paths, `sous workflows show 'my flow' --json --project ${projectDir}`, CLAUDE);
      const run = calls(outline).find((next) => next.startsWith("sous run"));
      assert.ok(run, `an approved workflow gives the run call: ${calls(outline).join("\n")}`);
      const started = await paste(paths, run, CLAUDE, workers);
      await workers.ended(started.runId as string);
    } finally {
      await settle(workers);
    }
  });

  it("a workflow file under a folder with a space gives calls that work when pasted", async () => {
    const { paths, projectDir } = testHome();
    const workers = inProcess({ inner: runner });
    try {
      await seed(paths, projectDir);
      const loose = join(mkdtempSync(join(tmpdir(), "sous loose ")), "loose.js");
      writeFileSync(loose, plain("loose"));
      const { call } = await refused(paths, projectDir, loose, workers);

      const diffed = await paste(paths, call, CLAUDE);
      assert.equal(diffed.file, loose);
      const approve = calls(diffed).find((next) => next.startsWith("sous workflows approve"));
      assert.ok(approve, `next gives the approve call: ${calls(diffed).join("\n")}`);
      const approved = await paste(paths, approve, CLAUDE);
      assert.equal(approved.approved[0]?.file, loose, JSON.stringify(approved));
    } finally {
      await settle(workers);
    }
  });
});

describe("piece 10 review: a workflow that starts one with no yes", () => {
  it("gives no run call while the nested workflow has no yes, and names it in a note and a diff call", async () => {
    const { paths, projectDir } = testHome();
    const workers = inProcess({ inner: runner });
    try {
      await seed(paths, projectDir);
      writeFileSync(workflowFile(projectDir, "inner"), plain("inner"));
      writeFileSync(workflowFile(projectDir, "outer"), plain("outer", 'await workflow("inner", {}, { label: "nested" })\n'));
      assert.equal((await sous(paths, ["workflows", "approve", "outer", "--json", "--project", projectDir], { env: PERSON })).code, 0);

      const outline = await paste(paths, `sous workflows show outer --json --project ${projectDir}`, CLAUDE);
      assert.equal(outline.approved?.changedSince, false, JSON.stringify(outline.approved));
      assert.ok(!calls(outline).some((next) => next.startsWith("sous run")), `next gives no run, which would be refused: ${calls(outline).join("\n")}`);
      assert.ok(calls(outline).includes(`sous workflows show inner --diff --json --project ${projectDir}`), `next shows inner's diff: ${calls(outline).join("\n")}`);
      assert.ok(outline.notes.some((note: string) => note.includes("inner")), `a note names inner: ${JSON.stringify(outline.notes)}`);
      await refused(paths, projectDir, "outer", workers);

      assert.equal((await sous(paths, ["workflows", "approve", "inner", "--json", "--project", projectDir], { env: PERSON })).code, 0);
      const after = await paste(paths, `sous workflows show outer --json --project ${projectDir}`, CLAUDE);
      assert.ok(calls(after).some((next) => next.startsWith("sous run outer")), `once inner has its yes, next gives the run: ${calls(after).join("\n")}`);
    } finally {
      await settle(workers);
    }
  });
});

describe("piece 10 review: the outline and the diff", () => {
  it("an outline with many problems from the check stays under 8,000 characters, with a note naming --full", async () => {
    const { paths, projectDir } = testHome();
    const steps = Array.from({ length: 150 }, (_, n) => `await agent("do ${n}", { agentType: "missing-agent-${n}", label: "step ${n}" })`);
    writeFileSync(workflowFile(projectDir, "broken"), `export const meta = { name: "broken", description: "broken", place: "none" }\n${steps.join("\n")}\nreturn 1\n`);

    const full = await paste(paths, `sous workflows show broken --full --json --project ${projectDir}`, PERSON);
    const found = full.check.problems.length + full.check.notes.length;
    assert.ok(JSON.stringify(full.check).length > 8000, `the check alone is over 8,000 characters: ${JSON.stringify(full.check).length}`);

    const printed = await sous(paths, ["workflows", "show", "broken", "--json", "--project", projectDir], { env: PERSON });
    assert.equal(printed.code, 0, printed.out);
    assert.ok(printed.out.length < 8000, `the reply is ${printed.out.length} characters`);
    const outline = json(printed);
    assert.ok(outline.check.problems.length + outline.check.notes.length < found, "the check's lists are cut");
    assert.ok(outline.notes.some((note: string) => note.includes("check") && note.includes("--full")), `a note says the check is cut and names --full: ${JSON.stringify(outline.notes)}`);
  });

  it("the diff marks where each part it shows starts in the file", async () => {
    const { paths, projectDir } = testHome();
    const lines = [`export const meta = { name: "big", description: "big", place: "none" }`, ...Array.from({ length: 298 }, (_, n) => `// line ${n + 2}`), "return 1"];
    writeFileSync(workflowFile(projectDir, "big"), `${lines.join("\n")}\n`);
    assert.equal((await sous(paths, ["workflows", "approve", "big", "--json", "--project", projectDir], { env: PERSON })).code, 0);
    const edited = lines.map((line) => (line === "// line 50" ? "// LINE 50" : line === "// line 250" ? "// LINE 250" : line));
    writeFileSync(workflowFile(projectDir, "big"), `${edited.join("\n")}\n`);

    const diffed = await paste(paths, `sous workflows show big --diff --json --project ${projectDir}`, PERSON);
    const context = 3;
    const starts = ["// LINE 50", "// LINE 250"].map((line) => edited.indexOf(line) + 1 - context);
    assert.deepEqual(diffed.diff.filter((line: string) => line.startsWith("@@")), starts.map((start) => `@@ line ${start} @@`));
    const second = diffed.diff.indexOf(`@@ line ${starts[1]} @@`);
    assert.equal(diffed.diff[second + 1], `  ${edited[starts[1]! - 1]}`, "the line after the mark is the file's line it names");
  });

  it("a text that differs only in its final newline gives an empty diff and a note that says so", async () => {
    const { paths, projectDir } = testHome();
    const text = plain("tail");
    writeFileSync(workflowFile(projectDir, "tail"), text);
    assert.equal((await sous(paths, ["workflows", "approve", "tail", "--json", "--project", projectDir], { env: PERSON })).code, 0);
    writeFileSync(workflowFile(projectDir, "tail"), text.replace(/\n$/, ""));

    const diffed = await paste(paths, `sous workflows show tail --diff --json --project ${projectDir}`, PERSON);
    assert.equal(diffed.approved?.changedSince, true);
    assert.deepEqual(diffed.diff, []);
    assert.ok(diffed.notes.some((note: string) => note.includes("final newline")), JSON.stringify(diffed.notes));
  });

  it("an approved copy whose text is not its hash's shows the file as new", async () => {
    const { paths, projectDir } = testHome();
    const text = plain("kept");
    writeFileSync(workflowFile(projectDir, "kept"), text);
    assert.equal((await sous(paths, ["workflows", "approve", "kept", "--json", "--project", projectDir], { env: PERSON })).code, 0);
    const hash = createHash("sha256").update(text).digest("hex");
    writeFileSync(join(paths.approved, `${hash}.json`), JSON.stringify({ text: "not the approved text\n" }));
    writeFileSync(workflowFile(projectDir, "kept"), text.replace("echo ok", "echo changed"));

    const diffed = await paste(paths, `sous workflows show kept --diff --json --project ${projectDir}`, PERSON);
    assert.ok(diffed.diff.every((line: string) => line.startsWith("+ ")), JSON.stringify(diffed.diff));
    assert.ok(diffed.notes.some((note: string) => note.includes("no longer has")), JSON.stringify(diffed.notes));
  });

  it("an ask is a step of the outline, with its question as its title", async () => {
    const { paths, projectDir } = testHome();
    writeFileSync(workflowFile(projectDir, "ship"), plain("ship", 'await ask("Ship it?", { choices: ["yes", "no"] })\n'));
    const outline = await paste(paths, `sous workflows show ship --json --project ${projectDir}`, PERSON);
    assert.deepEqual(outline.steps.map((step: Record<string, unknown>) => [step.kind, step.title]), [["sh", undefined], ["ask", "Ship it?"]]);
  });

  it("--full with --diff says it changes nothing", async () => {
    const { paths, projectDir } = testHome();
    writeFileSync(workflowFile(projectDir, "greet"), plain("greet"));
    const diffed = await paste(paths, `sous workflows show greet --diff --full --json --project ${projectDir}`, PERSON);
    assert.ok(diffed.notes.some((note: string) => note.includes("--full")), JSON.stringify(diffed.notes));
  });
});

describe("piece 10 review: sous agents", () => {
  it("names an agent file that does not parse in a note, and a word it does not take", async () => {
    const { paths, projectDir } = testHome();
    mkdirSync(join(projectDir, ".codex", "agents"), { recursive: true });
    writeFileSync(join(projectDir, ".codex", "agents", "broken.toml"), "name = \n");
    const listed = await paste(paths, `sous agents extra --json --project ${projectDir}`, PERSON);
    assert.deepEqual(listed.agents, []);
    assert.ok(listed.notes.some((note: string) => note.includes("broken")), `a note names the broken agent: ${JSON.stringify(listed.notes)}`);
    assert.ok(listed.notes.some((note: string) => note.includes("extra")), `a note names the word left out: ${JSON.stringify(listed.notes)}`);
  });
});
