import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { logFile, saveSchedules, type HomePaths, type RunQuestion } from "@sous/engine";
import { fakeRunner, inProcess, plantState, testHome } from "@sous/engine/testing";
import { Usage } from "../src/args.js";
import { main, type MainOptions } from "../src/cli.js";
import type { Machine } from "../src/commands/index.js";
import { capture } from "./sous.js";

// Piece 2, replies and errors. Every --json reply is one object with notes and next arrays, and an
// error is {"error": {code, message, change, call}} with the exit codes 64, 65 and 66. The parts
// are loaded inside each test, so a missing reply.ts or Refusal fails that test alone.

const replyModule = () => import("../src/reply.js");

/** The engine index, with the Refusal it must export. */
async function engineRefusal() {
  const engine = (await import("@sous/engine")) as Record<string, unknown>;
  assert.equal(typeof engine.Refusal, "function", "the engine index exports Refusal");
  return engine as unknown as typeof import("@sous/engine");
}

/** What one sous command printed, apart: stdout and stderr. */
interface Called {
  code: number;
  stdout: string;
  stderr: string;
}

/** A machine that keeps what sous prints, and never asks or starts the service. */
function printer(stdout: string[], stderr: string[]): Machine {
  const no = () => {
    throw new Error("this test's machine does not do that");
  };
  return {
    readText: (file) => readFileSync(file, "utf8"),
    exists: (file) => existsSync(file),
    guideDir: "",
    skillDir: "",
    spawnDaemon: no,
    kill: no,
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    isTerminal: false,
    ask: no,
    out: (line) => stdout.push(`${line}\n`),
    write: (text) => stdout.push(text),
    err: (line) => stderr.push(`${line}\n`),
  };
}

/** Run sous's main on this home. What goes to process.stdout and stderr is kept too, apart. */
async function call(paths: HomePaths, argv: string[], options: Omit<MainOptions, "machine"> = {}): Promise<Called> {
  const before = process.env.SOUS_HOME;
  process.env.SOUS_HOME = paths.home;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  const writeErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => (typeof chunk === "string" ? (stdout.push(chunk), true) : (write as (...args: unknown[]) => boolean)(chunk, ...rest))) as typeof write;
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => (typeof chunk === "string" ? (stderr.push(chunk), true) : (writeErr as (...args: unknown[]) => boolean)(chunk, ...rest))) as typeof writeErr;
  try {
    const code = await main(argv, { ...options, machine: printer(stdout, stderr) });
    return { code, stdout: stdout.join(""), stderr: stderr.join("") };
  } finally {
    process.stdout.write = write;
    process.stderr.write = writeErr;
    if (before === undefined) delete process.env.SOUS_HOME;
    else process.env.SOUS_HOME = before;
  }
}

/** The JSON reply on stdout, with its notes and next checked. */
function replyOf(called: Called): Record<string, unknown> {
  let parsed: unknown;
  assert.doesNotThrow(() => (parsed = JSON.parse(called.stdout)), `stdout is not one JSON object:\n${called.stdout}\nstderr:\n${called.stderr}`);
  assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed), `the reply is one object, not ${JSON.stringify(parsed)?.slice(0, 200)}`);
  const reply = parsed as Record<string, unknown>;
  assert.ok(Array.isArray(reply.notes), `notes is an array: ${JSON.stringify(reply.notes)}`);
  for (const note of reply.notes as unknown[]) assert.equal(typeof note, "string", `each note is a string: ${JSON.stringify(note)}`);
  assert.ok(Array.isArray(reply.next), `next is an array: ${JSON.stringify(reply.next)}`);
  for (const next of reply.next as unknown[]) {
    const entry = next as Record<string, unknown>;
    assert.equal(typeof entry.call, "string", `each next has a call: ${JSON.stringify(next)}`);
    assert.equal(typeof entry.does, "string", `each next says what it does: ${JSON.stringify(next)}`);
  }
  assert.equal("error" in reply, false, "a reply has no error");
  return reply;
}

interface ErrorBody {
  code: string;
  message: string;
  change: string;
  call: string | null;
  forPerson?: string;
}

