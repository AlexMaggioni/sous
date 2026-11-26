import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { HomePaths } from "../../src/runs/home.js";
import { ask, breakpointValue, decisionOf, hint, questionView, readQuestion, reply, standIn, type Question } from "../../src/runs/inbox.js";
import { createRun } from "../../src/runs/launch.js";
import { updateRecord } from "../../src/runs/records.js";
import { runQuestions } from "../../src/runs/run.js";
import { runWorker } from "../../src/runs/worker.js";
import { dryRun } from "../../src/workflows/dry-run.js";
import { heldRunner, setup, until } from "./fixture.js";
import { PERSON } from "../../src/testing.js";

describe("a breakpoint's decision", () => {
  it("reads every answer a breakpoint can get", () => {
    const cases: Array<[unknown, unknown]> = [
      ["approve", { decision: "approve" }],
      [" Approve ", { decision: "approve" }],
      ["yes", { decision: "approve" }],
      ["", { decision: "approve" }],
      // Only a typed "ok" approves. An answer of "ok" is a note.
      ["ok", { decision: "send back", note: "ok" }],
      ["stop", { decision: "stop" }],
      [" STOP ", { decision: "stop" }],
      ["send back: shorter", { decision: "send back", note: "shorter" }],
      ["Send-back shorter", { decision: "send back", note: "shorter" }],
      ["send back", { decision: "send back" }],
      ["shorter please", { decision: "send back", note: "shorter please" }],
      [true, { decision: "approve" }],
      [false, { decision: "stop" }],
      [{ decision: "approve" }, { decision: "approve" }],
      [{ decision: "Approve", note: " fine " }, { decision: "approve", note: "fine" }],
      [{ decision: "stop", note: "wrong plan" }, { decision: "stop", note: "wrong plan" }],
      [{ decision: "send back", note: " shorter " }, { decision: "send back", note: "shorter" }],
      [{ decision: "send-back", note: "" }, { decision: "send back" }],
      [{ decision: "later" }, { decision: "approve" }],
      [42, { decision: "approve" }],
      [null, { decision: "approve" }],
      [undefined, { decision: "approve" }],
    ];
    for (const [answer, decision] of cases) assert.deepEqual(decisionOf(answer), decision, JSON.stringify(answer));
  });

  it("reads back each typed reply as the decision it names", () => {
    const cases: Array<[string, unknown]> = [
      ["", { decision: "approve" }],
      ["OK", { decision: "approve" }],
      ["yes", { decision: "approve" }],
      [" Stop ", { decision: "stop" }],
      ["send back: shorter", { decision: "send back", note: "shorter" }],
      ["shorter", { decision: "send back", note: "shorter" }],
      ["send-back", { decision: "send back" }],
    ];
    for (const [typed, decision] of cases) assert.deepEqual(decisionOf(breakpointValue(typed)), decision, typed);
  });
});

// The answer files below are raw writes, the way today's sous writes them.

function answerFile(paths: HomePaths, id: string): string {
  return join(paths.inbox, `${id}.answer.json`);
}

function writeAnswer(paths: HomePaths, id: string, hash: string, value: unknown): void {
  writeFileSync(answerFile(paths, id), `${JSON.stringify({ hash, value, answeredAt: new Date().toISOString() }, null, 2)}\n`);
}

/** The inbox's files, without the run id. */
function inbox(paths: HomePaths, runId: string): string[] {
  return readdirSync(paths.inbox).map((name) => name.split(runId).join("<id>")).sort();
}

async function asked(paths: HomePaths, runId: string, count: number): Promise<Question[]> {
  await until(() => runQuestions(paths, runId).length === count);
  const open = runQuestions(paths, runId);
  assert.equal(open.length, count, "the run asks");
  return open;
}

/** The log lines about questions, without the time. */
function questionLines(lines: string[], runId: string): string[] {
  return lines.map((line) => line.slice(9).split(runId).join("<id>")).filter((line) => /^(question|answered) /.test(line));
}

const pick = `export const meta = { name: 'pick', description: 'asks three ways' }
const color = await ask('Pick a color', { choices: ['red', 'blue'] })
const ship = await checkpoint('Ship it?')
const plan = await breakpoint('Check the plan', { show: 'the plan' })
return { color, ship, plan }`;

