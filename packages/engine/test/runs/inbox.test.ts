import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { HomePaths } from "../../src/runs/home.js";
import { ask, breakpointValue, decisionOf, normalizeAnswer, standIn, type Question } from "../../src/runs/inbox.js";
import { createRun } from "../../src/runs/launch.js";
import { updateRecord } from "../../src/runs/records.js";
import { runQuestions } from "../../src/runs/run.js";
import { runWorker } from "../../src/runs/worker.js";
import { dryRun } from "../../src/workflows/dry-run.js";
import { heldRunner, setup, until } from "./fixture.js";

describe("questions", () => {
  it("turns an answer into the question's kind", () => {
    const base: Question = { id: "q", runId: "r", scope: "r", callIndex: 1, hash: "h", workflow: "w", prompt: "?", kind: "confirm", breakpoint: false, askedAt: "" };
    assert.equal(normalizeAnswer(base, "yes"), true);
    assert.equal(normalizeAnswer(base, "no"), false);
    assert.equal(normalizeAnswer({ ...base, kind: "input" }, "blue"), "blue");
  });
});

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

// The answer files below are raw writes, the way today's orc writes them.

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

describe("a run that waits for an answer", () => {
  it("takes the answer whose hash matches, removes both files, and logs the question and the answer", async () => {
    const { paths, projectDir } = setup({ pick });
    const record = createRun(paths, { workflow: "pick", projectDir, inputs: {} });
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
      `question   ${id(color!)}: Pick a color\n           answer with: orc answer ${id(color!)} "..."`,
      `answered   ${id(color!)}: "blue"`,
      `question   ${id(ship!)}: Ship it?\n           answer with: orc answer ${id(ship!)} "..."`,
      `answered   ${id(ship!)}: true`,
      `question   ${id(plan!)}: Breakpoint: Check the plan the plan Reply approve, stop, or send back with a note.\n           answer with: orc approve ${id(plan!)}  |  orc send-back ${id(plan!)} "note"  |  orc stop <id>`,
      `answered   ${id(plan!)}: "approve"`,
    ]);
  });

  it("keeps the question when the run pauses, and on resume takes the answer given meanwhile without asking again", async () => {
    const { paths, projectDir } = setup({
      named: `export const meta = { name: 'named', description: 'asks a name', timeout: '300ms' }
const name = await ask('Your name?')
return 'hello ' + name`,
    });
    const record = createRun(paths, { workflow: "named", projectDir, inputs: {} });
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

  it("stops waiting when the run stops, and the stop removes the question", async () => {
    const { paths, projectDir } = setup({ pick });
    const record = createRun(paths, { workflow: "pick", projectDir, inputs: {} });
    const lines: string[] = [];
    const worker = runWorker(record.runId, "start", { paths, inner: heldRunner(() => "unused").runner, pollMs: 20, log: (line) => lines.push(line), handleSignals: true });
    await asked(paths, record.runId, 1);
    process.kill(process.pid, "SIGTERM");
    const result = await worker;
    assert.equal(result?.status, "aborted");
    assert.deepEqual(inbox(paths, record.runId), [], "the stop removed the question");
    assert.ok(lines.some((line) => line.slice(9) === "stopping"), lines.join("\n"));
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
    const dry = await dryRun(paths, { workflow: "dry", projectDir, inputs: {}, log: (line) => lines.push(line) });
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