/** The JSON error on stdout, with its shape checked. */
function errorOf(called: Called): ErrorBody {
  let parsed: unknown;
  assert.doesNotThrow(() => (parsed = JSON.parse(called.stdout)), `stdout is not one JSON object:\n${called.stdout}\nstderr:\n${called.stderr}`);
  const body = parsed as { error?: Record<string, unknown> };
  assert.deepEqual(Object.keys(body), ["error"], `an error is {"error": {...}} alone: ${called.stdout}`);
  const error = body.error!;
  assert.equal(typeof error.code, "string");
  assert.equal(typeof error.message, "string");
  assert.equal(typeof error.change, "string");
  assert.ok(error.call === null || typeof error.call === "string", `call is a string or null: ${JSON.stringify(error.call)}`);
  assert.ok("call" in error, "call is there, even when null");
  return error as unknown as ErrorBody;
}

const ONE = `export const meta = { name: 'one', description: 'one step' }
return await agent('go', { label: 'go' })`;

/** A select question with the choices red and blue, waiting in the inbox. */
function colorQuestion(paths: HomePaths, runId = "r1"): RunQuestion {
  const question: RunQuestion = { id: `${runId}--0`, runId, scope: runId, callIndex: 0, hash: "h0", workflow: "w", prompt: "Which color?", kind: "select", choices: ["red", "blue"], breakpoint: false, askedAt: "2026-11-24T04:05:25.000Z" };
  writeFileSync(join(paths.inbox, `${question.id}.json`), JSON.stringify(question, null, 2));
  return question;
}

/** A finished run's record and state, written as the worker leaves them, `minutesAgo` old. */
function plantDone(paths: HomePaths, projectDir: string, runId: string, minutesAgo = 1): void {
  const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  writeFileSync(
    join(paths.records, `${runId}.json`),
    JSON.stringify({ runId, workflow: "one", file: join(projectDir, ".sous", "workflows", "one.js"), args: {}, place: "folder", cwd: projectDir, projectDir, priority: "user", origin: "cli", createdAt: at }),
  );
  plantState(paths, { runId, workflowName: "one", script: "return 1", status: "completed", result: "done", phases: [], agents: [], logs: [], startedAt: at, updatedAt: at, completedAt: at });
}

