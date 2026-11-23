import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { runQuestions, type HomePaths, type RunQuestion } from "@orchestrator/engine";
import { createRun, runWorker, testHome, updateRecord, type InnerRunner } from "@orchestrator/engine/testing";
import { main } from "../src/cli.js";
import { capture, orc } from "./orc.js";

// How orc shows a question, takes a reply and writes the answer, through its commands and the
// prompt of `orc wait` in a terminal.

const harnessHome = mkdtempSync(join(tmpdir(), "orc-harness-home-"));
process.env.CLAUDE_CONFIG_DIR = join(harnessHome, ".claude");
process.env.CODEX_HOME = join(harnessHome, ".codex");
process.env.XDG_CONFIG_HOME = join(harnessHome, ".config");
delete process.env.AGENTPRISM_DEFAULT_BACKEND;

/** These workflows ask and run no agent. */
const runner = { run: async () => "unused" } as unknown as InnerRunner;
const quiet = () => {};

/**
 * Run orc as in a terminal. Each time orc prompts, the next reply is typed. Returns the exit
 * code and what orc printed, the prompts included.
 */
async function inTerminal(paths: HomePaths, argv: string[], replies: string[]): Promise<{ code: number; out: string }> {
  const input = Object.assign(new PassThrough(), { isTTY: true });
  const stdin = Object.getOwnPropertyDescriptor(process, "stdin")!;
  const tty = process.stdout.isTTY;
  Object.defineProperty(process, "stdin", { configurable: true, get: () => input });
  process.stdout.isTTY = true;
  const before = process.env.ORC_HOME;
  process.env.ORC_HOME = paths.home;
  const printed: string[] = [];
  const restore = capture(printed);
  let typed = 0;
  const typing = setInterval(() => {
    const prompts = printed.join("").split(") > ").length - 1;
    if (prompts > typed && typed < replies.length) input.write(`${replies[typed++]}\n`);
  }, 20);
  try {
    return { code: await main(argv), out: printed.join("") };
  } finally {
    clearInterval(typing);
    restore();
    if (before === undefined) delete process.env.ORC_HOME;
    else process.env.ORC_HOME = before;
    Object.defineProperty(process, "stdin", stdin);
    process.stdout.isTTY = tty;
  }
}

async function asked(paths: HomePaths, runId: string, count: number): Promise<RunQuestion[]> {
  for (let i = 0; i < 250 && runQuestions(paths, runId).length < count; i++) await new Promise((r) => setTimeout(r, 20));
  const open = runQuestions(paths, runId);
  assert.equal(open.length, count, "the run asks");
  return open;
}

const four = `export const meta = { name: 'four', description: 'asks four ways at once' }
const [color, name, ship, plan] = await Promise.all([
  ask('Pick a color', { choices: ['red', 'blue'] }),
  ask('Your name?'),
  checkpoint('Ship it?'),
  breakpoint('Check the plan', { show: 'the plan' }),
])
return { color, name, ship, plan }`;

