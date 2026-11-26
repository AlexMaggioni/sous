import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { listRecords, loadRecord, logFile, rememberProject, runQuestions, startRun, type HomePaths, type RunQuestion } from "@sous-run/engine";
import { PERSON, inProcess, testHome, type InnerRunner } from "@sous-run/engine/testing";
import { main } from "../src/cli.js";
import { capture, sous, waitFor } from "./sous.js";

// How sous shows a question, takes a reply and writes the answer, through its commands and the
// prompt of `sous wait` in a terminal.


/** These workflows ask and run no agent. */
const runner = { run: async () => "unused" } as unknown as InnerRunner;

/**
 * Run sous as in a terminal. Each time sous prompts, the next reply is typed. Returns the exit
 * code and what sous printed, the prompts included.
 */
async function inTerminal(paths: HomePaths, argv: string[], replies: string[]): Promise<{ code: number; out: string }> {
  const input = Object.assign(new PassThrough(), { isTTY: true });
  const stdin = Object.getOwnPropertyDescriptor(process, "stdin")!;
  const tty = process.stdout.isTTY;
  Object.defineProperty(process, "stdin", { configurable: true, get: () => input });
  process.stdout.isTTY = true;
  const before = process.env.SOUS_HOME;
  process.env.SOUS_HOME = paths.home;
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
    if (before === undefined) delete process.env.SOUS_HOME;
    else process.env.SOUS_HOME = before;
    Object.defineProperty(process, "stdin", stdin);
    process.stdout.isTTY = tty;
  }
}

