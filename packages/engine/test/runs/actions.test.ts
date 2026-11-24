import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { homePaths, type HomePaths } from "../../src/runs/home.js";
import { setup } from "./fixture.js";

// Piece 7, who did it. actions.ts records each write as one line of <home>/events.jsonl, reads the
// lines back, and says which actions need a notice to the person. The module is loaded inside each
// test, so a missing module fails each test on its own. Lines are read raw from the file, which
// the monitoring app reads the same way.

type Through =
  | { kind: "person" }
  | { kind: "agent"; program: "claude" | "codex"; session?: string }
  | { kind: "run"; runId: string }
  | { kind: "schedule"; schedule: string };
interface Action {
  at: string;
  act: string;
  by: "person" | "agent" | "sous";
  through: Through;
  runId?: string;
  workflow?: string;
  question?: string;
  prompt?: string;
  schedule?: string;
  step?: string;
  value?: unknown;
  text?: string;
  hash?: string;
}
interface Actions {
  recordAction(paths: HomePaths, action: Omit<Action, "at">, now?: Date): void;
  readActions(paths: HomePaths, filter?: { runId?: string; act?: string }): Action[];
  noticeOf(action: Action): { title: string; message: string } | undefined;
  traceCall(paths: HomePaths, call: { argv: string[]; exit: number; code?: string; through: Through }): void;
}

const actions = async () => (await import("../../src/runs/actions.js" as string)) as Actions;

const NOW = new Date("2026-11-24T12:00:00.000Z");
const PERSON: Through = { kind: "person" };
const CLAUDE: Through = { kind: "agent", program: "claude", session: "s1" };