describe("how orc shows a question", () => {
  it("inbox, show and wait name the commands that answer each kind, and the commands answer them", async () => {
    const { paths, projectDir } = testHome({ four });
    const record = createRun(paths, { workflow: "four", projectDir, inputs: {} });
    const running = runWorker(record.runId, "start", { paths, inner: runner, pollMs: 20, log: quiet });
    const [color, name, ship, plan] = await asked(paths, record.runId, 4);
    const id = record.runId;
    const ids = (text: string) => text.split(id).join("<id>");
    assert.deepEqual([color, name, ship, plan].map((q) => q!.prompt.split("\n")[0]), ["Pick a color", "Your name?", "Ship it?", "Breakpoint: Check the plan"]);
    const n = (q: RunQuestion | undefined) => `<id>--${q!.callIndex}`;

    const inbox = await orc(paths, ["inbox"]);
    assert.equal(inbox.code, 0);
    assert.equal(
      ids(inbox.out).replace(/ \d+s ago/g, " <age> ago"),
      [
        `${n(color)}  four  <age> ago`,
        `  Pick a color`,
        `  orc answer ${n(color)} <one of: red, blue>`,
        `${n(name)}  four  <age> ago`,
        `  Your name?`,
        `  orc answer ${n(name)} "..."`,
        `${n(ship)}  four  <age> ago`,
        `  Ship it?`,
        `  orc answer ${n(ship)} yes|no`,
        `${n(plan)}  four  <age> ago`,
        `  Breakpoint: Check the plan`,
        `  `,
        `  the plan`,
        `  `,
        `  Reply approve, stop, or send back with a note.`,
        `  orc approve ${n(plan)}  |  orc send-back ${n(plan)} "note"  |  orc stop <id>`,
        ``,
      ].join("\n"),
    );

    const show = await orc(paths, ["show", id]);
    assert.equal(show.code, 0);
    assert.deepEqual(
      ids(show.out)
        .split("\n")
        .flatMap((line, i, all) => (line.startsWith("asks ") ? [line, all[i + 1]] : [])),
      [
        `asks      ${n(color)}: Pick a color`,
        `          orc answer ${n(color)} <one of: red, blue>`,
        `asks      ${n(name)}: Your name?`,
        `          orc answer ${n(name)} "..."`,
        `asks      ${n(ship)}: Ship it?`,
        `          orc answer ${n(ship)} yes|no`,
        `asks      ${n(plan)}: Breakpoint: Check the plan`,
        ``,
      ],
    );

    const wait = await orc(paths, ["wait", id]);
    assert.equal(wait.code, 4, wait.out);
    assert.equal(
      ids(wait.out),
      [
        ``,
        `waiting for an answer to ${n(color)}:`,
        `  Pick a color`,
        `  orc answer ${n(color)} <one of: red, blue>`,
        `  then: orc wait <id>`,
        ``,
        `waiting for an answer to ${n(name)}:`,
        `  Your name?`,
        `  orc answer ${n(name)} "..."`,
        `  then: orc wait <id>`,
        ``,
        `waiting for an answer to ${n(ship)}:`,
        `  Ship it?`,
        `  orc answer ${n(ship)} yes|no`,
        `  then: orc wait <id>`,
        ``,
        `waiting for an answer to ${n(plan)}:`,
        `  Breakpoint: Check the plan`,
        ``,
        `the plan`,
        ``,
        `Reply approve, stop, or send back with a note.`,
        `  orc approve ${n(plan)}  |  orc send-back ${n(plan)} "note"  |  orc stop <id>`,
        `  then: orc wait <id>`,
        ``,
      ].join("\n"),
    );

    const replies = [
      await orc(paths, ["answer", color!.id, "Blue"]),
      await orc(paths, ["answer", name!.id, "Ann", "Lee"]),
      await orc(paths, ["answer", ship!.id, "yes"]),
      await orc(paths, ["approve", plan!.id]),
    ];
    assert.deepEqual(
      replies.map((reply) => [reply.code, ids(reply.out)]),
      [color, name, ship, plan].map((q) => [0, `answered ${n(q)}\n`]),
    );
    const result = await running;
    assert.equal(result?.status, "completed");
    assert.deepEqual(JSON.parse(JSON.stringify(result?.result)), { color: "blue", name: "Ann Lee", ship: true, plan: { decision: "approve" } });
  });
});

