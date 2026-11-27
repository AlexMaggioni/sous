// The loop that runs one step's turns until done. Each turn is one agent call and one journal
// row, in the step's session. "working" gets "Continue the task.", "done" runs the checks, a
// failed check sends its feedback, and "question" waits on a join row. maxTurns fails the step
// with an error the script can catch.

import assert from "node:assert/strict";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { WorkflowError, WorkflowErrorCode } from "../../src/errors.js";
import { createRun } from "../../src/runs/launch.js";
import { runQuestions, answerQuestion } from "../../src/runs/run.js";
import { readState } from "../../src/runs/store.js";
import { runWorker } from "../../src/runs/worker.js";
import { createSteps } from "../../src/steps/steps.js";
import { PERSON, testHome, writeAnswer, type InnerRunner } from "../../src/testing.js";
import { isStepFailedPause, runWorkflow, type JournalEntry, type WorkflowRunOptions } from "../../src/workflow.js";
import { fakePlace, onFakes, wentOn, type FakePlace } from "../helpers/fake-steps.js";
import { journalResume } from "../helpers/journal-resume.js";
import { boom, quiet, setup } from "../runs/fixture.js";

for (const name of ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) delete process.env[name];

const MODEL = "claude/haiku";
const CONTINUE = "Continue the task.";
const meta = "export const meta = { name: 'loop', description: 'a step until done' }";

/** Runs a script on the fakes, and keeps each journal row. */
async function run(place: FakePlace, body: string, extra: Partial<WorkflowRunOptions> = {}) {
  const journal: JournalEntry[] = [];
  const agent = createSteps(onFakes(place));
  try {
    const result = await runWorkflow(`${meta}\n${body}`, { agent, persistLogs: false, cwd: place.cwd, onAgentJournal: (entry) => journal.push(entry), ...extra });
    return { result, journal };
  } finally {
    await agent.dispose();
  }
}

const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const labelOf = (entry: JournalEntry) => (entry.call as { label?: string } | undefined)?.label;
/** The rows of the step's turns. A code step's row has the kind "agent" too, so a check's row is
 *  told apart by its label. */
const agentRows = (journal: JournalEntry[]) => journal.filter((entry) => entry.kind === "agent" && !labelOf(entry)?.endsWith(": check"));

describe("the loop", () => {
  for (const [kind, call] of [
    ["a handle's send()", `const s = session({ label: 'impl', model: '${MODEL}' })\nreturn await s.send('Build it.')`],
    ["agent()", `return await agent('Build it.', { label: 'impl', model: '${MODEL}' })`],
  ] as const) {
    it(`runs working, working, done as three rows in one session on ${kind}, and returns the result`, async () => {
      const place = fakePlace([{ status: ["working", "working", { status: "done", result: "All built." }] }]);
      const { result, journal } = await run(place, call);
      assert.equal(result.result, "All built.");
      const lines = place.lines();
      assert.deepEqual(
        lines.map((line) => line.prompt),
        ["Build it.", CONTINUE, CONTINUE],
      );
      // The step's later turns go on in the first turn's open program.
      assert.deepEqual(
        [lines[0]!.resume, ...lines.slice(1).map((line) => wentOn(lines[0], line))],
        [false, "held", "held"],
      );
      assert.equal(new Set(lines.map((line) => line.sessionId)).size, 1, "one session");
      const rows = agentRows(journal);
      assert.equal(rows.length, 3);
      assert.deepEqual(
        rows.map((row) => (row.result as { status: string }).status),
        ["working", "working", "done"],
      );
    });
  }

  it("sends Continue the task. in the same session when the agent asks whether to go on", async () => {
    const place = fakePlace([{ status: [{ status: "working", message: "Should I continue?" }, { status: "done", result: "Done." }] }]);
    const { result } = await run(place, `const s = session({ label: 'impl', model: '${MODEL}' })\nreturn await s.send('Build it.')`);
    assert.equal(result.result, "Done.");
    const lines = place.lines();
    assert.deepEqual(
      lines.map((line, i) => [line.prompt, i === 0 ? line.resume : wentOn(lines[0], line)]),
      [
        ["Build it.", false],
        [CONTINUE, "held"],
      ],
    );
    assert.equal(lines[1]?.sessionId, lines[0]?.sessionId);
  });
});

