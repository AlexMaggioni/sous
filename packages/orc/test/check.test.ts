import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { testHome } from "@orchestrator/engine/testing";
import { orc } from "./orc.js";
import "./harness-home.js";

// orc check and orc workflows with --json, and orc check --dry-run with an answers file. The
// project is no git repo, so a dry run works in a scratch folder.

const REVIEW = `export const meta = { name: 'review', description: 'loops with a reviewer', inputs: { rounds: { type: 'number', default: 3 } } }
const verdictSchema = { type: 'object', properties: { approved: { type: 'boolean' }, review: { type: 'string' } }, required: ['approved', 'review'] }
let round = 0
let verdict
while (round < args.rounds) {
  round++
  verdict = await agent('Review', { label: 'reviewer ' + round, schema: verdictSchema })
  if (verdict.approved) break
}
const text = await agent('Write', { label: 'writer' })
return { approved: verdict.approved, rounds: round, text }`;

const BAD_CRON = `export const meta = { name: 'badCron', description: 'b', schedule: '0 25 * * *' }\nreturn 1`;
const BROKEN = `export const meta = { name: 'broken', description: 'reads a field the schema lacks' }
const verdict = await agent('Review', { label: 'reviewer', schema: { type: 'object', properties: { approved: { type: 'boolean' } }, required: ['approved'] } })
return verdict.details.length`;

/** What `orc check --json` prints, parsed. */
const json = (out: string) => JSON.parse(out) as Record<string, unknown>;

describe("orc check --json", () => {
  const { paths, projectDir } = testHome({ review: REVIEW, badCron: BAD_CRON });
  const check = (...argv: string[]) => orc(paths, ["check", ...argv, "--project", projectDir]);

  it("prints the result as JSON, and exits 0 when it finds no problem", async () => {
    const run = await check("review", "--json");
    assert.equal(run.code, 0);
    const result = json(run.out);
    assert.equal(result.workflow, "review");
    assert.equal(result.file, join(projectDir, ".orchestrator", "workflows", "review.js"));
    assert.equal(result.description, "loops with a reviewer");
    assert.deepEqual(result.problems, []);
    assert.deepEqual(Object.keys(result).sort(), ["description", "file", "inputs", "notes", "problems", "workflow"], "no dry run unless asked");
  });

  it("prints the problems as JSON, and exits 1", async () => {
    const run = await check("badCron", "--json");
    assert.equal(run.code, 1);
    assert.match((json(run.out).problems as string[]).join("\n"), /meta.schedule: bad hour in cron: "25"/);
  });

  it("with a problem, prints the problems and does not start the dry run", async () => {
    const run = await check("badCron", "--json", "--dry-run");
    assert.equal(run.code, 1);
    const result = json(run.out);
    assert.equal(result.problems instanceof Array && result.problems.length, 1);
    assert.equal("dryRun" in result, false);
  });

  it("checks the inputs it is given, and prints what is wrong with them", async () => {
    const run = await check("review", "--nope", "1", "--json");
    assert.equal(run.code, 1);
    assert.deepEqual(json(run.out).problems, ["unknown input --nope. This workflow takes: --rounds"]);
  });
});

