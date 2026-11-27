// Structured input and output for every step kind but an agent step: a nested workflow's json
// inputs and its result, code steps, waitUntil, ask and breakpoint.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { CheckpointCallContext, CheckpointOptions } from "../src/checkpoint-call.js";
import { createRun } from "../src/runs/launch.js";
import { hint, questionView, type Question } from "../src/runs/inbox.js";
import { answerQuestion, runQuestions } from "../src/runs/run.js";
import { runWorker } from "../src/runs/worker.js";
import { PERSON } from "../src/testing.js";
import type { JournalEntry } from "../src/workflow-result.js";
import { isStepFailedPause, runWorkflow } from "../src/workflow.js";
import { workflowExtras } from "../src/workflows/meta.js";
import { journalResume } from "./helpers/journal-resume.js";
import { heldRunner, setup, until } from "./runs/fixture.js";

const noAgent = {
  async run(): Promise<never> {
    throw new Error("no agent step runs in these tests");
  },
};

/** A schema for { n: number }. */
const N = { type: "object", properties: { n: { type: "number" } }, required: ["n"] };
const N_TEXT = JSON.stringify(N);

function folder(): string {
  return mkdtempSync(join(tmpdir(), "structured-io-"));
}

/** Run a script with no agent, in its own folder, and keep its journal. */
async function run<T = unknown>(script: string, extra: Record<string, unknown> = {}) {
  const journal: JournalEntry[] = [];
  const result = await runWorkflow<T>(script, {
    agent: noAgent,
    persistLogs: false,
    cwd: (extra.cwd as string | undefined) ?? folder(),
    agentRetries: 0,
    onAgentJournal: (entry: JournalEntry) => journal.push(entry),
    ...extra,
  });
  return { result: JSON.parse(JSON.stringify(result.result ?? null)) as T, journal };
}

/** A run whose one step fails pauses it. The message names the reason. */
async function stepFails(script: string, reason: RegExp, extra: Record<string, unknown> = {}): Promise<void> {
  await assert.rejects(run(script, extra), (error: Error) => {
    assert.ok(isStepFailedPause(error as never), `a failed step pauses the run, got ${error.message}`);
    assert.match(error.message, reason);
    return true;
  });
}

describe("a nested workflow's json input with a schema", () => {
  const child = `export const meta = { name: 'child', description: 'c', inputs: {
  ticket: { type: 'json', schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } } } }
await sh('true', { label: 'first' })
return args.ticket.title`;

  it("fails the call before the child's first step when an arg does not fit, with the field named, and runs one that fits", async () => {
    const script = `export const meta = { name: 'parent', description: 'p' }
let bad
try { await workflow('child', { ticket: { name: 'no title' } }) } catch (error) { bad = error.message }
const good = await workflow('child', { ticket: { title: 'Add a flag' } })
return { bad, good }`;
    const { result, journal } = await run<{ bad: string; good: string }>(script, {
      runId: "root",
      loadSavedWorkflow: (name: string) => (name === "child" ? child : undefined),
    });
    assert.match(result.bad, /^workflow\("child"\): --ticket does not fit its schema: /);
    assert.match(result.bad, /title/);
    assert.equal(result.good, "Add a flag");
    const scopes = journal.map((entry) => entry.scope);
    assert.ok(!scopes.includes("root-nested1"), "the child that got a bad arg ran no step");
    assert.ok(scopes.includes("root-nested2"), "the child that got a good arg ran its step");
  });

  it("is a problem of the meta when the schema is no JSON schema object", () => {
    const extras = workflowExtras({ name: "w", description: "d", inputs: { ticket: { type: "json", schema: "an object" } } });
    assert.deepEqual(extras.metaProblems, ["meta.inputs.ticket.schema must be a JSON schema object"]);
  });
});