describe("reply.ts", () => {
  it("reply fills notes, next, exit and text, and print renders the JSON form as {...data, notes, next}", async () => {
    const { reply, print } = await replyModule();
    const plain = reply({ runId: "r1" });
    assert.deepEqual({ next: plain.next, notes: plain.notes, exit: plain.exit, text: plain.text }, { next: [], notes: [], exit: 0, text: [] });

    const lines: string[] = [];
    const full = reply({ runId: "r1", status: "paused" }, { notes: ["a note"], next: [{ call: "sous resume r1 --json", does: "goes on" }], exit: 2, text: ["r1 paused"] });
    assert.equal(print(full, true, (line) => lines.push(line)), 2, "print returns the reply's exit");
    assert.deepEqual(JSON.parse(lines.join("\n")), { runId: "r1", status: "paused", notes: ["a note"], next: [{ call: "sous resume r1 --json", does: "goes on" }] });

    const empty: string[] = [];
    assert.equal(print(plain, true, (line) => empty.push(line)), 0);
    assert.deepEqual(JSON.parse(empty.join("\n")), { runId: "r1", notes: [], next: [] }, "notes and next are there even when empty");
  });

  it("print renders the text form: the text, then each note, then each next", async () => {
    const { reply, print } = await replyModule();
    const lines: string[] = [];
    const r = reply({ runId: "r1" }, { text: ["r1 paused", "  at step go"], notes: ["one", "two"], next: [{ call: "sous resume r1", does: "goes on" }], exit: 2 });
    assert.equal(print(r, false, (line) => lines.push(line)), 2);
    assert.deepEqual(lines, ["r1 paused", "  at step go", "note: one", "note: two", "next: sous resume r1  (goes on)"]);
  });

  it("reply throws when data has a key named notes, next or error", async () => {
    const { reply } = await replyModule();
    assert.throws(() => reply({ next: 1 }));
    assert.throws(() => reply({ notes: [] }));
    assert.throws(() => reply({ error: "x" }));
  });

  it("cut keeps the first max items and names the flag that shows more, and adds no note when all fit", async () => {
    const { cut } = await replyModule();
    const items = Array.from({ length: 30 }, (_, i) => i);
    const cutDown = cut(items, 20, "--all", "runs");
    assert.deepEqual(cutDown.items, items.slice(0, 20));
    assert.match(cutDown.note ?? "", /--all/);
    const fits = cut(items.slice(0, 5), 20, "--all", "runs");
    assert.deepEqual(fits.items, items.slice(0, 5));
    assert.equal(fits.note, undefined);
  });

  it("printError gives exit 65 for a missing thing and 66 for any other refusal, in the error shape", async () => {
    const { printError } = await replyModule();
    const { Refusal } = await engineRefusal();
    const lines: string[] = [];
    const missing = new Refusal("no_such_run", 'no run "nosuch".', "Give the id of a run.", "sous status --json");
    assert.equal(printError(missing, true, (line) => lines.push(line)), 65);
    assert.deepEqual(JSON.parse(lines.join("\n")), { error: { code: "no_such_run", message: 'no run "nosuch".', change: "Give the id of a run.", call: "sous status --json" } });

    const refused: string[] = [];
    const busy = new Refusal("run_is_running", "r1 is running.", "Stop it first.", "sous stop r1");
    assert.equal(printError(busy, true, (line) => refused.push(line)), 66);
    assert.equal(JSON.parse(refused.join("\n")).error.code, "run_is_running");
  });

  it("printError shows forPerson only on started_by_people, with a null call", async () => {
    const { printError } = await replyModule();
    const { Refusal } = await engineRefusal();
    const lines: string[] = [];
    const people = new Refusal("started_by_people", '"deploy" starts only when a person types the command.', "Give the person the command below.", null, "sous run deploy --env prod");
    assert.equal(printError(people, true, (line) => lines.push(line)), 66);
    assert.deepEqual(JSON.parse(lines.join("\n")), {
      error: { code: "started_by_people", message: '"deploy" starts only when a person types the command.', change: "Give the person the command below.", call: null, forPerson: "sous run deploy --env prod" },
    });
  });

  it("printError in text writes the message, then change:, then try: when there is a call", async () => {
    const { printError } = await replyModule();
    const { Refusal } = await engineRefusal();
    const lines: string[] = [];
    printError(new Refusal("no_such_run", 'no run "nosuch".', "Give the id of a run.", "sous status --json"), false, (line) => lines.push(line));
    assert.deepEqual(lines, ['no run "nosuch".', "  change: Give the id of a run.", "  try: sous status --json"]);

    const noCall: string[] = [];
    printError(new Refusal("no_person_here", "a step of a run is no person.", "Ask the person outside the run.", null), false, (line) => noCall.push(line));
    assert.deepEqual(noCall, ["a step of a run is no person.", "  change: Ask the person outside the run."]);
  });

  it("printError gives exit 64 and bad_argument for a usage error, and exit 1 and internal for a sous fault", async () => {
    const { printError } = await replyModule();
    const usage: string[] = [];
    assert.equal(printError(new Usage("give a run id (sous list shows them)"), true, (line) => usage.push(line)), 64);
    const bad = JSON.parse(usage.join("\n")).error;
    assert.equal(bad.code, "bad_argument");
    assert.equal(bad.message, "give a run id (sous list shows them)");
    assert.equal(typeof bad.change, "string");
    assert.ok("call" in bad);

    const fault: string[] = [];
    assert.equal(printError(new Error("EACCES: permission denied"), true, (line) => fault.push(line)), 1);
    assert.equal(JSON.parse(fault.join("\n")).error.code, "internal");

    // The text of a fault stays one line.
    const text: string[] = [];
    printError(new Error("boom"), false, (line) => text.push(line));
    assert.deepEqual(text, ["sous: boom"]);
  });
});