describe("checks", () => {
  // Fails the first time it runs in a folder, with "2 tests fail", and passes after.
  const FLAKY = "if [ -f checked ]; then exit 0; else touch checked; echo '2 tests fail'; exit 3; fi";

  it("send a failed command's exit code and output as the next prompt, and end the step when it passes", async () => {
    const place = fakePlace([{ status: [{ status: "done", result: "first" }, { status: "done", result: "second" }] }]);
    const { result, journal } = await run(
      place,
      `const s = session({ label: 'impl', model: '${MODEL}' })\nreturn await s.send('Build it.', { check: ${JSON.stringify(FLAKY)} })`,
    );
    assert.equal(result.result, "second");
    const lines = place.lines();
    assert.equal(lines.length, 2);
    assert.equal(lines[0]?.prompt, "Build it.");
    assert.match(lines[1]!.prompt, /2 tests fail/);
    assert.match(lines[1]!.prompt, /exit code 3/);
    assert.equal(lines[1]?.sessionId, lines[0]?.sessionId);
    assert.deepEqual(
      journal.map(labelOf),
      ["impl", "impl: check", "impl", "impl: check"],
    );
  });

  it("run in the step's folder", async () => {
    const place = fakePlace();
    await run(place, `const s = session({ label: 'impl', model: '${MODEL}' })\nreturn await s.send('Build it.', { check: 'pwd > where.txt' })`);
    assert.equal(realpathSync(readFileSync(`${place.cwd}/where.txt`, "utf8").trim()), realpathSync(place.cwd));
  });

  it("call a function with the result, and send its feedback when it fails", async () => {
    const place = fakePlace([{ status: [{ status: "done", result: "first" }, { status: "done", result: "second" }] }]);
    const { result } = await run(
      place,
      `const seen = []
const s = session({ label: 'impl', model: '${MODEL}' })
const out = await s.send('Build it.', { check: (result) => { seen.push(result); return result === 'second' || { ok: false, feedback: 'Say second.' } } })
return { out, seen }`,
    );
    assert.deepEqual(plain(result.result), { out: "second", seen: ["first", "second"] });
    assert.deepEqual(
      place.lines().map((line) => line.prompt),
      ["Build it.", "Say second."],
    );
  });

  it("in a list run in order until one fails", async () => {
    const place = fakePlace([{ status: [{ status: "done", result: "first" }, { status: "done", result: "second" }] }]);
    const { result, journal } = await run(
      place,
      `const calls = []
const s = session({ label: 'impl', model: '${MODEL}' })
const out = await s.send('Build it.', { check: ['exit 0', (result) => { calls.push(result); return result === 'second' || { ok: false, feedback: 'Say second.' } }, (result) => { calls.push('last ' + result); return true }] })
return { out, calls }`,
    );
    assert.deepEqual(plain(result.result), { out: "second", calls: ["first", "second", "last second"] });
    assert.deepEqual(
      place.lines().map((line) => line.prompt),
      ["Build it.", "Say second."],
    );
    assert.deepEqual(
      journal.map(labelOf),
      ["impl", "impl: check", "impl", "impl: check"],
      "the command ran once per done",
    );
  });
});