describe("ask", () => {
  const question: Question = { id: "r1--3", runId: "r1", scope: "r1", callIndex: 3, hash: "h3", workflow: "w", prompt: "Your name?", kind: "input", breakpoint: false, askedAt: "2026-11-23T10:00:00.000Z" };

  it("writes the question, waits for the answer with its hash, and removes both files", async () => {
    const { paths } = setup({});
    const asked: string[] = [];
    const waits = new AbortController();
    const answer = ask(paths, question, { signal: waits.signal, pollMs: 10, asked: () => asked.push(...inbox(paths, "r1")) });
    assert.deepEqual(asked, ["<id>--3.json"], "asked() runs once the question is written");
    assert.deepEqual(JSON.parse(readFileSync(join(paths.inbox, "r1--3.json"), "utf8")), question);
    writeAnswer(paths, "r1--3", "h2", "Bob");
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(inbox(paths, "r1"), ["<id>--3.answer.json", "<id>--3.json"], "an answer to another hash waits");
    writeAnswer(paths, "r1--3", "h3", "Ann");
    assert.equal(await answer, "Ann");
    assert.deepEqual(inbox(paths, "r1"), []);
  });

  it("takes an answer given before the question at once, and writes no question", async () => {
    const { paths } = setup({});
    writeAnswer(paths, "r1--3", "h3", { decision: "send back", note: "" });
    let asked = 0;
    const value = await ask(paths, question, { signal: new AbortController().signal, pollMs: 10, asked: () => asked++ });
    assert.deepEqual(value, { decision: "send back", note: "" });
    assert.equal(asked, 0);
    assert.deepEqual(inbox(paths, "r1"), []);
  });

  it("stops waiting on abort and leaves the question, and an ask after the abort writes nothing", async () => {
    const { paths } = setup({});
    const waits = new AbortController();
    const answer = ask(paths, question, { signal: waits.signal, pollMs: 10 });
    waits.abort();
    await assert.rejects(answer, /^Error: stopped waiting$/);
    assert.deepEqual(inbox(paths, "r1"), ["<id>--3.json"], "the paused run still asks");
    writeAnswer(paths, "r1--3", "h3", "Ann");
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(existsSync(answerFile(paths, "r1--3")), true, "the stopped wait takes nothing");

    const { paths: other } = setup({});
    await assert.rejects(ask(other, question, { signal: waits.signal, pollMs: 10 }), /stopped waiting/);
    assert.deepEqual(inbox(other, "r1"), []);
  });

  it("gives a dry run's stand-in answers", () => {
    assert.equal(standIn({ kind: "input", breakpoint: true }), "approve");
    assert.equal(standIn({ kind: "select", choices: ["red", "blue"], breakpoint: false }), "red");
    assert.equal(standIn({ kind: "select", breakpoint: false }), "");
    assert.equal(standIn({ kind: "input", breakpoint: false }), "stand-in answer");
    assert.equal(standIn({ kind: "confirm", breakpoint: false }), true);
  });
});

describe("reply", () => {
  const base: Question = { id: "r1--2", runId: "r1", scope: "r1", callIndex: 2, hash: "h2", workflow: "w", prompt: "?", kind: "input", breakpoint: false, askedAt: "2026-11-23T10:00:00.000Z" };
  const name: Question = { ...base, kind: "input" };
  const color: Question = { ...base, kind: "select", choices: ["red", "blue"] };
  const ship: Question = { ...base, kind: "confirm" };
  const plan: Question = { ...base, kind: "confirm", breakpoint: true };

  it("at the prompt, says the question is gone when it was answered elsewhere", () => {
    const { paths } = setup({});
    assert.deepEqual(reply(paths, name, { via: "prompt", text: "Ann" }), { gone: true });
    assert.deepEqual(inbox(paths, "r1"), []);
  });

  it("tells how to answer, in sous, in the run's log and at the prompt", () => {
    assert.equal(hint(name), 'sous answer r1--2 "..."');
    assert.equal(hint(color), "sous answer r1--2 <one of: red, blue>");
    assert.equal(hint(ship), "sous answer r1--2 yes|no");
    assert.equal(hint(plan), 'sous approve r1--2  |  sous send-back r1--2 "note"  |  sous stop r1');
    assert.equal(hint(ship, "log"), 'sous answer r1--2 "..."');
    assert.equal(hint(plan, "log"), hint(plan));
    assert.equal(hint(name, "prompt"), "your answer");
    assert.equal(hint(color, "prompt"), "red / blue");
    assert.equal(hint(ship, "prompt"), "yes or no");
    assert.equal(hint(plan, "prompt"), "approve, stop, or a note to send back");
  });
});