function rawLines(file: string): Record<string, unknown>[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
const eventsFile = (paths: HomePaths) => join(paths.home, "events.jsonl");

/** An action at NOW. */
const at = (action: Omit<Action, "at">): Action => ({ at: NOW.toISOString(), ...action });

describe("piece 7: events.jsonl", () => {
  it("paths.actions is events.jsonl in the home", () => {
    const paths = homePaths("/tmp/sous-home") as HomePaths & { actions?: string };
    assert.equal(paths.actions, join("/tmp/sous-home", "events.jsonl"));
  });

  it("recordAction adds one line with the time of the write and the action as given", async () => {
    const { recordAction } = await actions();
    const { paths } = setup();
    recordAction(paths, { act: "stop", by: "agent", through: { kind: "agent", program: "codex", session: "t1" }, runId: "r1" }, NOW);
    assert.deepEqual(rawLines(eventsFile(paths)), [
      { at: NOW.toISOString(), act: "stop", by: "agent", through: { kind: "agent", program: "codex", session: "t1" }, runId: "r1" },
    ]);
    recordAction(paths, { act: "answer", by: "person", through: CLAUDE, runId: "r1", question: "r1--0", value: "blue" }, NOW);
    assert.equal(rawLines(eventsFile(paths)).length, 2, "a second write adds a second line and keeps the first");
  });

  it("recordAction cuts free text at 1,000 characters", async () => {
    const { recordAction } = await actions();
    const { paths } = setup();
    recordAction(paths, { act: "tell", by: "agent", through: CLAUDE, runId: "r1", text: "x".repeat(5_000) }, NOW);
    const [line] = rawLines(eventsFile(paths));
    assert.equal(typeof line?.text, "string");
    assert.ok((line!.text as string).length <= 1_000, `text of ${(line!.text as string).length} characters`);
    assert.ok((line!.text as string).startsWith("x".repeat(900)), "the cut keeps the start of the text");
  });

  it("recordAction cuts the question's text at 1,000 characters, and a value's JSON too", async () => {
    const { recordAction } = await actions();
    const { paths } = setup();
    recordAction(paths, { act: "answer", by: "agent", through: CLAUDE, runId: "r1", question: "r1--0", prompt: "Which color? ".repeat(500), value: { notes: "y".repeat(5_000) } }, NOW);
    const [line] = rawLines(eventsFile(paths));
    assert.ok((line!.prompt as string).length <= 1_000, `prompt of ${(line!.prompt as string).length} characters`);
    assert.ok((line!.prompt as string).startsWith("Which color? Which color?"));
    const value = JSON.stringify(line!.value);
    assert.ok(value.length <= 1_100, `a value of ${value.length} characters as JSON`);
    assert.ok(String(line!.value).startsWith('{"notes":"yyy'), `the cut keeps the start of the value's JSON: ${value.slice(0, 40)}`);
  });

  it("recordAction hides a login token in free text, in the question's text and in a value", async () => {
    const { recordAction } = await actions();
    const { paths } = setup();
    const token = "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    recordAction(paths, { act: "send-back", by: "agent", through: CLAUDE, runId: "r1", question: "r1--0", prompt: `Use ${token}?`, text: `the key is ${token}` }, NOW);
    recordAction(paths, { act: "answer", by: "agent", through: CLAUDE, runId: "r1", question: "r1--1", value: `use ${token}` }, NOW);
    recordAction(paths, { act: "answer", by: "agent", through: CLAUDE, runId: "r1", question: "r1--2", value: { key: token } }, NOW);
    const text = readFileSync(eventsFile(paths), "utf8");
    assert.equal(text.includes(token), false, text);
    assert.equal(rawLines(eventsFile(paths)).length, 3);
  });

  it("readActions reads the lines back, and filters by run and by action", async () => {
    const { recordAction, readActions } = await actions();
    const { paths } = setup();
    assert.deepEqual(readActions(paths), [], "a home with no events.jsonl has no actions");
    recordAction(paths, { act: "run", by: "person", through: PERSON, runId: "r1", workflow: "asks" }, NOW);
    recordAction(paths, { act: "answer", by: "agent", through: CLAUDE, runId: "r1", question: "r1--0", value: "blue" }, NOW);
    recordAction(paths, { act: "run", by: "sous", through: { kind: "schedule", schedule: "nightly" }, runId: "r2", workflow: "deploy" }, NOW);
    assert.deepEqual(readActions(paths).map((line) => line.act), ["run", "answer", "run"]);
    assert.deepEqual(readActions(paths, { runId: "r1" }).map((line) => line.act), ["run", "answer"]);
    assert.deepEqual(readActions(paths, { act: "run" }).map((line) => line.runId), ["r1", "r2"]);
    assert.deepEqual(readActions(paths, { runId: "r2", act: "run" })[0]?.through, { kind: "schedule", schedule: "nightly" });
  });

  it("traceCall adds one line to calls.jsonl and none to events.jsonl", async () => {
    const { traceCall } = await actions();
    const { paths } = setup();
    traceCall(paths, { argv: ["run", "deploy"], exit: 66, code: "started_by_people", through: CLAUDE });
    const calls = rawLines(join(paths.home, "calls.jsonl"));
    assert.equal(calls.length, 1);
    assert.deepEqual({ ...calls[0], at: undefined }, { at: undefined, argv: ["run", "deploy"], exit: 66, code: "started_by_people", through: CLAUDE });
    assert.equal(typeof calls[0]!.at, "string");
    assert.deepEqual(rawLines(eventsFile(paths)), []);
  });
});

describe("piece 7: noticeOf", () => {
  const answer = (by: Action["by"], through: Through) => at({ act: "answer", by, through, runId: "mwu6", question: "mwu6--0", value: "blue" });

  it("an agent's answer gives a notice that names the value", async () => {
    const { noticeOf } = await actions();
    const notice = noticeOf(answer("agent", CLAUDE));
    assert.ok(notice, "an agent answered for the person, so the person hears of it");
    assert.equal(typeof notice.title, "string");
    assert.match(notice.message, /blue/);
  });

  it("an answer the agent passed on from the person gives another notice than one it chose", async () => {
    const { noticeOf } = await actions();
    const chose = noticeOf(answer("agent", CLAUDE));
    const passedOn = noticeOf(answer("person", CLAUDE));
    assert.ok(chose && passedOn, "both answers came through an agent");
    assert.match(passedOn.message, /blue/);
    assert.notEqual(passedOn.message, chose.message, "the text differs by who decided");
  });

  it("the notice names the question's text, not its id", async () => {
    const { noticeOf } = await actions();
    const withText = { ...answer("agent", CLAUDE), prompt: "Which color?" };
    assert.equal(noticeOf(withText)?.message, "Claude Code answered blue to Which color? in run mwu6.");
    const passedOn = noticeOf({ ...withText, by: "person" })?.message ?? "";
    assert.match(passedOn, /Which color\?/);
    assert.doesNotMatch(passedOn, /mwu6--0/);
    const approve = noticeOf(at({ act: "approve", by: "agent", through: CLAUDE, runId: "mwu6", question: "mwu6--1", prompt: "Approve the release notes" }))?.message ?? "";
    assert.match(approve, /Approve the release notes/);
    assert.doesNotMatch(approve, /mwu6--1/);
  });

  it("an answer from a step of a run gives a notice", async () => {
    const { noticeOf } = await actions();
    assert.ok(noticeOf(answer("agent", { kind: "run", runId: "r9" })));
  });

  it("approve, send-back, approve-workflow and let-agent-answer through an agent give a notice", async () => {
    const { noticeOf } = await actions();
    for (const act of ["approve", "send-back", "approve-workflow", "let-agent-answer"]) {
      assert.ok(noticeOf(at({ act, by: "agent", through: CLAUDE, runId: "mwu6", question: "mwu6--1" })), act);
    }
  });

  it("the person's own answer, and any stop, give no notice", async () => {
    const { noticeOf } = await actions();
    assert.equal(noticeOf(answer("person", PERSON)), undefined, "the person knows what they answered");
    assert.equal(noticeOf(at({ act: "stop", by: "person", through: PERSON, runId: "mwu6" })), undefined);
    assert.equal(noticeOf(at({ act: "stop", by: "agent", through: CLAUDE, runId: "mwu6" })), undefined);
  });
});
