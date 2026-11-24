import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { logFile, runQuestions, startRun, type HomePaths, type RunQuestion } from "@sous/engine";
import { inProcess, testHome, type InnerRunner } from "@sous/engine/testing";
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
    const record = startRun(paths, workers.launch, { workflow: "four", projectDir, inputs: {} });
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
      [color, name, ship, plan].map((q) => [0, `answered ${n(q)}\n`]),
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
  const not = (id: string) => `answered ${id}. The run is not running: sous resume r1 uses the answer.\n`;
  // [kind, command and its words, exit code, what sous prints, the answer's value or none]
  const cases: Array<[string, string[], number, (id: string) => string, unknown?]> = [
    ["confirm", ["answer", "yes"], 0, not, true],
    ["confirm", ["answer", "no"], 0, not, false],
    ["confirm", ["answer", "ok"], 0, not, true],
    ["confirm", ["answer", "maybe"], 64, (id) => `usage: answer yes or no\n  change: Answer with one of the choices.\n  try: sous answer ${id} <yes|no> --json\n`],
    ["confirm", ["answer"], 64, (id) => `usage: answer yes or no\n  change: Answer with one of the choices.\n  try: sous answer ${id} <yes|no> --json\n`],
    ["confirm", ["approve"], 0, not, true],
    ["confirm", ["send-back", "shorter"], 64, (id) => `usage: ${id} is not a breakpoint. Use sous answer ${id} "..."\n  change: Fix the command line. sous help lists the commands and their flags.\n`],
    ["select", ["answer", "blue"], 0, not, "Blue"],
    ["select", ["answer", "green"], 64, (id) => `usage: answer one of: Red, Blue\n  change: Answer with one of the choices.\n  try: sous answer ${id} <Red|Blue> --json\n`],
    [
      "select",
      ["answer", "--json", '"green"'],
      64,
      (id) => `${JSON.stringify({ error: { code: "not_a_choice", message: "answer one of: Red, Blue", change: "Answer with one of the choices.", call: `sous answer ${id} <Red|Blue> --json` } }, null, 2)}\n`,
    ],
    // --value-json reads the words as JSON. --json alone asks for a JSON reply, as on every command.
    ["select", ["answer", "--value-json", '"Blue"'], 0, not, "Blue"],
    ["select", ["answer", "--value-json", '"green"'], 64, (id) => `usage: answer one of: Red, Blue\n  change: Answer with one of the choices.\n  try: sous answer ${id} <Red|Blue> --json\n`],
    ["select", ["answer"], 64, (id) => `usage: sous answer ${id} "your answer"\n  change: Fix the command line. sous help lists the commands and their flags.\n`],
    ["select", ["approve"], 0, not, "approve"],
    ["input", ["answer"], 64, (id) => `usage: sous answer ${id} "your answer"\n  change: Fix the command line. sous help lists the commands and their flags.\n`],
    ["input", ["answer", "some", "text"], 0, not, "some text"],
    ["input", ["answer", "  padded "], 0, not, "  padded "],
    ["input", ["answer", "--value-json", '{"a":1}'], 0, not, { a: 1 }],
    ["input", ["answer", "--value-json", "not json"], 0, (id) => `${not(id)}note: The text is not JSON, so it went as text.\n`, "not json"],
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
    assert.equal(text, `{\n  "hash": "h0",\n  "value": "blue",\n  "answeredAt": "${answeredAt}"\n}\n`);
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
    const record = startRun(paths, workers.launch, { workflow: "each", projectDir, inputs: {} });
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
    const record = startRun(paths, workers.launch, { workflow: "each", projectDir, inputs: {} });
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
    const record = startRun(paths, workers.launch, { workflow: "each", projectDir, inputs: {} });
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
    const record = startRun(paths, workers.launch, { workflow: "checked", projectDir, inputs: {} });
    const [question] = await asked(paths, record.runId, 1);
    assert.deepEqual(await sous(paths, ["answer", question!.id, "Stop"]), { code: 0, out: `stopping ${record.runId}\n` });
    assert.equal((await workers.ended(record.runId))?.status, "aborted");
    await stopped(paths, record.runId);
  });

  it("sous answer <q> stop stops a paused run at once, as sous stop does", async () => {
    const { paths, projectDir } = testHome({ held });
    const workers = inProcess({ inner: runner });
    const record = startRun(paths, workers.launch, { workflow: "held", projectDir, inputs: {} });
    const paused = await workers.ended(record.runId);
    assert.equal(paused?.status, "paused");
    const [question] = runQuestions(paths, record.runId);
    assert.deepEqual(await sous(paths, ["answer", question!.id, "stop"]), { code: 0, out: `stopped ${record.runId}\n` });
    await stopped(paths, record.runId);
  });

  it("sous answer <q> stop --json replies with the keys of any answer, answered true", async () => {
    const { paths, projectDir } = testHome({ held });
    const workers = inProcess({ inner: runner });
    const record = startRun(paths, workers.launch, { workflow: "held", projectDir, inputs: {} });
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