describe("a run that waits for an answer", () => {
  it("takes the answer whose hash matches, removes both files, and logs the question and the answer", async () => {
    const { paths, projectDir } = setup({ pick });
    const record = createRun(paths, { who: PERSON, workflow: "pick", projectDir, inputs: {} });
    const lines: string[] = [];
    const worker = runWorker(record.runId, "start", { paths, inner: heldRunner(() => "unused").runner, pollMs: 20, log: (line) => lines.push(line) });

    const [color] = await asked(paths, record.runId, 1);
    assert.equal(color!.kind, "select");
    assert.deepEqual(color!.choices, ["red", "blue"]);
    assert.equal(color!.breakpoint, false);
    assert.ok(color!.hash, "the question carries the call's hash");
    // An answer to another hash is not this question's answer.
    writeAnswer(paths, color!.id, "another hash", "red");
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(runQuestions(paths, record.runId).map((q) => q.id), [color!.id], "the question still waits");
    assert.deepEqual(inbox(paths, record.runId), [`<id>--${color!.callIndex}.answer.json`, `<id>--${color!.callIndex}.json`]);
    writeAnswer(paths, color!.id, color!.hash, "blue");

    await until(() => runQuestions(paths, record.runId).some((q) => q.kind === "confirm"));
    const [ship] = await asked(paths, record.runId, 1);
    assert.equal(ship!.kind, "confirm");
    assert.equal(existsSync(answerFile(paths, color!.id)), false, "taking an answer removes its file");
    assert.equal(existsSync(join(paths.inbox, `${color!.id}.json`)), false, "and the question's file");
    writeAnswer(paths, ship!.id, ship!.hash, true);

    await until(() => runQuestions(paths, record.runId).some((q) => q.breakpoint));
    const [plan] = await asked(paths, record.runId, 1);
    assert.equal(plan!.kind, "input");
    assert.equal(plan!.breakpoint, true);
    writeAnswer(paths, plan!.id, plan!.hash, "approve");

    const result = await worker;
    assert.equal(result?.status, "completed");
    assert.deepEqual(JSON.parse(JSON.stringify(result?.result)), { color: "blue", ship: true, plan: { decision: "approve" } });
    assert.deepEqual(inbox(paths, record.runId), [], "the inbox is empty");
    const id = (question: Question) => `<id>--${question.callIndex}`;
    assert.deepEqual(questionLines(lines, record.runId), [
      `question   ${id(color!)}: Pick a color\n           answer with: sous answer ${id(color!)} "..."`,
      `answered   ${id(color!)}: "blue"`,
      `question   ${id(ship!)}: Ship it?\n           answer with: sous answer ${id(ship!)} "..."`,
      `answered   ${id(ship!)}: true`,
      `question   ${id(plan!)}: Breakpoint: Check the plan the plan Reply approve, stop, or send back with a note.\n           answer with: sous approve ${id(plan!)}  |  sous send-back ${id(plan!)} "note"  |  sous stop <id>`,
      `answered   ${id(plan!)}: "approve"`,
    ]);
  });

  it("keeps the question when the run pauses, and on resume takes the answer given meanwhile without asking again", async () => {
    const { paths, projectDir } = setup({
      named: `export const meta = { name: 'named', description: 'asks a name', timeout: '300ms' }
const name = await ask('Your name?')
return 'hello ' + name`,
    });
    const record = createRun(paths, { who: PERSON, workflow: "named", projectDir, inputs: {} });
    const { runner } = heldRunner(() => "unused");
    const paused = await runWorker(record.runId, "start", { paths, inner: runner, pollMs: 20, log: () => {} });
    assert.equal(paused?.status, "paused");
    const [question] = runQuestions(paths, record.runId);
    assert.equal(question?.prompt, "Your name?", "the paused run still asks");

    writeAnswer(paths, question!.id, question!.hash, "Ann");
    updateRecord(paths, record.runId, { timeout: undefined });
    const lines: string[] = [];
    const done = await runWorker(record.runId, "resume", { paths, inner: runner, pollMs: 20, log: (line) => lines.push(line) });
    assert.equal(done?.status, "completed");
    assert.equal(done?.result, "hello Ann");
    assert.deepEqual(questionLines(lines, record.runId), [`answered   <id>--${question!.callIndex}: "Ann"`], "the answer is taken at once, with no new question");
    assert.deepEqual(inbox(paths, record.runId), []);
  });
});