describe("orc check --dry-run", () => {
  const { paths, projectDir } = testHome({ review: REVIEW, broken: BROKEN });
  const check = (...argv: string[]) => orc(paths, ["check", ...argv, "--project", projectDir]);
  /** Write an answers file and return its path. */
  const answersFile = (name: string, content: unknown) => {
    const file = join(projectDir, name);
    writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
    return file;
  };

  it("takes its stand-in answers from an answers file, by step label, in turn", async () => {
    const answers = answersFile("answers.json", { "reviewer *": [{ approved: false, review: "Add a test" }, { approved: true, review: "Good" }], writer: "the text" });
    const run = await check("review", "--dry-run", "--answers", answers);
    assert.equal(run.code, 0, run.out);
    assert.match(run.out, /dry run completed, with 3 agent steps answered by stand-ins/);
    assert.deepEqual(JSON.parse(run.out.slice(run.out.indexOf("{"))), { approved: true, rounds: 2, text: "the text" });
    assert.match(run.out, /start {6}reviewer 2/);
  });

  it("without an answers file, the stand-ins approve at once", async () => {
    const run = await check("review", "--dry-run");
    assert.equal(run.code, 0, run.out);
    assert.deepEqual(JSON.parse(run.out.slice(run.out.indexOf("{"))), { approved: true, rounds: 1, text: "stand-in answer from writer" });
  });

  it("refuses an answers file that holds no object, before it runs anything", async () => {
    for (const content of ["[1, 2]", '"text"', "null"]) {
      const run = await check("review", "--dry-run", "--answers", answersFile("list.json", content));
      assert.equal(run.code, 1, content);
      assert.match(run.out, /list\.json must hold an object from step label to answer/);
      assert.doesNotMatch(run.out, /dry run with stand-in agents/);
    }
  });

  it("prints the result and the dry run as JSON with --json", async () => {
    const answers = answersFile("answers.json", { "reviewer *": { approved: true, review: "fine" }, writer: "the text" });
    const run = await check("review", "--dry-run", "--answers", answers, "--json");
    assert.equal(run.code, 0, run.out);
    const result = json(run.out);
    assert.equal(result.workflow, "review");
    assert.deepEqual(result.problems, []);
    const dry = result.dryRun as { runId: string; status: string; result: unknown; agents: string[] };
    assert.equal(dry.status, "completed");
    assert.deepEqual(dry.result, { approved: true, rounds: 1, text: "the text" });
    assert.deepEqual(dry.agents, ["reviewer 1", "writer"]);
    assert.match(dry.runId, /^[a-z0-9-]+$/);
  });

  it("exits 1 and says why when the dry run does not complete, as text and as JSON", async () => {
    const text = await check("broken", "--dry-run");
    assert.equal(text.code, 1);
    assert.match(text.out, /the dry run did not complete: failed \(.*Cannot read properties of undefined \(reading 'length'\)/);

    const asJson = await check("broken", "--dry-run", "--json");
    assert.equal(asJson.code, 1);
    const dry = json(asJson.out).dryRun as { status: string; reason: string };
    assert.equal(dry.status, "failed");
    assert.match(dry.reason, /Cannot read properties of undefined \(reading 'length'\)/);
  });
});

describe("orc workflows --json", () => {
  it("lists each workflow with its file, description and inputs, and the error of one that does not parse", async () => {
    const { paths, projectDir } = testHome({
      review: REVIEW,
      plain: `export const meta = { name: 'plain', description: 'no inputs' }\nreturn 1`,
      broken: "export const meta = {",
    });
    const run = await orc(paths, ["workflows", "--json", "--project", projectDir]);
    assert.equal(run.code, 0);
    const entries = JSON.parse(run.out) as Array<Record<string, unknown>>;
    const byName = Object.fromEntries(entries.map((entry) => [entry.name, entry]));
    assert.deepEqual(Object.keys(byName).sort(), ["broken", "plain", "review"]);
    const dir = join(projectDir, ".orchestrator", "workflows");
    assert.equal(byName.review!.file, join(dir, "review.js"));
    assert.equal(byName.review!.description, "loops with a reviewer");
    assert.deepEqual(byName.review!.inputs, { rounds: { type: "number", default: 3 } });
    assert.equal(byName.plain!.description, "no inputs");
    assert.equal(byName.plain!.error, undefined);
    assert.equal(byName.broken!.file, join(dir, "broken.js"));
    assert.equal(typeof byName.broken!.error, "string");
    assert.equal(byName.broken!.description, undefined);
  });

  it("prints an empty list as JSON when no workflow is saved", async () => {
    const { paths, projectDir } = testHome({});
    const run = await orc(paths, ["workflows", "--json", "--project", projectDir]);
    assert.equal(run.code, 0);
    assert.deepEqual(JSON.parse(run.out), []);
  });
});