describe("maxTurns", () => {
  const SCRIPT = (caught: boolean) => `const s = session({ label: 'impl', model: '${MODEL}' })
${caught ? "try {\n  await s.send('Build it.', { maxTurns: 2 })\n  return 'no limit'\n} catch (error) {\n  return { code: error.code, message: error.message }\n}" : "return await s.send('Build it.', { maxTurns: 2 })"}`;

  it("fails the step with an error the script catches, and the run goes on", async () => {
    const place = fakePlace([{ status: ["working"] }]);
    // runWorkflow resolves only when the script returns. A paused or failed run rejects.
    const { result } = await run(place, SCRIPT(true));
    const caught = plain(result.result) as { code: string; message: string };
    assert.equal(caught.code, WorkflowErrorCode.STEP_LIMIT);
    assert.match(caught.message, /maxTurns/);
    assert.match(caught.message, /"impl"/);
    assert.equal(place.lines().length, 2);
  });

  it("fails the run when the script does not catch it", async () => {
    const place = fakePlace([{ status: ["working"] }]);
    await assert.rejects(run(place, SCRIPT(false)), (error: unknown) => {
      assert.ok(!isStepFailedPause(error as WorkflowError), "the run fails, it does not pause");
      assert.ok(error instanceof WorkflowError, String(error));
      assert.equal(error.code, WorkflowErrorCode.STEP_LIMIT);
      return true;
    });
    assert.equal(place.lines().length, 2);
  });
});

describe("ask false", () => {
  it("drops question from the schema, and hashes apart from a step that may ask", async () => {
    const body = (options: string) => `const s = session({ label: 'impl', model: '${MODEL}' })\nreturn await s.send('Build it.'${options})`;
    // The fakes log where the last fakePlace() points them, so each place is made right before its run.
    const asking = fakePlace();
    const first = await run(asking, body(""));
    const silent = fakePlace();
    const second = await run(silent, body(", { ask: false }"));
    const third = await run(fakePlace(), body(", { ask: true }"));
    const statuses = (place: FakePlace) => (place.lines()[0]?.schema as { properties: { status: { anyOf: Array<{ enum?: string[] }> } } }).properties.status.anyOf[0]?.enum;
    assert.deepEqual(statuses(asking), ["done", "working", "question"]);
    assert.deepEqual(statuses(silent), ["done", "working"]);
    assert.notEqual(agentRows(second.journal)[0]?.hash, agentRows(first.journal)[0]?.hash);
    assert.equal(agentRows(third.journal)[0]?.hash, agentRows(first.journal)[0]?.hash, "ask true is the default");
  });
});

describe("a resume", () => {
  it("replays the turns before the stop and runs the next one live in the same session", async () => {
    const place = fakePlace([{ status: ["working", "working"], times: 2 }, { fail: "The program crashed." }]);
    const body = `const s = session({ label: 'impl', model: '${MODEL}' })\nreturn await s.send('Build it.')`;
    const journal: JournalEntry[] = [];
    await assert.rejects(run(place, body, { onAgentJournal: (entry) => journal.push(entry) }), (error: unknown) => isStepFailedPause(error as WorkflowError));
    assert.equal(agentRows(journal).length, 2, "turns 1 and 2 have rows");
    const before = place.lines();
    const sessionId = before[0]?.sessionId;
    writeFileSync(process.env.FAKE_RULES!, JSON.stringify([{ status: [{ status: "done", result: "Resumed." }] }]));

    const { result } = await run(place, body, journalResume(journal));
    assert.equal(result.result, "Resumed.");
    const after = place.lines().slice(before.length);
    assert.deepEqual(
      after.map((line) => [line.prompt, line.resume, line.sessionId]),
      [[CONTINUE, true, sessionId]],
      "only turn 3 runs live",
    );
  });
});