async function asked(paths: HomePaths, runId: string, count: number): Promise<RunQuestion[]> {
  await waitFor(() => runQuestions(paths, runId).length >= count, "the run to ask");
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

describe("how sous shows a question", () => {
  it("inbox, show and wait name the commands that answer each kind, and the commands answer them", async () => {
    const { paths, projectDir } = testHome({ four });
    const workers = inProcess({ inner: runner });
    const record = startRun(paths, workers.launch, { who: PERSON, workflow: "four", projectDir, inputs: {} });
    const [color, name, ship, plan] = await asked(paths, record.runId, 4);
    const id = record.runId;
    const ids = (text: string) => text.split(id).join("<id>");
    assert.deepEqual([color, name, ship, plan].map((q) => q!.prompt.split("\n")[0]), ["Pick a color", "Your name?", "Ship it?", "Breakpoint: Check the plan"]);
    const n = (q: RunQuestion | undefined) => `<id>--${q!.callIndex}`;

    const inbox = await sous(paths, ["inbox"]);
    assert.equal(inbox.code, 0);
    assert.equal(
      ids(inbox.out).replace(/ \d+s ago/g, " <age> ago"),
      [
        `${n(color)}  four  <age> ago`,
        `  Pick a color`,
        `  sous answer ${n(color)} <one of: red, blue>`,
        `${n(name)}  four  <age> ago`,
        `  Your name?`,
        `  sous answer ${n(name)} "..."`,
        `${n(ship)}  four  <age> ago`,
        `  Ship it?`,
        `  sous answer ${n(ship)} yes|no`,
        `${n(plan)}  four  <age> ago`,
        `  Breakpoint: Check the plan`,
        `  `,
        `  the plan`,
        `  `,
        `  Reply approve, stop, or send back with a note.`,
        `  sous approve ${n(plan)}  |  sous send-back ${n(plan)} "note"  |  sous stop <id>`,
        ``,
      ].join("\n"),
    );

    const show = await sous(paths, ["show", id]);
    assert.equal(show.code, 0);
    assert.deepEqual(
      ids(show.out)
        .split("\n")
        .flatMap((line, i, all) => (line.startsWith("asks ") ? [line, all[i + 1]] : [])),
      [
        `asks      ${n(color)}: Pick a color`,
        `          sous answer ${n(color)} <one of: red, blue>`,
        `asks      ${n(name)}: Your name?`,
        `          sous answer ${n(name)} "..."`,
        `asks      ${n(ship)}: Ship it?`,
        `          sous answer ${n(ship)} yes|no`,
        `asks      ${n(plan)}: Breakpoint: Check the plan`,
        ``,
      ],
    );

    const wait = await sous(paths, ["wait", id]);
    assert.equal(wait.code, 4, wait.out);
    // sous wait prints the run's log first, which the worker writes as it asks.
    const log = readFileSync(logFile(paths, id), "utf8");
    assert.match(log, / question {3}\S+--3: Breakpoint: Check the plan/);
    assert.equal(
      ids(wait.out),
      ids(log) +
      [
        ``,
        `waiting for an answer to ${n(color)}:`,
        `  Pick a color`,
        `  sous answer ${n(color)} <one of: red, blue>`,
        `  then: sous wait <id>`,
        ``,
        `waiting for an answer to ${n(name)}:`,
        `  Your name?`,
        `  sous answer ${n(name)} "..."`,
        `  then: sous wait <id>`,
        ``,
        `waiting for an answer to ${n(ship)}:`,
        `  Ship it?`,
        `  sous answer ${n(ship)} yes|no`,
        `  then: sous wait <id>`,
        ``,
        `waiting for an answer to ${n(plan)}:`,
        `  Breakpoint: Check the plan`,
        ``,
        `the plan`,
        ``,
        `Reply approve, stop, or send back with a note.`,
        `  sous approve ${n(plan)}  |  sous send-back ${n(plan)} "note"  |  sous stop <id>`,
        `  then: sous wait <id>`,
        ``,
      ].join("\n"),
    );

    const replies = [
      await sous(paths, ["answer", color!.id, "Blue"]),
      await sous(paths, ["answer", name!.id, "Ann", "Lee"]),
      await sous(paths, ["answer", ship!.id, "yes"]),
      await sous(paths, ["approve", plan!.id]),
    ];
    assert.deepEqual(
      replies.map((reply) => [reply.code, ids(reply.out)]),
      [color, name, ship, plan].map((q) => [0, `answered ${n(q)}\nnext: sous wait <id> --json  (waits for the run, which goes on with the answer)\n`]),
    );
    const result = await workers.ended(record.runId);
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
  const not = (id: string) => `answered ${id}. The run is not running: sous resume r1 uses the answer.\nnext: sous resume r1 --json  (resumes the run, which uses the answer)\n`;
  // [kind, command and its words, exit code, what sous prints, the answer's value or none]
  const cases: Array<[string, string[], number, (id: string) => string, unknown?]> = [
    ["confirm", ["answer", "yes"], 0, not, true],
    ["confirm", ["answer", "no"], 0, not, false],
    ["confirm", ["answer", "ok"], 0, not, true],
    ["confirm", ["answer", "maybe"], 64, (id) => `usage: answer yes or no\n  change: Answer with one of the choices.\n  try: sous answer ${id} yes --json  (answer yes)\n  try: sous answer ${id} no --json  (answer no)\n`],
    ["confirm", ["answer"], 64, (id) => `usage: answer yes or no\n  change: Answer with one of the choices.\n  try: sous answer ${id} yes --json  (answer yes)\n  try: sous answer ${id} no --json  (answer no)\n`],
    ["confirm", ["approve"], 0, not, true],
    ["confirm", ["send-back", "shorter"], 64, (id) => `usage: ${id} is not a breakpoint. Use sous answer ${id} "..."\n  change: Fix the command line. sous help lists the commands and their flags.\n`],
    ["select", ["answer", "blue"], 0, not, "Blue"],
    ["select", ["answer", "green"], 64, (id) => `usage: answer one of: Red, Blue\n  change: Answer with one of the choices.\n  try: sous answer ${id} Red --json  (answer Red)\n  try: sous answer ${id} Blue --json  (answer Blue)\n`],
    [
      "select",
      ["answer", "--json", '"green"'],
      64,
      (id) => `${JSON.stringify({ error: { code: "not_a_choice", message: "answer one of: Red, Blue", change: "Answer with one of the choices.", call: `sous answer ${id} Red --json`, next: [{ call: `sous answer ${id} Red --json`, does: "answer Red" }, { call: `sous answer ${id} Blue --json`, does: "answer Blue" }] } }, null, 2)}\n`,
    ],
    // --value-json reads the words as JSON. --json alone asks for a JSON reply, as on every command.
    ["select", ["answer", "--value-json", '"Blue"'], 0, not, "Blue"],
    ["select", ["answer", "--value-json", '"green"'], 64, (id) => `usage: answer one of: Red, Blue\n  change: Answer with one of the choices.\n  try: sous answer ${id} Red --json  (answer Red)\n  try: sous answer ${id} Blue --json  (answer Blue)\n`],
    ["select", ["answer"], 64, (id) => `usage: sous answer ${id} "your answer"\n  change: Fix the command line. sous help lists the commands and their flags.\n`],
    ["select", ["approve"], 0, not, "approve"],
    ["input", ["answer"], 64, (id) => `usage: sous answer ${id} "your answer"\n  change: Fix the command line. sous help lists the commands and their flags.\n`],
    ["input", ["answer", "some", "text"], 0, not, "some text"],
    ["input", ["answer", "  padded "], 0, not, "  padded "],
    ["input", ["answer", "--value-json", '{"a":1}'], 0, not, { a: 1 }],
    ["input", ["answer", "--value-json", "not json"], 0, (id) => `answered ${id}. The run is not running: sous resume r1 uses the answer.\nnote: The text is not JSON, so it went as text.\nnext: sous resume r1 --json  (resumes the run, which uses the answer)\n`, "not json"],
    ["input", ["approve"], 0, not, "approve"],
    ["breakpoint", ["answer"], 64, (id) => `usage: sous answer ${id} "your answer"\n  change: Fix the command line. sous help lists the commands and their flags.\n`],
    ["breakpoint", ["answer", " "], 0, not, "approve"],
    ["breakpoint", ["answer", "ok"], 0, not, "approve"],
    ["breakpoint", ["answer", "Yes"], 0, not, "approve"],
    ["breakpoint", ["answer", "send", "back:", "shorter"], 0, not, { decision: "send back", note: "shorter" }],
    ["breakpoint", ["answer", "make", "it", "shorter"], 0, not, { decision: "send back", note: "make it shorter" }],
    ["breakpoint", ["answer", "send-back"], 0, not, { decision: "send back", note: "" }],
    ["breakpoint", ["answer", "--value-json", '"stop"'], 0, not, { decision: "send back", note: '"stop"' }],
    ["breakpoint", ["approve"], 0, not, "approve"],
    ["breakpoint", ["send-back"], 64, (id) => `usage: sous send-back ${id} "what to change"\n  change: Fix the command line. sous help lists the commands and their flags.\n`],
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
      const reply = await sous(paths, [command!, id, ...words]);
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
    assert.equal((await sous(paths, ["answer", "r1--0", "blue"])).code, 0);
    const text = readFileSync(join(paths.inbox, "r1--0.answer.json"), "utf8");
    const answeredAt = (JSON.parse(text) as { answeredAt: string }).answeredAt;
    assert.ok(!Number.isNaN(Date.parse(answeredAt)), text);
    assert.equal(text, `{\n  "hash": "h0",\n  "value": "blue",\n  "answeredAt": "${answeredAt}",\n  "by": "person",\n  "through": {\n    "kind": "person"\n  }\n}\n`);
  });
});

describe("the prompt of sous wait in a terminal", () => {
  const each = `export const meta = { name: 'each', description: 'asks four ways in turn' }
const color = await ask('Pick a color', { choices: ['red', 'blue'] })
const name = await ask('Your name?')
const ship = await checkpoint('Ship it?')
const plan = await breakpoint('Check the plan', { show: 'the plan' })
return { color, name, ship, plan }`;

  it("asks each question with the words it takes, and the wait goes on to the result", async () => {
    const { paths, projectDir } = testHome({ each });
    const workers = inProcess({ inner: runner });
    const record = startRun(paths, workers.launch, { who: PERSON, workflow: "each", projectDir, inputs: {} });
    const wait = await inTerminal(paths, ["wait", record.runId], ["BLUE", "  Ann ", "y", ""]);
    const result = await workers.ended(record.runId);
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
    const workers = inProcess({ inner: runner, handleSignals: true });
    const record = startRun(paths, workers.launch, { who: PERSON, workflow: "each", projectDir, inputs: {} });
    const wait = await inTerminal(paths, ["wait", record.runId], ["red", "Ann", "yes", " Stop "]);
    const result = await workers.ended(record.runId);
    assert.equal(wait.code, 3, wait.out);
    assert.equal(result?.status, "aborted");
    assert.deepEqual(runQuestions(paths, record.runId), []);
    assert.match((await sous(paths, ["show", record.runId])).out, /^status {4}stopped$/m);
  });

  it("a reply that does not fit ends the wait with exit code 1, and the question still waits", async () => {
    const { paths, projectDir } = testHome({ each });
    const workers = inProcess({ inner: runner, handleSignals: true });
    const record = startRun(paths, workers.launch, { who: PERSON, workflow: "each", projectDir, inputs: {} });
    const wait = await inTerminal(paths, ["wait", record.runId], ["green"]);
    assert.equal(wait.code, 1);
    assert.ok(wait.out.endsWith("sous: answer one of: red, blue\n"), wait.out);
    const [question] = runQuestions(paths, record.runId);
    assert.equal(question?.prompt, "Pick a color");
    assert.equal((await sous(paths, ["stop", record.runId])).code, 0);
    assert.equal((await workers.ended(record.runId))?.status, "aborted");
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
    const wait = await sous(paths, ["wait", runId]);
    assert.equal(wait.code, 3, wait.out);
    assert.match((await sous(paths, ["show", runId])).out, /^status {4}stopped$/m);
  }

  it("sous answer <q> stop stops a running run, as sous stop does", async () => {
    const { paths, projectDir } = testHome({ checked });
    const workers = inProcess({ inner: runner, handleSignals: true });
    const record = startRun(paths, workers.launch, { who: PERSON, workflow: "checked", projectDir, inputs: {} });
    const [question] = await asked(paths, record.runId, 1);
    assert.deepEqual(await sous(paths, ["answer", question!.id, "Stop"]), { code: 0, out: `stopping ${record.runId}\n` });
    assert.equal((await workers.ended(record.runId))?.status, "aborted");
    await stopped(paths, record.runId);
  });

  it("sous answer <q> stop stops a paused run at once, as sous stop does", async () => {
    const { paths, projectDir } = testHome({ held });
    const workers = inProcess({ inner: runner });
    const record = startRun(paths, workers.launch, { who: PERSON, workflow: "held", projectDir, inputs: {} });
    const paused = await workers.ended(record.runId);
    assert.equal(paused?.status, "paused");
    const [question] = runQuestions(paths, record.runId);
    assert.deepEqual(await sous(paths, ["answer", question!.id, "stop"]), { code: 0, out: `stopped ${record.runId}\n` });
    await stopped(paths, record.runId);
  });

  it("sous answer <q> stop --json replies with the keys of any answer, answered true", async () => {
    const { paths, projectDir } = testHome({ held });
    const workers = inProcess({ inner: runner });
    const record = startRun(paths, workers.launch, { who: PERSON, workflow: "held", projectDir, inputs: {} });
    await workers.ended(record.runId);
    const [question] = runQuestions(paths, record.runId);
    const done = await sous(paths, ["answer", question!.id, "stop", "--json"]);
    assert.equal(done.code, 0, done.out);
    const reply = JSON.parse(done.out) as Record<string, unknown>;
    assert.deepEqual({ question: reply.question, runId: reply.runId, answered: reply.answered }, { question: question!.id, runId: record.runId, answered: true });
    await stopped(paths, record.runId);
  });
});

describe("answer, approve and send-back replies", () => {
  /** A question of this kind for the run r1, which has no worker, waiting in the inbox. */
  function plant(paths: HomePaths, n: number, extra: Partial<RunQuestion> = {}): RunQuestion {
    const question: RunQuestion = { id: `r1--${n}`, runId: "r1", scope: "r1", callIndex: n, hash: `h${n}`, workflow: "w", prompt: "?", kind: "input", breakpoint: false, askedAt: "2026-11-24T10:00:00.000Z", ...extra };
    writeFileSync(join(paths.inbox, `${question.id}.json`), JSON.stringify(question, null, 2));
    return question;
  }
  const BREAKPOINT: Partial<RunQuestion> = { breakpoint: true, prompt: "Breakpoint: Check\n\nReply approve, stop, or send back with a note." };

  /** The value the answer file holds, or undefined when there is none. */
  const answered = (paths: HomePaths, id: string): unknown => {
    const file = join(paths.inbox, `${id}.answer.json`);
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { value: unknown }).value : undefined;
  };

  /** The JSON reply sous printed, with its notes and next checked. */
  function replyOf(out: string): { notes: string[]; next: Array<{ call: string; does: string }> } & Record<string, unknown> {
    let parsed: unknown;
    assert.doesNotThrow(() => (parsed = JSON.parse(out)), `stdout is not one JSON object:\n${out}`);
    const reply = parsed as Record<string, unknown>;
    assert.ok(reply && typeof reply === "object" && !Array.isArray(reply), out);
    assert.ok(Array.isArray(reply.notes), `notes is an array: ${out}`);
    assert.ok(Array.isArray(reply.next), `next is an array: ${out}`);
    for (const next of reply.next as Array<Record<string, unknown>>) assert.ok(typeof next.call === "string" && typeof next.does === "string", JSON.stringify(next));
    assert.equal("error" in reply, false, out);
    return reply as ReturnType<typeof replyOf>;
  }

  it("sous answer <id> '{\"a\":1}' --value-json passes an object", async () => {
    const { paths } = testHome();
    const question = plant(paths, 0);
    const done = await sous(paths, ["answer", question.id, '{"a":1}', "--value-json"]);
    assert.equal(done.code, 0, done.out);
    assert.deepEqual(answered(paths, question.id), { a: 1 });
  });

  it("sous answer <id> '{\"a\":1}' on an input question passes the text, with a note naming --value-json", async () => {
    const { paths } = testHome();
    const object = plant(paths, 0);
    const asJson = await sous(paths, ["answer", object.id, '{"a":1}', "--json"]);
    assert.equal(asJson.code, 0, asJson.out);
    assert.equal(answered(paths, object.id), '{"a":1}', "the text is the answer, not an object");
    assert.ok(replyOf(asJson.out).notes.some((note) => note.includes("--value-json")), `no note names --value-json: ${asJson.out}`);

    // A list counts too, and the text form prints the note as well.
    const list = plant(paths, 1);
    const asText = await sous(paths, ["answer", list.id, "[1,2]"]);
    assert.equal(asText.code, 0, asText.out);
    assert.equal(answered(paths, list.id), "[1,2]");
    assert.match(asText.out, /^note: .*--value-json/m);

    // Words that do not look like JSON get no such note.
    const words = plant(paths, 2);
    const plain = await sous(paths, ["answer", words.id, "some text", "--json"]);
    assert.equal(plain.code, 0, plain.out);
    assert.equal(answered(paths, words.id), "some text");
    assert.equal(replyOf(plain.out).notes.some((note) => note.includes("--value-json")), false, plain.out);
  });

  it("answer, approve and send-back with --json reply with notes and next, and next resumes a run that does not run", async () => {
    const { paths } = testHome();
    const cases: Array<[string[], Partial<RunQuestion>, unknown]> = [
      [["answer", "blue"], {}, "blue"],
      [["approve"], BREAKPOINT, "approve"],
      [["send-back", "shorter"], BREAKPOINT, { decision: "send back", note: "shorter" }],
    ];
    for (const [n, [[command, ...words], kind, value]] of cases.entries()) {
      const question = plant(paths, n, kind);
      const done = await sous(paths, [command!, question.id, ...words, "--json"]);
      assert.equal(done.code, 0, `${command}: ${done.out}`);
      const reply = replyOf(done.out);
      assert.ok(
        reply.next.some((next) => next.call === "sous resume r1 --json"),
        `${command}: the run does not run, so next resumes it: ${done.out}`,
      );
      assert.deepEqual(answered(paths, question.id), value, command);
    }
  });

  it("sous answer on a breakpoint gives no --value-json note, since the text is a decision", async () => {
    const { paths } = testHome();
    const question = plant(paths, 0, BREAKPOINT);
    const done = await sous(paths, ["answer", question.id, "{shorter}", "--json"]);
    assert.equal(done.code, 0, done.out);
    assert.deepEqual(answered(paths, question.id), { decision: "send back", note: "{shorter}" });
    assert.equal(replyOf(done.out).notes.some((note) => note.includes("--value-json")), false, done.out);
  });

  it("sous answer --value-json with text that is not JSON passes the text and says so", async () => {
    const { paths } = testHome();
    const question = plant(paths, 0);
    const done = await sous(paths, ["answer", question.id, "{not json", "--value-json", "--json"]);
    assert.equal(done.code, 0, done.out);
    assert.equal(answered(paths, question.id), "{not json");
    assert.deepEqual(replyOf(done.out).notes, ["The text is not JSON, so it went as text."]);
    const parsed = plant(paths, 1);
    const fine = await sous(paths, ["answer", parsed.id, "[1]", "--value-json", "--json"]);
    assert.deepEqual(replyOf(fine.out).notes, [], "JSON text gets no note");
  });
});

// Piece 8, questions. The author of a question says who may answer it: people, the default, or
// anyone. An agent's own answer to a people question is refused with question_for_people and the
// call that passes on the person's answer, `--by person`. A breakpoint is always for people. A
// person who starts a run with --let-agent-answer lets agents answer its people questions, never
// its breakpoints. The answer file keeps who answered and through what. sous inbox --json and
// sous wait --json show answeredBy as it stands for the run, so an agent the person let answer
// sees "anyone", and the answer calls an agent gets carry --by person only where it needs it.
//
// The calls pass their env, so the markers of the shell that runs the tests never count. A run
// that asks is paused before the answer, so the answer file stays to read: a running worker
// takes it at once. Each test stops its runs at the end.

describe("piece 8: who may answer", () => {
  const AS_PERSON: NodeJS.ProcessEnv = {};
  const AS_CLAUDE: NodeJS.ProcessEnv = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s1" };
  const CLAUDE_THROUGH = { kind: "agent", program: "claude", session: "s1" };
  const FIXTURES = join(import.meta.dirname, "fixtures", "workflows");
  const fixture = (name: string) => readFileSync(join(FIXTURES, `${name}.js`), "utf8");

  interface Line {
    act: string;
    by: string;
    through: unknown;
    runId?: string;
    question?: string;
    [key: string]: unknown;
  }
  const actions = (paths: HomePaths): Line[] => {
    const file = join(paths.home, "events.jsonl");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Line);
  };
  const json = (printed: { code: number; out: string }): Record<string, any> => {
    let parsed: unknown;
    assert.doesNotThrow(() => (parsed = JSON.parse(printed.out)), `sous printed no JSON object (exit ${printed.code}):\n${printed.out}`);
    return parsed as Record<string, any>;
  };
  const answerFile = (paths: HomePaths, id: string) => join(paths.inbox, `${id}.answer.json`);
  const answerOf = (paths: HomePaths, id: string): Record<string, any> => {
    assert.ok(existsSync(answerFile(paths, id)), `the answer of ${id} is written`);
    return JSON.parse(readFileSync(answerFile(paths, id), "utf8")) as Record<string, any>;
  };
  const calls = (reply: Record<string, any>): string[] => ((reply.next ?? []) as Array<{ call: string }>).map((next) => next.call);
  const answerCallsIn = (reply: Record<string, any>, id: string) => calls(reply).filter((call) => /^sous (answer|approve|send-back) /.test(call) && call.includes(id));

  /** A home with the workflows, workers that run in this process, and a way to stop every run. */
  function world(...names: string[]) {
    const home = testHome(Object.fromEntries(names.map((name) => [name, fixture(name)])));
    // sous has run in this project before, so piece 9's seed approved its workflows as they are.
    rememberProject(home.paths, home.projectDir);
    const workers = inProcess({ inner: runner, handleSignals: true });
    const call = (env: NodeJS.ProcessEnv, argv: string[]) => sous(home.paths, argv, { env, launch: workers.launch });
    const start = async (env: NodeJS.ProcessEnv, name: string, ...flags: string[]) => {
      const printed = await call(env, ["run", name, ...flags, "--json", "--project", home.projectDir]);
      assert.equal(printed.code, 0, printed.out);
      const runId = json(printed).runId as string;
      await waitFor(() => runQuestions(home.paths, runId).length > 0, "the run to ask");
      return { runId, id: runQuestions(home.paths, runId)[0]!.id };
    };
    /** Pause the run at its question, so an answer stays in its file. */
    const pause = async (runId: string) => {
      const paused = await call(AS_PERSON, ["pause", runId, "--json"]);
      assert.equal(paused.code, 0, paused.out);
      assert.equal((await workers.ended(runId))?.status, "paused");
    };
    const stopAll = async () => {
      for (const runId of new Set(workers.launched.map((launch) => launch.runId))) {
        await call(AS_PERSON, ["stop", runId, "--json"]);
        await workers.ended(runId).catch(() => undefined);
      }
    };
    return { ...home, workers, call, start, pause, stopAll };
  }

  it("asks: an agent's answer exits 66 with question_for_people and the --by person call, and writes nothing", async () => {
    const w = world("asks");
    try {
      const { runId, id } = await w.start(AS_PERSON, "asks");
      await w.pause(runId);
      const before = actions(w.paths).length;
      const refused = await w.call(AS_CLAUDE, ["answer", id, "blue", "--json"]);
      assert.equal(refused.code, 66, refused.out);
      const { error } = json(refused);
      assert.equal(error?.code, "question_for_people", refused.out);
      assert.match(error.message, new RegExp(`${id}.*person`), refused.out);
      assert.ok(error.change, refused.out);
      assert.ok(String(error.call).startsWith(`sous answer ${id} <red|blue>`), `the call answers with one of the choices: ${error.call}`);
      assert.ok(String(error.call).includes("--by person"), `the call passes on the person's choice: ${error.call}`);
      assert.ok(String(error.call).endsWith(" --json"), `the call has --json: ${error.call}`);
      assert.equal(existsSync(answerFile(w.paths, id)), false, "no answer is written");
      assert.equal(actions(w.paths).length, before, "a refused answer adds no line");
    } finally {
      await w.stopAll();
    }
  });

  it("asks: with --by person the agent passes on the person's answer, the file keeps by person and the agent through, and events.jsonl has one answer line", async () => {
    const w = world("asks");
    try {
      const { runId, id } = await w.start(AS_PERSON, "asks");
      await w.pause(runId);
      await w.call(AS_CLAUDE, ["answer", id, "blue", "--json"]);
      const passed = await w.call(AS_CLAUDE, ["answer", id, "blue", "--by", "person", "--json"]);
      assert.equal(passed.code, 0, passed.out);
      const reply = json(passed);
      assert.equal(reply.by, "person", passed.out);
      assert.deepEqual(reply.through, CLAUDE_THROUGH, passed.out);
      const answer = answerOf(w.paths, id);
      assert.equal(answer.value, "blue");
      assert.equal(answer.by, "person", JSON.stringify(answer));
      assert.deepEqual(answer.through, CLAUDE_THROUGH, JSON.stringify(answer));
      const answers = actions(w.paths).filter((line) => line.act === "answer");
      assert.equal(answers.length, 1, JSON.stringify(answers));
      assert.equal(answers[0]!.question, id);
      assert.equal(answers[0]!.by, "person");
    } finally {
      await w.stopAll();
    }
  });

  it("asks: inbox and wait show an agent answeredBy people and the answer call with --by person, and show the person no --by person", async () => {
    const w = world("asks");
    try {
      const { runId, id } = await w.start(AS_PERSON, "asks");
      const inbox = await w.call(AS_CLAUDE, ["inbox", "--json"]);
      assert.equal(inbox.code, 0, inbox.out);
      const listed = (json(inbox).questions as Array<Record<string, unknown>>).find((q) => q.id === id);
      assert.equal(listed?.answeredBy, "people", inbox.out);

      const waited = await w.call(AS_CLAUDE, ["wait", runId, "--timeout", "1", "--json"]);
      assert.equal(waited.code, 4, waited.out);
      const reply = json(waited);
      assert.equal(reply.questions?.[0]?.answeredBy, "people", waited.out);
      const agentCalls = answerCallsIn(reply, id);
      assert.ok(agentCalls.some((call) => call.startsWith(`sous answer ${id} <red|blue>`) && call.includes("--by person") && call.endsWith(" --json")), JSON.stringify(reply.next));

      const personWaited = await w.call(AS_PERSON, ["wait", runId, "--timeout", "1", "--json"]);
      assert.equal(personWaited.code, 4, personWaited.out);
      const personCalls = answerCallsIn(json(personWaited), id);
      assert.ok(personCalls.length > 0, personWaited.out);
      for (const call of personCalls) assert.equal(call.includes("--by person"), false, `the person needs no --by person: ${call}`);
    } finally {
      await w.stopAll();
    }
  });

  it("asks-anyone: inbox and wait show answeredBy anyone with no --by person, and an agent's answer exits 0 with by agent", async () => {
    const w = world("asks-anyone");
    try {
      const { runId, id } = await w.start(AS_PERSON, "asks-anyone");
      const inbox = await w.call(AS_CLAUDE, ["inbox", "--json"]);
      const listed = (json(inbox).questions as Array<Record<string, unknown>>).find((q) => q.id === id);
      assert.equal(listed?.answeredBy, "anyone", inbox.out);
      const waited = await w.call(AS_CLAUDE, ["wait", runId, "--timeout", "1", "--json"]);
      assert.equal(waited.code, 4, waited.out);
      const reply = json(waited);
      assert.equal(reply.questions?.[0]?.answeredBy, "anyone", waited.out);
      const agentCalls = answerCallsIn(reply, id);
      assert.ok(agentCalls.some((call) => call.startsWith(`sous answer ${id} <red|blue>`)), JSON.stringify(reply.next));
      for (const call of agentCalls) assert.equal(call.includes("--by person"), false, `an agent may answer, so no --by person: ${call}`);

      await w.pause(runId);
      const answered = await w.call(AS_CLAUDE, ["answer", id, "blue", "--json"]);
      assert.equal(answered.code, 0, answered.out);
      assert.equal(json(answered).by, "agent", answered.out);
      const answer = answerOf(w.paths, id);
      assert.equal(answer.value, "blue");
      assert.equal(answer.by, "agent", JSON.stringify(answer));
      assert.deepEqual(answer.through, CLAUDE_THROUGH, JSON.stringify(answer));
    } finally {
      await w.stopAll();
    }
  });

  it("review: an agent's approve and send-back exit 66 with question_for_people, and --by person approves", async () => {
    const w = world("review");
    try {
      const { runId, id } = await w.start(AS_PERSON, "review");
      await w.pause(runId);
      const before = actions(w.paths).length;
      for (const argv of [["approve", id], ["send-back", id, "shorter"]]) {
        const refused = await w.call(AS_CLAUDE, [...argv, "--json"]);
        assert.equal(refused.code, 66, refused.out);
        const { error } = json(refused);
        assert.equal(error?.code, "question_for_people", refused.out);
        for (const verb of ["approve", "send-back", "stop"]) assert.match(error.change, new RegExp(verb), `the change names ${verb}: ${refused.out}`);
        assert.ok(String(error.call).includes(id) && String(error.call).includes("--by person"), refused.out);
      }
      assert.equal(existsSync(answerFile(w.paths, id)), false, "no answer is written");
      assert.equal(actions(w.paths).length, before);
      const approved = await w.call(AS_CLAUDE, ["approve", id, "--by", "person", "--json"]);
      assert.equal(approved.code, 0, approved.out);
      assert.equal(answerOf(w.paths, id).by, "person");
    } finally {
      await w.stopAll();
    }
  });

  it("review: an agent's refused decision gets back the call for the same decision, with --by person", async () => {
    const w = world("review");
    try {
      const { runId, id } = await w.start(AS_PERSON, "review");
      await w.pause(runId);
      const tries: Array<[string[], string]> = [
        [["approve", id], `sous approve ${id} --by person --json`],
        [["send-back", id, "make", "it", "shorter"], `sous send-back ${id} "make it shorter" --by person --json`],
        [["answer", id, "send", "back:", "shorter"], `sous send-back ${id} "shorter" --by person --json`],
        [["answer", id, "stop"], `sous stop ${runId} --json`],
      ];
      for (const [argv, call] of tries) {
        const refused = await w.call(AS_CLAUDE, [...argv, "--json"]);
        assert.equal(refused.code, 66, refused.out);
        assert.equal(json(refused).error?.code, "question_for_people", refused.out);
        assert.equal(json(refused).error?.call, call, refused.out);
      }
      assert.equal(existsSync(answerFile(w.paths, id)), false, "no answer is written");
    } finally {
      await w.stopAll();
    }
  });

  it("asks: a step of a run that waits on a question for people gets no answer call, and its answer is refused with no call", async () => {
    const w = world("asks");
    try {
      const { runId, id } = await w.start(AS_PERSON, "asks");
      const AS_STEP: NodeJS.ProcessEnv = { SOUS_RUN_ID: "other-run" };
      const waited = await w.call(AS_STEP, ["wait", runId, "--timeout", "1", "--json"]);
      assert.equal(waited.code, 4, waited.out);
      assert.equal(json(waited).questions?.[0]?.answeredBy, "people", waited.out);
      assert.deepEqual(answerCallsIn(json(waited), id), [], `the step gets no answer call: ${waited.out}`);
      assert.ok(calls(json(waited)).some((call) => call.startsWith(`sous wait ${runId}`)), `the step can wait again: ${waited.out}`);
      const inbox = await w.call(AS_STEP, ["inbox", "--json"]);
      assert.deepEqual(answerCallsIn(json(inbox), id), [], `the inbox gives the step no answer call: ${inbox.out}`);

      await w.pause(runId);
      const refused = await w.call(AS_STEP, ["answer", id, "blue", "--json"]);
      assert.equal(refused.code, 66, refused.out);
      const { error } = json(refused);
      assert.equal(error?.code, "question_for_people", refused.out);
      assert.equal(error.call, null, refused.out);
      assert.equal(error.change, "Only the person answers this. The run waits for them.", refused.out);
      assert.equal(existsSync(answerFile(w.paths, id)), false, "no answer is written");
    } finally {
      await w.stopAll();
    }
  });

  it("run asks --let-agent-answer from an agent without --by person exits 66 with needs_person, and starts nothing", async () => {
    const w = world("asks");
    try {
      const refused = await w.call(AS_CLAUDE, ["run", "asks", "--let-agent-answer", "--json", "--project", w.projectDir]);
      assert.equal(refused.code, 66, refused.out);
      const { error } = json(refused);
      assert.equal(error?.code, "needs_person", refused.out);
      assert.ok(error.change, refused.out);
      const call = String(error.call);
      assert.ok(call.startsWith("sous run asks"), `the call is the same run: ${call}`);
      assert.ok(call.includes("--let-agent-answer") && call.includes("--by person") && call.includes("--json"), call);
      assert.equal(w.workers.launched.length, 0, "no run starts");
      assert.deepEqual(listRecords(w.paths), []);
      assert.deepEqual(actions(w.paths), []);
    } finally {
      await w.stopAll();
    }
  });

  it("run asks --let-agent-answer --by person keeps letAgentAnswer on the record, adds a let-agent-answer line, and the agent answers as itself", async () => {
    const w = world("asks");
    try {
      const { runId, id } = await w.start(AS_CLAUDE, "asks", "--let-agent-answer", "--by", "person");
      const record = loadRecord(w.paths, runId) as unknown as Record<string, any>;
      assert.equal(record.letAgentAnswer?.by, "person", JSON.stringify(record.letAgentAnswer));
      assert.deepEqual(record.letAgentAnswer?.through, CLAUDE_THROUGH);
      assert.ok(Math.abs(Date.now() - Date.parse(record.letAgentAnswer?.at)) < 60_000, JSON.stringify(record.letAgentAnswer));
      const lines = actions(w.paths);
      assert.deepEqual(lines.map((line) => [line.act, line.runId]), [["run", runId], ["let-agent-answer", runId]], JSON.stringify(lines));
      assert.equal(lines[1]!.by, "person");

      const waited = await w.call(AS_CLAUDE, ["wait", runId, "--timeout", "1", "--json"]);
      assert.equal(waited.code, 4, waited.out);
      const reply = json(waited);
      assert.equal(reply.questions?.[0]?.answeredBy, "anyone", `the person let agents answer: ${waited.out}`);
      for (const call of answerCallsIn(reply, id)) assert.equal(call.includes("--by person"), false, call);

      await w.pause(runId);
      const answered = await w.call(AS_CLAUDE, ["answer", id, "red", "--json"]);
      assert.equal(answered.code, 0, answered.out);
      const answer = answerOf(w.paths, id);
      assert.equal(answer.by, "agent", JSON.stringify(answer));
      assert.deepEqual(answer.through, CLAUDE_THROUGH);
    } finally {
      await w.stopAll();
    }
  });

  it("a person's own run --let-agent-answer needs no --by person", async () => {
    const w = world("asks");
    try {
      const { runId } = await w.start(AS_PERSON, "asks", "--let-agent-answer");
      const record = loadRecord(w.paths, runId) as unknown as Record<string, any>;
      assert.equal(record.letAgentAnswer?.by, "person", JSON.stringify(record));
      assert.deepEqual(record.letAgentAnswer?.through, { kind: "person" });
    } finally {
      await w.stopAll();
    }
  });

  it("review --let-agent-answer: the breakpoint stays with people, and an agent's approve exits 66", async () => {
    const w = world("review");
    try {
      const { runId, id } = await w.start(AS_PERSON, "review", "--let-agent-answer");
      assert.ok((loadRecord(w.paths, runId) as unknown as Record<string, any>).letAgentAnswer, "the record keeps letAgentAnswer");
      const waited = await w.call(AS_CLAUDE, ["wait", runId, "--timeout", "1", "--json"]);
      assert.equal(json(waited).questions?.[0]?.answeredBy, "people", waited.out);
      await w.pause(runId);
      const refused = await w.call(AS_CLAUDE, ["approve", id, "--json"]);
      assert.equal(refused.code, 66, refused.out);
      assert.equal(json(refused).error?.code, "question_for_people", refused.out);
      assert.equal(existsSync(answerFile(w.paths, id)), false);
    } finally {
      await w.stopAll();
    }
  });

  it("rerun and resume take --let-agent-answer too, and a rerun without it does not carry it", async () => {
    const w = world("asks");
    try {
      const { runId } = await w.start(AS_PERSON, "asks", "--let-agent-answer");
      await w.pause(runId);

      const plain = await w.call(AS_PERSON, ["rerun", runId, "--json"]);
      assert.equal(plain.code, 0, plain.out);
      const plainId = json(plain).runId as string;
      assert.equal((loadRecord(w.paths, plainId) as unknown as Record<string, any>).letAgentAnswer, undefined, "a rerun without the flag lets no agent answer");
      await waitFor(() => runQuestions(w.paths, plainId).length > 0, "the rerun to ask");
      await w.pause(plainId);

      const refused = await w.call(AS_CLAUDE, ["rerun", plainId, "--let-agent-answer", "--json"]);
      assert.equal(refused.code, 66, refused.out);
      assert.equal(json(refused).error?.code, "needs_person", refused.out);

      const resumed = await w.call(AS_CLAUDE, ["resume", plainId, "--let-agent-answer", "--by", "person", "--json"]);
      assert.equal(resumed.code, 0, resumed.out);
      assert.equal((loadRecord(w.paths, plainId) as unknown as Record<string, any>).letAgentAnswer?.by, "person", "resume with the flag lets agents answer");

      const again = await w.call(AS_CLAUDE, ["rerun", plainId, "--let-agent-answer", "--by", "person", "--json"]);
      assert.equal(again.code, 0, again.out);
      assert.equal((loadRecord(w.paths, json(again).runId as string) as unknown as Record<string, any>).letAgentAnswer?.by, "person");
    } finally {
      await w.stopAll();
    }
  });
});