describe("Refusal", () => {
  it("keeps its code, message, change and call, and is an Error", async () => {
    const { Refusal } = await engineRefusal();
    const refusal = new Refusal("run_is_running", "r1 is running.", "Stop it first.", "sous stop r1");
    assert.ok(refusal instanceof Error);
    assert.deepEqual([refusal.code, refusal.message, refusal.change, refusal.call, refusal.forPerson], ["run_is_running", "r1 is running.", "Stop it first.", "sous stop r1", undefined]);
  });

  it("is missing for the no_such codes and step_not_running, and for no other code", async () => {
    const { Refusal } = await engineRefusal();
    const missing = ["no_such_run", "no_such_workflow", "no_such_question", "no_such_step", "step_not_running"] as const;
    const refused = ["started_by_people", "not_approved", "question_for_people", "needs_person", "no_person_here", "step_takes_no_message", "turn_not_steerable", "run_is_running", "cannot_resume", "not_ours"] as const;
    for (const code of missing) assert.equal(new Refusal(code, "m", "c", null).missing, true, code);
    for (const code of refused) assert.equal(new Refusal(code, "m", "c", null).missing, false, code);
  });
});

describe("errors through sous", () => {
  it("sous show nosuch --json exits 65 with no_such_run and the call sous status --json", async () => {
    const { paths } = testHome();
    const shown = await call(paths, ["show", "nosuch", "--json"]);
    assert.equal(shown.code, 65, shown.stdout + shown.stderr);
    const error = errorOf(shown);
    assert.equal(error.code, "no_such_run");
    assert.equal(error.call, "sous status --json");
    assert.match(error.message, /nosuch/);
    assert.equal("forPerson" in error, false);
  });

  it("sous show nosuch without --json prints the message, change: and try: on stderr, and nothing on stdout", async () => {
    const { paths } = testHome();
    const shown = await call(paths, ["show", "nosuch"]);
    assert.equal(shown.code, 65);
    assert.equal(shown.stdout, "");
    const lines = shown.stderr.trimEnd().split("\n");
    assert.match(lines[0]!, /nosuch/);
    assert.ok(lines.some((line) => line.startsWith("  change: ")), shown.stderr);
    assert.ok(lines.includes("  try: sous status --json"), shown.stderr);
  });

  it("sous answer <id> green --json on a red or blue question exits 64 with not_a_choice and the call listing red|blue", async () => {
    const { paths } = testHome();
    const question = colorQuestion(paths);
    const answered = await call(paths, ["answer", question.id, "green", "--json"]);
    assert.equal(answered.code, 64, answered.stdout + answered.stderr);
    const error = errorOf(answered);
    assert.equal(error.code, "not_a_choice");
    assert.match(error.call ?? "", new RegExp(`^sous answer ${question.id} <red\\|blue> --json$`));
    assert.equal(existsSync(join(paths.inbox, `${question.id}.answer.json`)), false, "no answer is written");
  });

  it("sous answer <id> green without --json exits 64 and prints change: and try: on stderr", async () => {
    const { paths } = testHome();
    const question = colorQuestion(paths);
    const answered = await call(paths, ["answer", question.id, "green"]);
    assert.equal(answered.code, 64, answered.stdout + answered.stderr);
    assert.equal(answered.stdout, "");
    const lines = answered.stderr.trimEnd().split("\n");
    assert.ok(lines.some((line) => line.startsWith("  change: ")), answered.stderr);
    assert.ok(lines.some((line) => line === `  try: sous answer ${question.id} <red|blue> --json`), answered.stderr);
  });

  it("sous answer on a question that is gone exits 65 with no_such_question", async () => {
    const { paths } = testHome();
    const gone = await call(paths, ["answer", "nosuch--3", "red", "--json"]);
    assert.equal(gone.code, 65, gone.stdout + gone.stderr);
    const error = errorOf(gone);
    assert.equal(error.code, "no_such_question");
    assert.equal(typeof error.call, "string");
  });

  it("sous run of a workflow that does not exist exits 65 with no_such_workflow and the call sous workflows --json, with the command's --project", async () => {
    const { paths, projectDir } = testHome({ one: ONE });
    const workers = inProcess({ inner: fakeRunner(() => "done").runner });
    const run = await call(paths, ["run", "nosuch", "--json", "--project", projectDir], { launch: workers.launch });
    assert.equal(run.code, 65, run.stdout + run.stderr);
    const error = errorOf(run);
    assert.equal(error.code, "no_such_workflow");
    assert.equal(error.call, `sous workflows --json --project ${projectDir}`);
    assert.equal(workers.launched.length, 0);
  });

  it("sous stop --step on a step the running run lacks exits 65 with no_such_step and the call sous show <run> --json", async () => {
    const { paths, projectDir } = testHome({ one: ONE });
    const runId = "run-live";
    const at = new Date().toISOString();
    // A run whose worker is this process, with no step running.
    writeFileSync(
      join(paths.records, `${runId}.json`),
      JSON.stringify({ runId, workflow: "one", file: join(projectDir, ".sous", "workflows", "one.js"), args: {}, place: "folder", cwd: projectDir, projectDir, priority: "user", origin: "cli", createdAt: at, pid: process.pid }),
    );
    plantState(paths, { runId, workflowName: "one", script: "return 1", status: "running", phases: [], agents: [], logs: [], startedAt: at, updatedAt: at }, "");
    const stopped = await call(paths, ["stop", runId, "--step", "nosuch", "--json"]);
    assert.equal(stopped.code, 65, stopped.stdout + stopped.stderr);
    const error = errorOf(stopped);
    assert.equal(error.code, "no_such_step");
    assert.equal(error.call, `sous show ${runId} --json`);
  });

  it("a usage error with --json exits 64 with bad_argument in the error shape", async () => {
    const { paths } = testHome();
    const shown = await call(paths, ["show", "--json"]);
    assert.equal(shown.code, 64, shown.stdout + shown.stderr);
    assert.equal(errorOf(shown).code, "bad_argument");
  });

  it("a sous fault, such as an unreadable record folder, exits 1 with error.code internal", async () => {
    const { paths } = testHome();
    chmodSync(paths.records, 0o000);
    try {
      const listed = await call(paths, ["list", "--json"]);
      assert.equal(listed.code, 1, listed.stdout + listed.stderr);
      const error = errorOf(listed);
      assert.equal(error.code, "internal");
      assert.equal(error.change, "The command is fine. sous itself failed. Read the message, fix the cause and run the same command again.");
    } finally {
      chmodSync(paths.records, 0o755);
    }
  });

  it("a run prefix that matches two runs exits 65 with no_such_run, names both runs and gives the call sous list --json", async () => {
    const { paths, projectDir } = testHome({ one: ONE });
    plantDone(paths, projectDir, "run-a1");
    plantDone(paths, projectDir, "run-a2");
    const shown = await call(paths, ["show", "run-a", "--json"]);
    assert.equal(shown.code, 65, shown.stdout + shown.stderr);
    const error = errorOf(shown);
    assert.equal(error.code, "no_such_run");
    assert.match(error.message, /matches 2 runs: /);
    assert.match(error.message, /run-a1/);
    assert.match(error.message, /run-a2/);
    assert.equal(error.call, "sous list --json");
  });

  it("sous run of a workflow file that does not parse exits 66 with workflow_invalid, names the file and gives the call sous check", async () => {
    const { paths, projectDir } = testHome({ broken: "export const meta = {" });
    const workers = inProcess({ inner: fakeRunner(() => "done").runner });
    const run = await call(paths, ["run", "broken", "--json", "--project", projectDir], { launch: workers.launch });
    assert.equal(run.code, 66, run.stdout + run.stderr);
    const error = errorOf(run);
    assert.equal(error.code, "workflow_invalid");
    assert.equal(error.change, `Fix the workflow file ${join(projectDir, ".sous", "workflows", "broken.js")}.`);
    assert.equal(error.call, `sous check broken --json --project ${projectDir}`);
    assert.equal(workers.launched.length, 0);
  });

  it("sous run of a workflow whose meta has a problem exits 66 with workflow_invalid, not bad_argument", async () => {
    const { paths, projectDir } = testHome({ late: "export const meta = { name: 'late', description: 'd', timeout: 'never' }\nreturn 1" });
    const workers = inProcess({ inner: fakeRunner(() => "done").runner });
    const run = await call(paths, ["run", "late", "--json", "--project", projectDir], { launch: workers.launch });
    assert.equal(run.code, 66, run.stdout + run.stderr);
    const error = errorOf(run);
    assert.equal(error.code, "workflow_invalid");
    assert.match(error.message, /meta\.timeout/);
    assert.equal(error.change, `Fix the workflow file ${join(projectDir, ".sous", "workflows", "late.js")}.`);
    assert.equal(error.call, `sous check late --json --project ${projectDir}`);
    assert.equal(workers.launched.length, 0);
  });

  it("sous run without a required input exits 64 with bad_argument and the call sous check, and its text has the change and try lines", async () => {
    const { paths, projectDir } = testHome({ needs: "export const meta = { name: 'needs', description: 'd', inputs: { topic: 'what to write about' } }\nreturn 1" });
    const workers = inProcess({ inner: fakeRunner(() => "done").runner });
    const run = await call(paths, ["run", "needs", "--json", "--project", projectDir], { launch: workers.launch });
    assert.equal(run.code, 64, run.stdout + run.stderr);
    const error = errorOf(run);
    assert.equal(error.code, "bad_argument");
    assert.equal(error.call, `sous check needs --json --project ${projectDir}`);

    const text = await call(paths, ["run", "needs", "--project", projectDir], { launch: workers.launch });
    assert.equal(text.code, 64, text.stdout + text.stderr);
    assert.equal(text.stdout, "");
    assert.ok(text.stderr.endsWith(`\n  change: ${error.change}\n  try: sous check needs --json --project ${projectDir}\n`), text.stderr);
    assert.equal(workers.launched.length, 0);
  });

  it("a --json flag with a value still gives the error as JSON", async () => {
    const { paths } = testHome();
    const shown = await call(paths, ["show", "--json=1", "nosuch"]);
    assert.equal(shown.code, 65, shown.stdout + shown.stderr);
    assert.equal(shown.stderr, "");
    assert.equal(errorOf(shown).code, "no_such_run");
  });

  it("sous answer on a question that was answered, while its run is there, gives the call sous wait <run> --json", async () => {
    const { paths, projectDir } = testHome({ one: ONE });
    plantDone(paths, projectDir, "r1");
    for (const id of ["r1--0", "r1-nested1--2"]) {
      const gone = await call(paths, ["answer", id, "red", "--json"]);
      assert.equal(gone.code, 65, gone.stdout + gone.stderr);
      const error = errorOf(gone);
      assert.equal(error.code, "no_such_question");
      assert.equal(error.call, "sous wait r1 --json", id);
    }
  });

  it("sous stop --step on a step that ran but does not run now exits 65 with step_not_running", async () => {
    const { paths, projectDir } = testHome({ one: ONE });
    const runId = "run-live";
    const at = new Date().toISOString();
    writeFileSync(
      join(paths.records, `${runId}.json`),
      JSON.stringify({ runId, workflow: "one", file: join(projectDir, ".sous", "workflows", "one.js"), args: {}, place: "folder", cwd: projectDir, projectDir, priority: "user", origin: "cli", createdAt: at, pid: process.pid }),
    );
    // The state has a watermark, so the step that ran is read from it.
    const agents = [{ id: 1, label: "go", prompt: "go", status: "done" as const, startedAt: at, endedAt: at }];
    plantState(paths, { runId, workflowName: "one", script: "return 1", status: "running", eventStreamId: "0123456789abcdef0123456789abcdef", eventSeq: 0, phases: [], agents, logs: [], startedAt: at, updatedAt: at }, "");
    const stopped = await call(paths, ["stop", runId, "--step", "go", "--json"]);
    assert.equal(stopped.code, 65, stopped.stdout + stopped.stderr);
    const error = errorOf(stopped);
    assert.equal(error.code, "step_not_running");
    assert.equal(error.call, `sous show ${runId} --json`);
  });

  it("a usage error in text prints its change, and its try line when it has a call", async () => {
    const { paths } = testHome();
    const shown = await call(paths, ["show"]);
    assert.equal(shown.code, 64, shown.stdout + shown.stderr);
    assert.deepEqual(shown.stderr.trimEnd().split("\n").slice(1), ["  change: Fix the command line. sous help lists the commands and their flags."]);
    const { printError } = await replyModule();
    const lines: string[] = [];
    printError(new Usage("pick one", "bad_argument", "Pick one of them.", "sous list --json"), false, (line) => lines.push(line));
    assert.deepEqual(lines, ["usage: pick one", "  change: Pick one of them.", "  try: sous list --json"]);
  });
});