describe("a question", () => {
  it("waits on one join row that names the step, refuses the inbox, and sends Continue the task. once answered", async () => {
    const workflow = `${meta}\nconst s = session({ label: 'impl', model: '${MODEL}' })\nreturn await s.send('Build the endpoint.')`;
    const { paths, projectDir } = setup({ loop: workflow });
    const seen: Array<{ prompt: string; resumed?: string }> = [];
    const inner: InnerRunner = {
      async run(prompt, request) {
        const resumed = request.continueFromSession?.sessionId;
        seen.push({ prompt, ...(resumed ? { resumed } : {}) });
        if (!resumed) request.onSessionOpen?.({ sessionId: "s1", backendId: "claude", cwd: request.cwd!, reopen: { load: true, resume: true, list: true } });
        return seen.length === 1
          ? { status: "question", result: null, message: "Return 404 or an empty list?" }
          : { status: "done", result: "404 it is.", message: null };
      },
    };
    const record = createRun(paths, { who: PERSON, workflow: "loop", projectDir, inputs: {} });
    const worker = runWorker(record.runId, "start", { paths, inner, pollMs: 20, log: quiet });

    let question: ReturnType<typeof runQuestions>[number] | undefined;
    for (let waited = 0; !question && waited < 15_000; waited += 20) {
      question = runQuestions(paths, record.runId)[0];
      if (!question) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(question, "the step asks");
    // The person reads the agent's message in its session. The question names the step.
    assert.equal(question.prompt, '"impl" needs you in its session.');
    assert.equal(question.answeredBy, "join");
    assert.equal(question.step, "impl");
    assert.throws(
      () => answerQuestion(paths, question!, { via: "answer", text: "404" }, PERSON),
      (error: unknown) => (error as { code?: string }).code === "question_for_people" && /sous join/.test((error as Error).message),
    );
    assert.equal(seen.length, 1, "the step waits");

    writeAnswer(paths, question, "");
    const result = await worker;
    assert.equal(result?.status, "completed");
    assert.equal(result?.result, "404 it is.");
    assert.deepEqual(seen, [{ prompt: "Build the endpoint." }, { prompt: CONTINUE, resumed: "s1" }]);
    const state = readState(paths, record.runId);
    const kinds = (state?.journal ?? []).map((entry) => entry.kind);
    assert.deepEqual(kinds, ["agent", "checkpoint", "agent"]);
  });

  it("replays the answered join row on a resume, and does not wait on it again", async () => {
    const workflow = `${meta}\nconst s = session({ label: 'impl', model: '${MODEL}' })\nreturn await s.send('Build the endpoint.')`;
    const { paths, projectDir } = testHome({ loop: workflow }, { retries: 0 });
    const seen: string[] = [];
    let crash = true;
    const inner: InnerRunner = {
      async run(prompt, request) {
        seen.push(prompt);
        if (!request.continueFromSession) request.onSessionOpen?.({ sessionId: "s1", backendId: "claude", cwd: request.cwd!, reopen: { load: true, resume: true, list: true } });
        if (seen.length === 1) return { status: "question", result: null, message: "Return 404 or an empty list?" };
        if (crash) throw boom();
        return { status: "done", result: "404 it is.", message: null };
      },
    };
    const record = createRun(paths, { who: PERSON, workflow: "loop", projectDir, inputs: {} });
    const first = runWorker(record.runId, "start", { paths, inner, pollMs: 20, log: quiet });
    let question: ReturnType<typeof runQuestions>[number] | undefined;
    for (let waited = 0; !question && waited < 15_000; waited += 20) {
      question = runQuestions(paths, record.runId)[0];
      if (!question) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(question, "the step asks");
    writeAnswer(paths, question, "joined");
    assert.equal((await first)?.status, "paused", "the turn after the answer failed");
    assert.deepEqual(seen, ["Build the endpoint.", CONTINUE]);

    crash = false;
    const resumed = await runWorker(record.runId, "resume", { paths, inner, pollMs: 20, log: quiet });
    assert.equal(resumed?.status, "completed");
    assert.equal(resumed?.result, "404 it is.");
    assert.deepEqual(seen.slice(2), [CONTINUE], "the question's turn and the join row replay, and only the failed turn runs again");
    assert.deepEqual(runQuestions(paths, record.runId), []);
    const kinds = (readState(paths, record.runId)?.journal ?? []).map((entry) => entry.kind);
    assert.deepEqual(kinds, ["agent", "checkpoint", "agent"], "one join row");
  });
});