describe("meta.schema", () => {
  const child = `export const meta = { name: 'child', description: 'c',
  schema: { type: 'object', properties: { branch: { type: 'string' } }, required: ['branch'] } }
return args`;

  it("fails the workflow() call when the child's result does not fit, and returns one that fits", async () => {
    const script = `export const meta = { name: 'parent', description: 'p' }
let bad
try { await workflow('child', { summary: 'no branch' }) } catch (error) { bad = error.message }
const good = await workflow('child', { branch: 'sous/a' })
return { bad, good }`;
    const { result } = await run<{ bad: string; good: unknown }>(script, {
      loadSavedWorkflow: (name: string) => (name === "child" ? child : undefined),
    });
    assert.match(result.bad, /^workflow\("child"\): its result does not fit meta.schema: /);
    assert.match(result.bad, /branch/);
    assert.deepEqual(result.good, { branch: "sous/a" });
  });

  it("fails a top-level run whose result does not fit", async () => {
    const script = `export const meta = { name: 'top', description: 't', schema: ${N_TEXT} }
return { n: 'two' }`;
    await assert.rejects(run(script), /the result does not fit meta.schema: .*n/);
    const fits = await run(`export const meta = { name: 'top', description: 't', schema: ${N_TEXT} }\nreturn { n: 2 }`);
    assert.deepEqual(fits.result, { n: 2 });
  });

  it("is a problem of the meta when it is no JSON schema object", () => {
    assert.deepEqual(workflowExtras({ name: "w", description: "d", schema: ["branch"] } as never).metaProblems, ["meta.schema must be a JSON schema object"]);
  });
});

describe("sh with input and schema", () => {
  it("gives the input on stdin as JSON, and with a schema reads stdout as JSON into result", async () => {
    const script = `export const meta = { name: 'sh', description: 's' }
const echoed = await sh('cat', { input: { a: [1, 'two'] } })
const read = await sh('cat', { input: { n: 3 }, schema: ${N_TEXT} })
return { echoed, read }`;
    const { result } = await run<{ echoed: { stdout: string }; read: Record<string, unknown> }>(script);
    assert.equal(result.echoed.stdout, '{"a":[1,"two"]}');
    assert.deepEqual(result.read, { code: 0, stdout: '{"n":3}', stderr: "", result: { n: 3 } });
  });

  it("fails the step when stdout does not fit the schema, or is not JSON", async () => {
    await stepFails(`export const meta = { name: 'sh', description: 's' }\nreturn await sh(\`echo '{"n": "x"}'\`, { schema: ${N_TEXT} })`, /does not fit its schema: .*n/);
    await stepFails(`export const meta = { name: 'sh', description: 's' }\nreturn await sh('echo plain words', { schema: ${N_TEXT} })`, /stdout is not JSON/);
  });
});

describe("js, py and run with input and schema", () => {
  it("js: the input is a variable, and the schema checks the value it returns", async () => {
    const { result } = await run<{ result: unknown }>(`export const meta = { name: 'js', description: 'j' }
return await js('return { n: input.n * 2 }', { n: 2 }, { schema: ${N_TEXT} })`);
    assert.deepEqual(result.result, { n: 4 });
    await stepFails(`export const meta = { name: 'js', description: 'j' }\nreturn await js('return { n: input }', 'x', { schema: ${N_TEXT} })`, /does not fit its schema/);
  });

  it("py: the input is a variable, and the schema checks the value it returns", async () => {
    const { result } = await run<{ result: unknown }>(`export const meta = { name: 'py', description: 'p' }
return await py('return {"n": input["n"] + 1}', { n: 1 }, { schema: ${N_TEXT} })`);
    assert.deepEqual(result.result, { n: 2 });
    await stepFails(`export const meta = { name: 'py', description: 'p' }\nreturn await py('return ["n"]', null, { schema: ${N_TEXT} })`, /does not fit its schema/);
  });

  it("run: the input goes to stdin as JSON, and the schema reads stdout as JSON when the file writes no result", async () => {
    const cwd = folder();
    mkdirSync(join(cwd, "scripts"));
    writeFileSync(join(cwd, "scripts", "double.cjs"), "const d = JSON.parse(require('fs').readFileSync(0, 'utf8'))\nconsole.log(JSON.stringify({ n: d.n * 2 }))\n");
    const { result } = await run<{ result: unknown }>(`export const meta = { name: 'run', description: 'r' }
return await run('scripts/double.cjs', { input: { n: 3 }, schema: ${N_TEXT} })`, { cwd });
    assert.deepEqual(result.result, { n: 6 });
    await stepFails(`export const meta = { name: 'run', description: 'r' }\nreturn await run('scripts/double.cjs', { input: { n: 'x' }, schema: ${N_TEXT} })`, /does not fit its schema/, { cwd });
  });
});