describe("a dry run's questions", () => {
  it("get stand-in answers at once: the first choice, a stand-in text, yes, and approve", async () => {
    const { paths, projectDir } = setup({
      dry: `export const meta = { name: 'dry', description: 'asks four ways' }
const color = await ask('Pick a color', { choices: ['red', 'blue'] })
const name = await ask('Your name?')
const ship = await checkpoint('Ship it?')
const plan = await breakpoint('Check the plan', { show: 'the plan' })
return { color, name, ship, plan }`,
    });
    const lines: string[] = [];
    const dry = await dryRun(paths, { who: PERSON, workflow: "dry", projectDir, inputs: {}, log: (line) => lines.push(line) });
    assert.equal(dry.status, "completed");
    assert.deepEqual(dry.result, { color: "red", name: "stand-in answer", ship: true, plan: { decision: "approve" } });
    assert.deepEqual(questionLines(lines, dry.runId), [
      `question   Pick a color\n           answered   "red" (dry run)`,
      `question   Your name?\n           answered   "stand-in answer" (dry run)`,
      `question   Ship it?\n           answered   true (dry run)`,
      `question   Breakpoint: Check the plan the plan Reply approve, stop, or send back with a note.\n           answered   "approve" (dry run)`,
    ]);
  });
});

// Piece 8, questions. Each question file says who may answer it: answeredBy "people" or "anyone",
// and an agent's question names its step. A breakpoint is always for people. A file written
// before piece 8 has no answeredBy and reads as a people question.
describe("piece 8: who may answer, in the question's file", () => {
  it("a question file without answeredBy reads as people", () => {
    const { paths } = setup({});
    const old = { id: "r1--0", runId: "r1", scope: "r1", callIndex: 0, hash: "h0", workflow: "w", prompt: "Which color?", kind: "select", choices: ["red", "blue"], breakpoint: false, askedAt: "2026-11-23T10:00:00.000Z" };
    writeFileSync(join(paths.inbox, "r1--0.json"), `${JSON.stringify(old, null, 2)}\n`);
    const oldBreakpoint = { ...old, id: "r1--1", callIndex: 1, kind: "input", choices: undefined, breakpoint: true, askedAt: "2026-11-23T10:01:00.000Z" };
    writeFileSync(join(paths.inbox, "r1--1.json"), `${JSON.stringify(oldBreakpoint, null, 2)}\n`);
    assert.equal((readQuestion(paths, "r1--0") as { answeredBy?: string } | undefined)?.answeredBy, "people");
    assert.equal((readQuestion(paths, "r1--1") as { answeredBy?: string } | undefined)?.answeredBy, "people");
    assert.deepEqual(
      runQuestions(paths, "r1").map((q) => [q.id, (q as { answeredBy?: string }).answeredBy]),
      [["r1--0", "people"], ["r1--1", "people"]],
    );
  });

  it("a run writes answeredBy in each question's file, and the step of an agent's question", async () => {
    const { paths, projectDir } = setup({
      who: `export const meta = { name: 'who', description: 'asks four ways' }
const color = await ask('Which color?', { choices: ['red', 'blue'], answeredBy: 'anyone' })
const size = await ask('Which size?', { choices: ['S', 'L'] })
await breakpoint('Check the plan', { show: color + size })
return await agent('Build it', { label: 'builder', ask: true })`,
    });
    const record = createRun(paths, { who: PERSON, workflow: "who", projectDir, inputs: {} });
    const held = heldRunner((call) => (call.label === "builder" ? "QUESTION: Which shade?" : "built it"));
    const worker = runWorker(record.runId, "start", { paths, inner: held.runner, pollMs: 20, log: () => {} });
    const file = (question: Question) => JSON.parse(readFileSync(join(paths.inbox, `${question.id}.json`), "utf8")) as Record<string, unknown>;
    const next = async (pattern: RegExp): Promise<Record<string, unknown>> => {
      await until(() => runQuestions(paths, record.runId).some((q) => pattern.test(q.prompt)));
      const [question] = await asked(paths, record.runId, 1);
      assert.match(question!.prompt, pattern);
      return file(question!);
    };

    // A failed check leaves the run waiting, so the finally answers every open question until it ends.
    let ended = false;
    void worker.finally(() => (ended = true));
    try {
      const color = await next(/Which color/);
      assert.equal(color.answeredBy, "anyone", JSON.stringify(color));
      assert.equal(color.step, undefined, "ask() has no step");
      writeAnswer(paths, color.id as string, color.hash as string, "blue");

      const size = await next(/Which size/);
      assert.equal(size.answeredBy, "people", JSON.stringify(size));
      writeAnswer(paths, size.id as string, size.hash as string, "L");

      const plan = await next(/Check the plan/);
      assert.equal(plan.breakpoint, true);
      assert.equal(plan.answeredBy, "people", JSON.stringify(plan));
      writeAnswer(paths, plan.id as string, plan.hash as string, "approve");

      const shade = await next(/Which shade/);
      assert.equal(shade.answeredBy, "people", JSON.stringify(shade));
      assert.equal(shade.step, "builder", JSON.stringify(shade));
      writeAnswer(paths, shade.id as string, shade.hash as string, "dark");

      const result = await worker;
      assert.equal(result?.status, "completed");
      assert.equal(result?.result, "built it");
    } finally {
      for (let i = 0; i < 250 && !ended; i++) {
        for (const open of runQuestions(paths, record.runId)) writeAnswer(paths, open.id, open.hash, standIn(open));
        await new Promise((r) => setTimeout(r, 20));
      }
    }
  });
});