describe("what a reply writes", () => {
  const kinds: Record<string, Partial<RunQuestion>> = {
    confirm: { kind: "confirm" },
    select: { kind: "select", choices: ["Red", "Blue"] },
    input: { kind: "input" },
    breakpoint: { kind: "input", breakpoint: true, prompt: "Breakpoint: Check\n\nReply approve, stop, or send back with a note." },
  };
  const not = (id: string) => `answered ${id}. The run is not running: orc resume r1 uses the answer.\n`;
  // [kind, command and its words, exit code, what orc prints, the answer's value or none]
  const cases: Array<[string, string[], number, (id: string) => string, unknown?]> = [
    ["confirm", ["answer", "yes"], 0, not, true],
    ["confirm", ["answer", "no"], 0, not, false],
    ["confirm", ["answer", "ok"], 0, not, true],
    ["confirm", ["answer", "maybe"], 1, () => "orc: answer yes or no\n"],
    ["confirm", ["answer"], 1, () => "orc: answer yes or no\n"],
    ["confirm", ["approve"], 0, not, true],
    ["confirm", ["send-back", "shorter"], 64, (id) => `usage: ${id} is not a breakpoint. Use orc answer ${id} "..."\n`],
    ["select", ["answer", "blue"], 0, not, "Blue"],
    ["select", ["answer", "green"], 1, () => "orc: answer one of: Red, Blue\n"],
    ["select", ["answer", "--json", '"green"'], 64, () => "usage: answer one of: Red, Blue\n"],
    ["select", ["answer", "--json", '"Blue"'], 0, not, "Blue"],
    ["select", ["answer"], 64, (id) => `usage: orc answer ${id} "your answer"\n`],
    ["select", ["approve"], 0, not, "approve"],
    ["input", ["answer"], 64, (id) => `usage: orc answer ${id} "your answer"\n`],
    ["input", ["answer", "some", "text"], 0, not, "some text"],
    ["input", ["answer", "  padded "], 0, not, "  padded "],
    ["input", ["answer", "--json", '{"a":1}'], 0, not, { a: 1 }],
    ["input", ["answer", "--json", "not json"], 0, not, "not json"],
    ["input", ["approve"], 0, not, "approve"],
    ["breakpoint", ["answer"], 64, (id) => `usage: orc answer ${id} "your answer"\n`],
    ["breakpoint", ["answer", " "], 0, not, "approve"],
    ["breakpoint", ["answer", "ok"], 0, not, "approve"],
    ["breakpoint", ["answer", "Yes"], 0, not, "approve"],
    ["breakpoint", ["answer", "send", "back:", "shorter"], 0, not, { decision: "send back", note: "shorter" }],
    ["breakpoint", ["answer", "make", "it", "shorter"], 0, not, { decision: "send back", note: "make it shorter" }],
    ["breakpoint", ["answer", "send-back"], 0, not, { decision: "send back", note: "" }],
    ["breakpoint", ["answer", "--json", '"stop"'], 0, not, { decision: "send back", note: '"stop"' }],
    ["breakpoint", ["approve"], 0, not, "approve"],
    ["breakpoint", ["send-back"], 64, (id) => `usage: orc send-back ${id} "what to change"\n`],
    ["breakpoint", ["send-back", "shorter", "please"], 0, not, { decision: "send back", note: "shorter please" }],
    ["breakpoint", ["send-back", "stop"], 0, not, { decision: "send back", note: "stop" }],
  ];

  it("takes each kind's words, writes the value in the answer file, and refuses what does not fit", async () => {
    const { paths } = testHome();
    const got: unknown[] = [];
    const want: unknown[] = [];
    for (const [n, [kind, [command, ...words], code, printed, value]] of cases.entries()) {
      const id = `r1--${n}`;
      const question: RunQuestion = { id, runId: "r1", scope: "r1", callIndex: n, hash: `h${n}`, workflow: "w", prompt: "?", kind: "input", breakpoint: false, askedAt: "2026-11-23T10:00:00.000Z", ...kinds[kind] };
      writeFileSync(join(paths.inbox, `${id}.json`), JSON.stringify(question, null, 2));
      const reply = await orc(paths, [command!, id, ...words]);
      const file = join(paths.inbox, `${id}.answer.json`);
      const answer = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { hash: string; value: unknown }) : undefined;
      got.push([kind, command, ...words, reply.code, reply.out, answer && { hash: answer.hash, value: answer.value }]);
      want.push([kind, command, ...words, code, printed(id), value === undefined ? undefined : { hash: `h${n}`, value }]);
      if (existsSync(file)) unlinkSync(file);
    }
    assert.deepEqual(got, want);
  });

  it("writes the answer file as indented JSON with the question's hash and the time", async () => {
    const { paths } = testHome();
    const question: RunQuestion = { id: "r1--0", runId: "r1", scope: "r1", callIndex: 0, hash: "h0", workflow: "w", prompt: "?", kind: "input", breakpoint: false, askedAt: "2026-11-23T10:00:00.000Z" };
    writeFileSync(join(paths.inbox, "r1--0.json"), JSON.stringify(question, null, 2));
    assert.equal((await orc(paths, ["answer", "r1--0", "blue"])).code, 0);
    const text = readFileSync(join(paths.inbox, "r1--0.answer.json"), "utf8");
    const answeredAt = (JSON.parse(text) as { answeredAt: string }).answeredAt;
    assert.ok(!Number.isNaN(Date.parse(answeredAt)), text);
    assert.equal(text, `{\n  "hash": "h0",\n  "value": "blue",\n  "answeredAt": "${answeredAt}"\n}\n`);
  });
});