describe("waitUntil with input and schema", () => {
  it("passes the input on stdin, and checks the value the command prints when it exits 0", async () => {
    const { result } = await run<{ result: unknown; checks: number }>(`export const meta = { name: 'wait', description: 'w' }
return await waitUntil('cat', { every: 1, input: { n: 5 }, schema: ${N_TEXT} })`);
    assert.deepEqual(result.result, { n: 5 });
    await stepFails(`export const meta = { name: 'wait', description: 'w' }\nreturn await waitUntil("echo '[]'", { every: 1, schema: ${N_TEXT} })`, /does not fit its schema/);
  });
});

describe("ask with input and schema", () => {
  it("shows the input with the question, refuses an answer that does not fit and asks again, then returns the value", async () => {
    const asked: Array<{ prompt: string; options: CheckpointOptions; context?: CheckpointCallContext }> = [];
    const answers = ['{"n": "x"}', "not json", '{"n": 2}'];
    const { result } = await run(`export const meta = { name: 'ask', description: 'a' }
return await ask('How many?', { input: { tickets: ['a', 'b'] }, schema: ${N_TEXT} })`, {
      confirm: async (prompt: string, options: CheckpointOptions, context?: CheckpointCallContext) => {
        asked.push({ prompt, options, context });
        return answers[asked.length - 1];
      },
    });
    assert.deepEqual(result, { n: 2 });
    assert.equal(asked.length, 3, "each answer that does not fit is asked again");
    assert.match(asked[0]!.prompt, /^How many\?\n\nInput:\n[\s\S]*"tickets"/);
    assert.match(asked[1]!.prompt, /The last answer was refused: .*n/);
    assert.match(asked[2]!.prompt, /The last answer was refused: .*not JSON/);
    assert.equal(asked[0]!.context?.hash, asked[2]!.context?.hash, "the question asked again is the same question");
  });
});

describe("breakpoint with input and schema", () => {
  it("shows the input, refuses an approved value that does not fit, and returns one that fits", async () => {
    const asked: Array<{ prompt: string; context?: CheckpointCallContext }> = [];
    const answers = [{ decision: "approve", value: { n: "x" } }, { decision: "approve", value: { n: 1 } }];
    const { result } = await run(`export const meta = { name: 'bp', description: 'b' }
return await breakpoint('Check the count', { input: { plan: 'A' }, schema: ${N_TEXT} })`, {
      confirm: async (prompt: string, _options: CheckpointOptions, context?: CheckpointCallContext) => {
        asked.push({ prompt, context });
        return answers[asked.length - 1];
      },
    });
    assert.deepEqual(result, { n: 1 });
    assert.equal(asked.length, 2);
    assert.match(asked[0]!.prompt, /Input:\n[\s\S]*"plan": "A"/);
    assert.match(asked[0]!.context?.purpose?.show ?? "", /"plan": "A"/, "the page shows the input with the breakpoint");
    assert.match(asked[1]!.prompt, /The last answer was refused/);
  });

  it("with a step, approve returns the step's result, which the schema does not check", async () => {
    const { result } = await run(`export const meta = { name: 'bp', description: 'b' }
return await breakpoint('Check', () => 'the work', { input: { plan: 'A' }, schema: ${N_TEXT} })`, {
      confirm: async () => "approve",
    });
    assert.equal(result, "the work");
  });
});