describe("a breakpoint's title and the text it shows", () => {
  it("come apart from the prompt that packs them for the terminal", async () => {
    const { paths, projectDir } = setup({
      plan: `export const meta = { name: 'plan', description: 'two breakpoints' }
await breakpoint('Check the plan', { show: 'Step one.\\nStep two.' })
await breakpoint('Ship it')
return 'shipped'`,
    });
    const record = createRun(paths, { who: PERSON, workflow: "plan", projectDir, inputs: {} });
    const worker = runWorker(record.runId, "start", { paths, inner: heldRunner(() => "ok").runner, pollMs: 20, log: () => {} });

    const [plan] = await asked(paths, record.runId, 1);
    assert.equal(plan!.prompt, "Breakpoint: Check the plan\n\nStep one.\nStep two.\n\nReply approve, stop, or send back with a note.");
    const shown = questionView(plan!);
    assert.equal(shown.title, "Check the plan");
    assert.equal(shown.show, "Step one.\nStep two.");
    writeAnswer(paths, plan!.id, plan!.hash, "approve");

    await until(() => runQuestions(paths, record.runId).some((q) => q.id !== plan!.id));
    const [ship] = await asked(paths, record.runId, 1);
    assert.deepEqual([questionView(ship!).title, questionView(ship!).show], ["Ship it", undefined]);
    writeAnswer(paths, ship!.id, ship!.hash, "approve");
    assert.equal((await worker)?.status, "completed");

    // A question an older sous wrote has them only in its prompt, so they come from there.
    const older: Question = { ...plan!, title: undefined, show: undefined };
    assert.deepEqual([questionView(older).title, questionView(older).show], ["Check the plan", "Step one.\nStep two."]);
    const notBreakpoint: Question = { ...plan!, breakpoint: false, prompt: "Ship it?" };
    assert.deepEqual([questionView(notBreakpoint).title, questionView(notBreakpoint).show], [undefined, undefined]);
  });
});