describe("the prompt of orc wait in a terminal", () => {
  const each = `export const meta = { name: 'each', description: 'asks four ways in turn' }
const color = await ask('Pick a color', { choices: ['red', 'blue'] })
const name = await ask('Your name?')
const ship = await checkpoint('Ship it?')
const plan = await breakpoint('Check the plan', { show: 'the plan' })
return { color, name, ship, plan }`;

  it("asks each question with the words it takes, and the wait goes on to the result", async () => {
    const { paths, projectDir } = testHome({ each });
    const record = createRun(paths, { workflow: "each", projectDir, inputs: {} });
    const running = runWorker(record.runId, "start", { paths, inner: runner, pollMs: 20, log: quiet });
    const wait = await inTerminal(paths, ["wait", record.runId], ["BLUE", "  Ann ", "y", ""]);
    const result = await running;
    assert.equal(wait.code, 0, wait.out);
    assert.deepEqual(JSON.parse(JSON.stringify(result?.result)), { color: "blue", name: "Ann", ship: true, plan: { decision: "approve" } });
    const prompts = ["\nPick a color\n(red / blue) > ", "\nYour name?\n(your answer) > ", "\nShip it?\n(yes or no) > ", "\nBreakpoint: Check the plan\n\nthe plan\n\nReply approve, stop, or send back with a note.\n(approve, stop, or a note to send back) > "];
    let at = 0;
    for (const prompt of prompts) {
      const found = wait.out.indexOf(prompt, at);
      assert.ok(found >= 0, `prompt ${JSON.stringify(prompt)} in ${JSON.stringify(wait.out)}`);
      at = found + prompt.length;
    }
    assert.ok(wait.out.endsWith(`result:\n${JSON.stringify(result?.result, null, 2)}\n`), wait.out);
  });

  it("a breakpoint's stop stops the run: the wait ends with exit code 3 and the run is stopped", async () => {
    const { paths, projectDir } = testHome({ each });
    const record = createRun(paths, { workflow: "each", projectDir, inputs: {} });
    const running = runWorker(record.runId, "start", { paths, inner: runner, pollMs: 20, log: quiet, handleSignals: true });
    const wait = await inTerminal(paths, ["wait", record.runId], ["red", "Ann", "yes", " Stop "]);
    const result = await running;
    assert.equal(wait.code, 3, wait.out);
    assert.equal(result?.status, "aborted");
    assert.deepEqual(runQuestions(paths, record.runId), []);
    assert.match((await orc(paths, ["show", record.runId])).out, /^status {4}stopped$/m);
  });

  it("a reply that does not fit ends the wait with exit code 1, and the question still waits", async () => {
    const { paths, projectDir } = testHome({ each });
    const record = createRun(paths, { workflow: "each", projectDir, inputs: {} });
    const running = runWorker(record.runId, "start", { paths, inner: runner, pollMs: 20, log: quiet, handleSignals: true });
    const wait = await inTerminal(paths, ["wait", record.runId], ["green"]);
    assert.equal(wait.code, 1);
    assert.ok(wait.out.endsWith("orc: answer one of: red, blue\n"), wait.out);
    const [question] = runQuestions(paths, record.runId);
    assert.equal(question?.prompt, "Pick a color");
    assert.equal((await orc(paths, ["stop", record.runId])).code, 0);
    assert.equal((await running)?.status, "aborted");
  });
});