describe("the options of structured input and output", () => {
  it("are refused when input is not strict JSON or schema is no JSON schema object", async () => {
    const script = `export const meta = { name: 'bad', description: 'b' }
const tries = [
  () => sh('true', { input: () => 1 }),
  () => sh('true', { schema: 'an object' }),
  () => js('return 1', 1, { schema: [] }),
  () => py('return 1', 1, { input: 2 }),
  () => run('x.sh', { schema: 5 }),
  () => run('x.sh', { input: { at: undefined } }),
  () => waitUntil('true', { input: { at: undefined } }),
  () => ask('Why?', { schema: null }),
  () => ask('Why?', { input: NaN }),
  () => breakpoint('Look', { schema: 'x' }),
]
const out = []
for (const step of tries) { try { await step(); out.push('ran') } catch (error) { out.push(error.message) } }
return out`;
    const { result } = await run<string[]>(script);
    assert.deepEqual(result, [
      "sh(): input must be strict JSON, and it is not at $",
      "sh(): schema must be a JSON schema object",
      "js(): schema must be a JSON schema object",
      "py() takes its input as its second argument, not as an option",
      "run(): schema must be a JSON schema object",
      "run(): input must be strict JSON, and it is not at $.at",
      "waitUntil(): input must be strict JSON, and it is not at $.at",
      "ask(): schema must be a JSON schema object",
      "ask(): input must be strict JSON, and it is not at $",
      "breakpoint(): schema must be a JSON schema object",
    ]);
  });
});

describe("the call hash of input and schema", () => {
  it("changes with the input or the schema of a code step, and a resume with the same ones replays", async () => {
    const cwd = folder();
    const step = (options: string) => `export const meta = { name: 'h', description: 'h' }
return await sh(\`echo ran >> count; echo '{"n": 1}'\`, ${options})`;
    const a = await run(step(`{ input: { v: 1 } }`), { cwd });
    const b = await run(step(`{ input: { v: 2 } }`), { cwd });
    const c = await run(step(`{ input: { v: 1 }, schema: ${N_TEXT} }`), { cwd });
    const hashes = [a, b, c].map((one) => one.journal[0]!.hash);
    assert.equal(new Set(hashes).size, 3, "input and schema each change the hash");
    const ran = () => readFileSync(join(cwd, "count"), "utf8").trim().split("\n").length;
    assert.equal(ran(), 3);
    const again = await run(step(`{ input: { v: 1 }, schema: ${N_TEXT} }`), { cwd, ...journalResume(c.journal) });
    assert.equal(ran(), 3, "the resume replays the step");
    assert.deepEqual(again.result, c.result);
  });

  it("changes with the schema of a question, and a resume with the same one replays its answer", async () => {
    const ask = (schema: string) => `export const meta = { name: 'q', description: 'q' }
return await ask('How many?', { input: { a: 1 }, schema: ${schema} })`;
    let asked = 0;
    const confirm = async () => {
      asked++;
      return '{"n": 4}';
    };
    const other = JSON.stringify({ type: "object" });
    const first = await run(ask(N_TEXT), { confirm });
    const second = await run(ask(other), { confirm });
    const third = await run(`export const meta = { name: 'q', description: 'q' }
return await ask('How many?', { input: { a: 2 }, schema: ${N_TEXT} })`, { confirm });
    assert.equal(new Set([first, second, third].map((one) => one.journal[0]!.hash)).size, 3);
    assert.equal(asked, 3);
    const again = await run(ask(N_TEXT), { confirm, ...journalResume(first.journal) });
    assert.equal(asked, 3, "the resume replays the answer");
    assert.deepEqual(again.result, { n: 4 });
  });
});