describe("the --json replies keep today's fields and gain notes and next", () => {
  it("sous run, wait and show", async () => {
    const { paths, projectDir } = testHome({ one: ONE });
    const workers = inProcess({ inner: fakeRunner(() => "done").runner });
    const started = await call(paths, ["run", "one", "--json", "--project", projectDir], { launch: workers.launch });
    assert.equal(started.code, 0, started.stdout + started.stderr);
    const runId = workers.launched[0]!.runId;
    assert.equal((await workers.ended(runId))?.status, "completed");
    const run = replyOf(started);
    assert.equal(run.runId, runId);
    assert.equal(run.workflow, "one");
    assert.equal(typeof run.cwd, "string");
    assert.equal(run.log, logFile(paths, runId));

    const waited = await call(paths, ["wait", runId, "--json"]);
    assert.equal(waited.code, 0, waited.stdout + waited.stderr);
    const wait = replyOf(waited);
    assert.equal(wait.runId, runId);
    assert.equal(wait.workflow, "one");
    assert.equal(wait.status, "completed");
    assert.equal(wait.result, "done");
    assert.equal(wait.cwd, run.cwd);

    const shown = await call(paths, ["show", runId, "--json"]);
    assert.equal(shown.code, 0, shown.stdout + shown.stderr);
    const show = replyOf(shown);
    assert.deepEqual(show.questions, []);
    // The record and the engine state moved to --full in piece 4.
    const fullShown = await call(paths, ["show", runId, "--full", "--json"]);
    assert.equal(fullShown.code, 0, fullShown.stdout + fullShown.stderr);
    const full = replyOf(fullShown);
    assert.equal((full.record as { runId: string }).runId, runId);
    assert.ok(full.state && typeof full.state === "object", "show --full keeps the engine state");
    assert.deepEqual(full.questions, []);
  });

  it("sous list puts the runs under runs, each with today's fields", async () => {
    const { paths, projectDir } = testHome({ one: ONE });
    plantDone(paths, projectDir, "run-done");
    const listed = await call(paths, ["list", "--json"]);
    assert.equal(listed.code, 0, listed.stdout + listed.stderr);
    const list = replyOf(listed);
    assert.ok(Array.isArray(list.runs), "the runs sit under runs");
    const [row] = list.runs as Array<Record<string, unknown>>;
    assert.equal(row!.runId, "run-done");
    assert.equal(row!.workflow, "one");
    assert.equal(row!.status, "completed");
    assert.equal(row!.state, "completed");
    assert.equal(row!.place, "folder");
    assert.equal(row!.cwd, projectDir);
    assert.equal(row!.origin, "cli");
    assert.equal(typeof row!.createdAt, "string");
  });

  it("sous list of 500 runs stays under 8,000 characters and has a note naming --all", async () => {
    const { paths, projectDir } = testHome({ one: ONE });
    const start = Date.parse("2026-11-20T10:00:00.000Z");
    for (let i = 0; i < 500; i++) {
      const runId = `run-${String(i).padStart(4, "0")}`;
      writeFileSync(
        join(paths.records, `${runId}.json`),
        JSON.stringify({ runId, workflow: "one", file: join(projectDir, ".sous", "workflows", "one.js"), args: {}, place: "folder", cwd: projectDir, projectDir, priority: "user", origin: "cli", createdAt: new Date(start + i * 60_000).toISOString() }),
      );
    }
    const listed = await call(paths, ["list", "--json"]);
    assert.equal(listed.code, 0, listed.stderr);
    assert.ok(listed.stdout.length < 8000, `the reply is ${listed.stdout.length} characters`);
    const list = replyOf(listed);
    assert.ok((list.runs as unknown[]).length > 0);
    assert.ok((list.notes as string[]).some((note) => note.includes("--all")), `no note names --all: ${JSON.stringify(list.notes)}`);
  });

  it("sous inbox puts the questions under questions", async () => {
    const { paths } = testHome();
    const question = colorQuestion(paths);
    const listed = await call(paths, ["inbox", "--json"]);
    assert.equal(listed.code, 0, listed.stdout + listed.stderr);
    const inbox = replyOf(listed);
    const [first] = inbox.questions as Array<Record<string, unknown>>;
    assert.equal(first!.id, question.id);
    assert.equal(first!.prompt, "Which color?");
    assert.deepEqual(first!.choices, ["red", "blue"]);
  });

  it("sous workflows puts the workflows under workflows, and check keeps its fields with its notes as the reply's notes", async () => {
    const PLACED = `export const meta = { name: 'placed', description: 'has an input named like a flag', inputs: { place: { type: 'string', default: 'x' } } }\nreturn args.place`;
    const { paths, projectDir } = testHome({ one: ONE, placed: PLACED });
    const listed = await call(paths, ["workflows", "--json", "--project", projectDir]);
    assert.equal(listed.code, 0, listed.stdout + listed.stderr);
    const workflows = replyOf(listed).workflows as Array<Record<string, unknown>>;
    const one = workflows.find((entry) => entry.name === "one");
    assert.equal(one?.file, join(projectDir, ".sous", "workflows", "one.js"));
    assert.equal(one?.description, "one step");

    const checked = await call(paths, ["check", "placed", "--json", "--project", projectDir]);
    assert.equal(checked.code, 0, checked.stdout + checked.stderr);
    const check = replyOf(checked);
    assert.deepEqual(Object.keys(check).sort(), ["description", "file", "inputs", "next", "notes", "problems", "workflow"]);
    assert.equal(check.workflow, "placed");
    assert.deepEqual(check.problems, []);
    assert.ok((check.notes as string[]).some((note) => /input place/.test(note)), `the reserved-name note is a note of the reply: ${JSON.stringify(check.notes)}`);
  });

  it("sous schedule list puts the schedules under schedules", async () => {
    const { paths, projectDir } = testHome({ one: ONE });
    saveSchedules(paths, [{ name: "nightly", workflow: join(projectDir, ".sous", "workflows", "one.js"), projectDir, cron: "0 3 * * *", inputs: {}, enabled: true, createdAt: "2026-11-24T00:00:00.000Z" }]);
    const listed = await call(paths, ["schedule", "list", "--json", "--project", projectDir]);
    assert.equal(listed.code, 0, listed.stdout + listed.stderr);
    const [schedule] = replyOf(listed).schedules as Array<Record<string, unknown>>;
    assert.equal(schedule!.name, "nightly");
    assert.equal(schedule!.cron, "0 3 * * *");
    assert.equal(schedule!.enabled, true);
  });

  it("sous account keeps accounts and waiting", async () => {
    const { paths } = testHome();
    const listed = await call(paths, ["account", "--json"]);
    assert.equal(listed.code, 0, listed.stdout + listed.stderr);
    const account = replyOf(listed);
    assert.ok(Array.isArray(account.accounts));
    assert.ok((account.accounts as Array<{ program: string }>).some((row) => row.program === "claude"));
    assert.deepEqual(account.waiting, []);
  });

  it("sous doctor puts each program's report under programs", async () => {
    const fakes = resolve(dirname(fileURLToPath(import.meta.url)), "../../../test/fakes");
    for (const name of ["CLAUDE_CODE_EXECUTABLE", "CODEX_PATH", "FAKE_VERSION"]) delete process.env[name];
    const { paths } = testHome({}, { claudePath: join(fakes, "claude"), codexPath: join(fakes, "codex") });
    const dir = mkdtempSync(join(tmpdir(), "sous-replies-doctor-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "rules.json"), "[]");
    process.env.FAKE_LOG = join(dir, "fake.log");
    process.env.FAKE_RULES = join(dir, "rules.json");
    const checked = await call(paths, ["doctor", "--json"]);
    assert.equal(checked.code, 0, checked.stdout + checked.stderr);
    const programs = replyOf(checked).programs as Array<Record<string, unknown>>;
    assert.deepEqual(
      programs.map((report) => [report.program, report.talks]),
      [
        ["claude", true],
        ["codex", true],
      ],
    );
  });
});