describe("stop at a breakpoint", () => {
  // A time limit pauses the run at the breakpoint, the way a run waits while nobody answers.
  const checked = `export const meta = { name: 'checked', description: 'a breakpoint' }
return await breakpoint('Check the plan', { show: 'the plan' })`;
  const held = `export const meta = { name: 'held', description: 'a breakpoint', timeout: '300ms' }
return await breakpoint('Check the plan', { show: 'the plan' })`;

  async function stopped(paths: HomePaths, runId: string): Promise<void> {
    assert.deepEqual(runQuestions(paths, runId), [], "the stop removes the question");
    const wait = await orc(paths, ["wait", runId]);
    assert.equal(wait.code, 3, wait.out);
    assert.match((await orc(paths, ["show", runId])).out, /^status {4}stopped$/m);
  }

  it("orc answer <q> stop stops a running run, as orc stop does", async () => {
    const { paths, projectDir } = testHome({ checked });
    const record = createRun(paths, { workflow: "checked", projectDir, inputs: {} });
    const running = runWorker(record.runId, "start", { paths, inner: runner, pollMs: 20, log: quiet, handleSignals: true });
    const [question] = await asked(paths, record.runId, 1);
    assert.deepEqual(await orc(paths, ["answer", question!.id, "Stop"]), { code: 0, out: `stopping ${record.runId}\n` });
    assert.equal((await running)?.status, "aborted");
    await stopped(paths, record.runId);
  });

  it("orc answer <q> stop stops a paused run at once, as orc stop does", async () => {
    const { paths, projectDir } = testHome({ held });
    const record = createRun(paths, { workflow: "held", projectDir, inputs: {} });
    const paused = await runWorker(record.runId, "start", { paths, inner: runner, pollMs: 20, log: quiet });
    assert.equal(paused?.status, "paused");
    const [question] = runQuestions(paths, record.runId);
    assert.deepEqual(await orc(paths, ["answer", question!.id, "stop"]), { code: 0, out: `stopped ${record.runId}\n` });
    await stopped(paths, record.runId);
  });

  it("a stop that an older orc wrote to a paused run's answer file stops the run on resume", async () => {
    const { paths, projectDir } = testHome({ held });
    const record = createRun(paths, { workflow: "held", projectDir, inputs: {} });
    const paused = await runWorker(record.runId, "start", { paths, inner: runner, pollMs: 20, log: quiet });
    assert.equal(paused?.status, "paused");
    const [question] = runQuestions(paths, record.runId);
    writeFileSync(join(paths.inbox, `${question!.id}.answer.json`), `${JSON.stringify({ hash: question!.hash, value: "stop", answeredAt: new Date().toISOString() }, null, 2)}\n`);
    updateRecord(paths, record.runId, { timeout: undefined });
    const lines: string[] = [];
    // A resume that ends in a stop returns no result. The log and orc say how it ended.
    await runWorker(record.runId, "resume", { paths, inner: runner, pollMs: 20, log: (line) => lines.push(line.slice(9)) });
    assert.deepEqual(lines.slice(1), [`answered   ${question!.id}: "stop"`, "stopping", "aborted    held"]);
    await stopped(paths, record.runId);
  });
});