describe("the inbox", () => {
  const counted = `export const meta = { name: 'counted', description: 'asks for a count' }
return await ask('How many?', { input: { tickets: 2 }, schema: ${N_TEXT} })`;

  it("refuses an answer that does not fit, keeps the question open, and takes one that fits", async () => {
    const { paths, projectDir } = setup({ counted });
    const record = createRun(paths, { who: PERSON, workflow: "counted", projectDir, inputs: {} });
    const worker = runWorker(record.runId, "start", { paths, inner: heldRunner(() => "unused").runner, pollMs: 20, log: () => {} });
    await until(() => runQuestions(paths, record.runId).length === 1);
    const [question] = runQuestions(paths, record.runId);
    assert.match(question!.prompt, /"tickets": 2/, "the inbox row shows the input");

    const notJson = answerQuestion(paths, question!, { via: "answer", text: "two" }, PERSON);
    assert.deepEqual(notJson, { usage: "the answer is not JSON. Answer with JSON that fits the question's schema." });
    const misfit = answerQuestion(paths, question!, { via: "answer", text: '{"n": "two"}' }, PERSON);
    assert.ok("usage" in misfit);
    assert.match(misfit.usage, /^the answer does not fit the question's schema: .*n/);
    assert.equal(runQuestions(paths, record.runId).length, 1, "the question stays open");

    const fits = answerQuestion(paths, question!, { via: "answer", text: '{"n": 2}' }, PERSON);
    assert.ok("answered" in fits);
    const result = await worker;
    assert.equal(result?.status, "completed");
    assert.deepEqual(result?.result, { n: 2 });
  });

  it("tells how to answer a question with a schema: with JSON", () => {
    const question: Question = { id: "r1--2", runId: "r1", scope: "r1", callIndex: 2, hash: "h2", workflow: "w", prompt: "?", kind: "input", breakpoint: false, askedAt: "2026-11-23T10:00:00.000Z", schema: { type: "object" } };
    assert.equal(hint(question), "sous answer r1--2 '<json>'");
    assert.equal(hint(question, "log"), "sous answer r1--2 '<json>'");
    assert.equal(hint(question, "prompt"), "JSON that fits the question's schema");
    assert.equal(hint({ ...question, breakpoint: true }, "prompt"), "approve, stop, or a note to send back");
    assert.deepEqual(questionView(question).schema, { type: "object" }, "the inbox's view gives the schema");
  });

  it("asks again when an answer file holds an answer that does not fit, and says why", async () => {
    const { paths, projectDir } = setup({ counted });
    const record = createRun(paths, { who: PERSON, workflow: "counted", projectDir, inputs: {} });
    const lines: string[] = [];
    const worker = runWorker(record.runId, "start", { paths, inner: heldRunner(() => "unused").runner, pollMs: 20, log: (line) => lines.push(line) });
    await until(() => runQuestions(paths, record.runId).length === 1);
    const [question] = runQuestions(paths, record.runId);
    writeFileSync(join(paths.inbox, `${question!.id}.answer.json`), JSON.stringify({ hash: question!.hash, value: { n: "two" }, answeredAt: new Date().toISOString() }));
    await until(() => runQuestions(paths, record.runId).some((open) => /refused/.test(open.prompt)));
    const [again] = runQuestions(paths, record.runId);
    assert.ok(again, "the question is asked again");
    assert.match(again.prompt, /The last answer was refused: .*n/);
    assert.ok(lines.some((line) => / refused +/.test(line)), "the run's log says the answer was refused");
    writeFileSync(join(paths.inbox, `${again.id}.answer.json`), JSON.stringify({ hash: again.hash, value: { n: 2 }, answeredAt: new Date().toISOString() }));
    const result = await worker;
    assert.deepEqual(result?.result, { n: 2 });
  });
});
