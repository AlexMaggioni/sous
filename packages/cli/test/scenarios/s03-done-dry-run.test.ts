// Scenario 3 in a dry run. A step that runs until done gets its turns from the stand-ins. A
// status name in the answers file plays a turn: "working", "working", "done" is three turns. A
// plain answer is "done" with that answer as the result. A check command runs once, the dry run
// notes its exit code, and the step goes on as if it passed. A question gets a stand-in answer, as
// ask() does in a dry run, and the step goes on. No program starts, and no run is left behind.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { listRecords } from "@sous-run/engine";
import { fakeWorld, type FakeWorld } from "../helpers/fake-world.js";

const PROMPT = "Make every test in test/ pass.";

/** A workflow with one step that runs until done, with these options added. */
const script = (options = "") => `export const meta = { name: 'done', description: 'A step that runs until its agent says done' }
const result = await agent(${JSON.stringify(PROMPT)}, { label: 'implementer'${options} })
return { result }`;

interface Dry {
  status: string;
  result?: unknown;
  agents: string[];
  checks?: Array<{ step: string; command: string; code: number }>;
}

/** Runs `sous check done --dry-run` with these answers, as JSON, and gives the dry run. */
async function dryJson(world: FakeWorld, answers?: unknown): Promise<Dry> {
  const args = ["check", "done", "--dry-run", "--json"];
  if (answers !== undefined) {
    world.write("answers.json", JSON.stringify(answers));
    args.push("--answers", join(world.projectDir, "answers.json"));
  }
  const run = await world.sous(...args);
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
  return (JSON.parse(run.stdout) as { dryRun: Dry }).dryRun;
}

describe("a step that runs until done, in a dry run", () => {
  it("plays working, working, done from the answers file as three turns, starts no program, and leaves no run", async (t) => {
    const world = fakeWorld(t);
    world.workflow("done", script());

    const dry = await dryJson(world, { implementer: ["working", "working", "done"] });

    assert.equal(dry.status, "completed");
    assert.deepEqual(dry.agents, ["implementer", "implementer", "implementer"]);
    assert.deepEqual(dry.result, { result: "stand-in answer from implementer" });
    assert.deepEqual(world.log(), []);
    assert.deepEqual(listRecords(world.paths), []);
  });

  it("reads an object with a status as a turn, and a plain answer as done with that answer", async (t) => {
    const world = fakeWorld(t);
    world.workflow("done", script());

    const dry = await dryJson(world, { implementer: [{ status: "working" }, "the parser works"] });

    assert.equal(dry.status, "completed");
    assert.deepEqual(dry.agents, ["implementer", "implementer"]);
    assert.deepEqual(dry.result, { result: "the parser works" });
  });

  it("with no answer, says done at once with a value that fits the step's schema", async (t) => {
    const world = fakeWorld(t);
    world.workflow("done", script(", schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }"));

    const dry = await dryJson(world);

    assert.equal(dry.status, "completed");
    assert.deepEqual(dry.agents, ["implementer"]);
    assert.deepEqual(dry.result, { result: { ok: true } });
  });

  it("runs a failing check command once, notes its exit code, and goes on as if it passed", async (t) => {
    const world = fakeWorld(t);
    const ran = join(world.dir, "check-ran.txt");
    const command = `echo ran >> ${JSON.stringify(ran)}; echo broken; exit 3`;
    world.workflow("done", script(`, check: ${JSON.stringify(command)}`));

    const dry = await dryJson(world);

    assert.equal(dry.status, "completed");
    assert.deepEqual(dry.agents, ["implementer"]);
    assert.deepEqual(dry.checks, [{ step: "implementer", command, code: 3 }]);
    assert.equal(readFileSync(ran, "utf8"), "ran\n");

    const text = await world.sous("check", "done", "--dry-run");
    assert.equal(text.code, 0, `${text.stdout}\n${text.stderr}`);
    assert.match(text.stdout, /check {6}implementer: .*exit code 3.*as if it passed/);
    assert.equal(readFileSync(ran, "utf8"), "ran\nran\n");
    assert.deepEqual(world.log(), []);
  });

  it("gives an agent's question a stand-in answer, as ask() gets in a dry run, and goes on", async (t) => {
    const world = fakeWorld(t);
    world.workflow("done", script());
    world.write("answers.json", JSON.stringify({ implementer: [{ status: "question", message: "Which parser?" }, "done"] }));

    const text = await world.sous("check", "done", "--dry-run", "--answers", join(world.projectDir, "answers.json"));

    assert.equal(text.code, 0, `${text.stdout}\n${text.stderr}`);
    assert.match(text.stdout, /question {3}Which parser\?\n\s+answered {3}"stand-in answer" \(dry run\)/);
    assert.match(text.stdout, /dry run completed, with 2 agent steps answered by stand-ins/);
    assert.deepEqual(world.log(), []);
  });
});
