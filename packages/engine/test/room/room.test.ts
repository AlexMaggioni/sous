// room() on the fake programs. Each member's turn is one send() on its handle, so every turn goes
// on in the member's own session, on its program and in its folder, and a send() after the room
// goes on in that session again. A resume replays the room's turns. A member whose agent asks
// gives way, and so does a member whose session the person joined. The room goes on without it
// until its turn ends.

import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { WorkflowError, WorkflowErrorCode } from "../../src/errors.js";
import { releaseHold, sessionHolds } from "../../src/runs/session-hold.js";
import { holdFile } from "../../src/runs/store.js";
import { createSteps } from "../../src/steps/steps.js";
import { PERSON, testHome } from "../../src/testing.js";
import { runWorkflow, type JournalEntry, type WorkflowRunOptions } from "../../src/workflow.js";
import { dryRun } from "../../src/workflows/dry-run.js";
import { waitUntil } from "../helpers/async.js";
import { fakePlace, onFakes, systemOf, wentOn, type FakeLine, type FakePlace } from "../helpers/fake-steps.js";
import { journalResume } from "../helpers/journal-resume.js";

for (const name of ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) delete process.env[name];

const meta = "export const meta = { name: 'rooms', description: 'sessions in a room' }";
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** A rule for the turns of the member `label`, in round `round` when it is given. */
const turn = (label: string, round: number | null, fields: object) => ({
  system: `Task label: ${label}\\b`,
  ...(round === null ? {} : { match: `^Round ${round}\\.` }),
  ...fields,
});
const says = (messages: Array<[string, string]>, done: boolean, more: object = {}) => ({
  answer: { messages: messages.map(([to, text]) => ({ to, text })), done, ...more },
});

/** The turn lines of the member `label`. */
const linesOf = (place: FakePlace, label: string): FakeLine[] => place.lines().filter((line) => new RegExp(`Task label: ${label}\\b`).test(systemOf(line) ?? ""));

async function run(place: FakePlace, body: string, extra: Partial<WorkflowRunOptions> = {}, agent = createSteps(onFakes(place))) {
  const journal: JournalEntry[] = [];
  const logs: string[] = [];
  try {
    const result = await runWorkflow(`${meta}\n${body}`, {
      agent,
      persistLogs: false,
      cwd: place.cwd,
      onAgentJournal: (entry) => journal.push(entry),
      onLog: (message) => logs.push(message),
      ...extra,
    });
    return { result, journal, logs };
  } finally {
    await agent.dispose();
  }
}

/** The design's example on the fakes: two proposers alone, then a room with a mediator who decides. */
const EXAMPLE = `const claude = session({ label: 'claude', model: 'claude/haiku' })
const gpt = session({ label: 'gpt', model: 'codex/gpt-fake' })
const mediator = session({ label: 'mediator', model: 'claude/haiku' })
const proposals = await parallel([claude, gpt].map((s) => () => s.send('Propose a design.')))
const design = await room({
  name: 'design',
  goal: 'Agree on one design.',
  members: [claude, gpt, mediator],
  opening: [{ from: 'claude', to: 'all', text: proposals[0] }, { from: 'gpt', to: 'all', text: proposals[1] }],
  decider: mediator,
  schema: { type: 'object', properties: { design: { type: 'string' } }, required: ['design'] },
  maxRounds: 6,
})
const written = await mediator.send('Write the design down.', { retries: 0 })
return { design, written }`;

const EXAMPLE_RULES = [
  turn("claude", null, { match: "^Propose", answer: "An event log." }),
  turn("gpt", null, { match: "^Propose", answer: "A queue." }),
  turn("claude", 1, says([["gpt", "Can the queue replay?"]], false)),
  turn("gpt", 1, says([["all", "The log can replace the queue."]], true)),
  turn("mediator", 1, says([], false, { decision: null })),
  turn("claude", 2, says([], true)),
  turn("gpt", 2, says([], true)),
  turn("mediator", 2, says([["all", "We take the event log."]], true, { decision: { design: "event log" } })),
  turn("mediator", null, { match: "^Write", answer: "Written." }),
];

describe("room()", () => {
  it("runs the design's example with Claude Code and Codex members, and ends decided", async () => {
    const place = fakePlace(EXAMPLE_RULES);
    const { result, logs } = await run(place, EXAMPLE);
    const got = plain(result.result) as { design: Record<string, unknown>; written: string };
    assert.deepEqual(got.design, {
      ended: "decided",
      decision: { design: "event log" },
      rounds: 2,
      transcript: [
        { round: 0, from: "claude", to: "all", text: "An event log." },
        { round: 0, from: "gpt", to: "all", text: "A queue." },
        { round: 1, from: "claude", to: "gpt", text: "Can the queue replay?" },
        { round: 1, from: "gpt", to: "all", text: "The log can replace the queue." },
        { round: 2, from: "mediator", to: "all", text: "We take the event log." },
      ],
      members: { claude: { turns: 2, done: true }, gpt: { turns: 2, done: true }, mediator: { turns: 2, done: true } },
    });
    assert.equal(got.written, "Written.");

    // Each member's turns go on in its own session: the proposal, then the room, then after it.
    for (const label of ["claude", "gpt", "mediator"]) {
      const lines = linesOf(place, label);
      assert.equal(new Set(lines.map((line) => line.sessionId)).size, 1, `${label} has one session`);
      for (const [earlier, later] of lines.slice(0, -1).map((line, i) => [line, lines[i + 1]] as const)) {
        assert.notEqual(wentOn(earlier, later), "apart", `${label}'s turns go on in its session`);
      }
    }
    assert.deepEqual(linesOf(place, "gpt").map((line) => line.program), ["codex", "codex", "codex"], "a Codex member runs on Codex");
    assert.deepEqual(linesOf(place, "mediator").map((line) => line.prompt.split("\n")[0]), ['Round 1. You are "mediator", a member of the room "design".', "Round 2. New messages since your last turn:", "Write the design down."]);
    assert.equal(
      linesOf(place, "mediator")[1]!.prompt,
      "Round 2. New messages since your last turn:\n[claude to gpt] Can the queue replay?\n[gpt to all] The log can replace the queue.",
      "a later turn holds only what is new, and every message, since every member hears all",
    );
    assert.match(linesOf(place, "claude")[1]!.prompt, /Messages so far:\n\[gpt to all\] A queue\.$/, "the opening reaches each member's first turn, without its own message");

    const room = logs.filter((line) => line.startsWith("room design  "));
    assert.deepEqual(room, [
      "room design  claude to all: An event log.",
      "room design  gpt to all: A queue.",
      "room design  claude to gpt: Can the queue replay?",
      "room design  gpt to all: The log can replace the queue.",
      "room design  mediator to all: We take the event log.",
      "room design  ended decided after 2 rounds",
    ]);
  });

  it("replays its turns on a resume, so only the turn that failed after it runs again", async () => {
    const place = fakePlace([turn("mediator", null, { match: "^Write", fail: "boom", times: 1 }), ...EXAMPLE_RULES]);
    const journal: JournalEntry[] = [];
    await assert.rejects(run(place, EXAMPLE, { onAgentJournal: (entry) => journal.push(entry) }), /step "mediator" failed/);
    const before = place.lines().length;
    const again = await run(place, EXAMPLE, journalResume(journal));
    const got = plain(again.result.result) as { design: { ended: string; decision: unknown }; written: string };
    assert.deepEqual([got.design.ended, got.design.decision, got.written], ["decided", { design: "event log" }, "Written."]);
    const live = place.lines().slice(before);
    assert.deepEqual(live.map((line) => line.prompt), ["Write the design down."], "every room turn replays");
    assert.equal(live[0]!.sessionId, linesOf(place, "mediator")[0]!.sessionId, "the turn after the room goes on in the mediator's session");
    assert.equal(live[0]!.resume, true);
  });

  it("ends agreed with no decider once every member is done, and a member with its own folder works there", async () => {
    const place = fakePlace([
      turn("left", 1, { ...says([["all", "Use the log."]], true), files: { "left.txt": "left" } }),
      turn("right", 1, { ...says([["all", "Agreed."]], true), files: { "right.txt": "right" } }),
    ]);
    mkdirSync(join(place.cwd, "side"));
    const { result } = await run(
      place,
      `const left = session({ label: 'left', model: 'claude/haiku', cwd: 'side' })
const right = session({ label: 'right', model: 'codex/gpt-fake' })
return await room({ goal: 'Pick a store.', members: [left, right] })`,
    );
    const got = plain(result.result) as { ended: string; decision: unknown; rounds: number };
    assert.deepEqual([got.ended, got.decision, got.rounds], ["agreed", null, 1], "messages of the round that agreed don't open the room again");
    assert.ok(existsSync(join(place.cwd, "side", "left.txt")), "left works in its own folder");
    assert.ok(existsSync(join(place.cwd, "right.txt")));
    assert.ok(!existsSync(join(place.cwd, "left.txt")));
  });

  it("goes around the table one member at a time with turns in order, and ends at once on a decision", async () => {
    const place = fakePlace([
      turn("left", 1, says([["all", "One."]], false)),
      turn("right", 1, says([["all", "Two."]], false)),
      turn("host", 1, says([["all", "Two it is."]], true, { decision: "two" })),
    ]);
    const { result } = await run(
      place,
      `const left = session({ label: 'left', model: 'claude/haiku' })
const right = session({ label: 'right', model: 'codex/gpt-fake' })
const host = session({ label: 'host', model: 'claude/haiku' })
return await room({ goal: 'Pick a number.', members: [left, right, host], turns: 'in order', decider: host })`,
    );
    const got = plain(result.result) as { ended: string; decision: unknown; rounds: number; members: Record<string, { turns: number }> };
    assert.deepEqual([got.ended, got.decision, got.rounds], ["decided", "two", 1]);
    assert.deepEqual(got.members, { left: { turns: 1, done: false }, right: { turns: 1, done: false }, host: { turns: 1, done: true } });
    const lines = place.lines();
    assert.deepEqual(lines.map((line) => line.prompt.split("\n")[0]!.match(/You are "(\w+)"/)?.[1]), ["left", "right", "host"]);
    assert.match(lines[1]!.prompt, /Messages so far:\n\[left to all\] One\.$/, "each turn sees every message before it");
    assert.match(lines[2]!.prompt, /\[left to all\] One\.\n\[right to all\] Two\.$/);
  });

  it("lets the decider name each next speaker when moderated", async () => {
    const place = fakePlace([
      turn("host", 1, says([["right", "Your view?"]], false, { decision: null, next: "right" })),
      turn("right", 1, says([["host", "Keep it small."]], true)),
      turn("host", 2, says([], true, { decision: "small", next: null })),
    ]);
    const { result } = await run(
      place,
      `const left = session({ label: 'left', model: 'claude/haiku' })
const right = session({ label: 'right', model: 'claude/haiku' })
const host = session({ label: 'host', model: 'codex/gpt-fake' })
return await room({ goal: 'Size it.', members: [left, right, host], turns: 'moderated', decider: host })`,
    );
    const got = plain(result.result) as { ended: string; decision: unknown; rounds: number; members: Record<string, { turns: number }> };
    assert.deepEqual([got.ended, got.decision, got.rounds], ["decided", "small", 2]);
    assert.equal(got.members.left!.turns, 0, "the host never named left");
    assert.deepEqual(
      place.lines().map((line) => line.prompt.split("\n")[0]),
      ['Round 1. You are "host", a member of the room "room".', 'Round 1. You are "right", a member of the room "room".', "Round 2. New messages since your last turn:"],
    );
  });

  it("gives the decider a last turn before the room ends quiet or on its limit", async () => {
    const quiet = fakePlace([
      turn("host", null, { match: "The room ends now", ...says([], true, { decision: "nothing to change" }) }),
      turn("left", 1, says([], false)),
      turn("right", 1, says([], false)),
      turn("host", 1, says([], false, { decision: null })),
    ]);
    const body = (more: string) => `const left = session({ label: 'left', model: 'claude/haiku' })
const right = session({ label: 'right', model: 'claude/haiku' })
const host = session({ label: 'host', model: 'claude/haiku' })
return await room({ goal: 'Review it.', members: [left, right, host], decider: host${more} })`;
    const first = plain((await run(quiet, body(""))).result.result) as { ended: string; decision: unknown; rounds: number };
    assert.deepEqual([first.ended, first.decision, first.rounds], ["decided", "nothing to change", 1]);
    assert.equal(
      linesOf(quiet, "host").at(-1)!.prompt,
      "Round 1. No new messages since your last turn.\n\nThe room ends now, because no member has anything new to say. Give your decision in decision now.",
    );

    const limit = fakePlace([
      turn("left", null, says([["all", "More."]], false)),
      turn("right", null, says([["all", "More."]], false)),
      turn("host", null, says([["all", "More."]], false, { decision: null })),
    ]);
    const second = plain((await run(limit, body(", maxRounds: 2"))).result.result) as { ended: string; decision: unknown; rounds: number };
    assert.deepEqual([second.ended, second.decision, second.rounds], ["limit", null, 2], "a room that ends on its limit with no decision returns as it is");
    assert.match(linesOf(limit, "host").at(-1)!.prompt, /because it reached its limit of 2 rounds\. Give your decision in decision now\.$/);
  });

  it("goes on without a member whose agent asks, until the person has stepped into its session", async () => {
    let release!: () => void;
    const stepped = new Promise<void>((resolve) => (release = resolve));
    const asked: string[] = [];
    const place = fakePlace([
      turn("claude", 1, { ask: "Which store?", ...says([["all", "Never sent."]], true) }),
      turn("claude", null, { match: "^Continue the task", ...says([["all", "Back: use the log."]], true) }),
      turn("gpt", 1, says([["all", "A queue."]], false)),
      turn("mediator", 1, says([], false, { decision: null })),
      turn("mediator", 2, says([["all", "We take the queue."]], true, { decision: "queue" })),
    ]);
    const logs: string[] = [];
    const { result } = await run(
      place,
      `const claude = session({ label: 'claude', model: 'claude/haiku' })
const gpt = session({ label: 'gpt', model: 'codex/gpt-fake' })
const mediator = session({ label: 'mediator', model: 'claude/haiku' })
return await room({ name: 'pick', goal: 'Pick a store.', members: [claude, gpt, mediator], decider: mediator })`,
      {
        onLog: (message) => {
          logs.push(message);
          if (message === "room pick  mediator to all: We take the queue.") release();
        },
        // The person steps into claude's session once the others have gone on.
        confirm: async (prompt) => {
          asked.push(prompt);
          await stepped;
          return "joined";
        },
      },
    );
    const got = plain(result.result) as { ended: string; decision: unknown; transcript: unknown[]; members: Record<string, unknown> };
    assert.deepEqual([got.ended, got.decision], ["decided", "queue"]);
    assert.deepEqual(asked.length, 1, "one join");
    assert.match(asked[0]!, /Which store\?/);
    assert.deepEqual(got.transcript.at(-1), { round: 2, from: "claude", to: "all", text: "Back: use the log." }, "its answer joins once its turn ends");
    assert.deepEqual(got.members["claude"], { turns: 1, done: true });
    const room = logs.filter((line) => line.startsWith("room pick  "));
    assert.deepEqual(room, [
      "room pick  claude waits for the person. The room goes on without it.",
      "room pick  gpt to all: A queue.",
      "room pick  mediator to all: We take the queue.",
      "room pick  claude to all: Back: use the log.",
      "room pick  ended decided after 2 rounds",
    ]);
    const claude = linesOf(place, "claude");
    assert.deepEqual(claude.map((line) => line.prompt.split("\n")[0]), ['Round 1. You are "claude", a member of the room "pick".', "Continue the task."]);
    assert.equal(claude[1]!.sessionId, claude[0]!.sessionId, "the turn after the person goes on in the member's session");
  });

  it("goes on without a member whose session the person joined between two turns, and takes its turn once the person leaves", async () => {
    const { paths } = testHome();
    const RUN = "run-room-join";
    // The person's \`sous join\` stands in as this test's parent process, which lives through the test.
    const JOINER = process.ppid;
    const place = fakePlace([
      turn("a", 1, says([], false)),
      turn("b", 1, { hold: "b-go", ...says([["all", "B speaks."]], false) }),
      turn("host", 1, says([], false, { decision: null })),
      turn("a", 2, says([["all", "A is back."]], true)),
      turn("host", 2, says([["all", "Decided."]], true, { decision: "go" })),
    ]);
    const steps = createSteps(onFakes(place, { holds: sessionHolds(paths, { pollMs: 10 }) }));
    const journal: JournalEntry[] = [];
    const logs: string[] = [];
    let file = "";
    const ran = run(
      place,
      `const a = session({ label: 'a', model: 'claude/haiku' })
const b = session({ label: 'b', model: 'codex/gpt-fake' })
const host = session({ label: 'host', model: 'claude/haiku' })
return await room({ name: 'join', goal: 'Go?', members: [a, b, host], decider: host })`,
      {
        runId: RUN,
        onAgentJournal: (entry) => journal.push(entry),
        onLog: (message) => {
          logs.push(message);
          // The person leaves once the others have decided without a.
          if (message === "room join  host to all: Decided.") releaseHold(file, JOINER);
        },
      },
      steps,
    );
    // a's first turn has ended, and b's still runs. The person steps into a's session.
    await waitUntil(() => journal.some((entry) => (entry.call as { label?: string } | undefined)?.label === "a"), "a's first turn never ended");
    const session = linesOf(place, "a")[0]!.sessionId;
    file = holdFile(paths, RUN, session);
    await steps.join(RUN, session, JOINER);
    place.gate("b-go");

    const got = plain((await ran).result.result) as { ended: string; decision: unknown; transcript: unknown[] };
    assert.deepEqual([got.ended, got.decision], ["decided", "go"]);
    assert.deepEqual(got.transcript.at(-1), { round: 2, from: "a", to: "all", text: "A is back." });
    assert.deepEqual(logs.filter((line) => line.startsWith("room join  ")), [
      "room join  b to all: B speaks.",
      "room join  a waits for the person. The room goes on without it.",
      "room join  host to all: Decided.",
      "room join  a to all: A is back.",
      "room join  ended decided after 2 rounds",
    ]);
    const [first, second] = linesOf(place, "a");
    assert.equal(wentOn(first, second), "resumed", "a's turn after the person goes on in its session");
  });

  it("refuses options it can't run, before any turn", async () => {
    const place = fakePlace();
    const handles = `const a = session({ label: 'a', model: 'claude/haiku' })
const b = session({ label: 'b', model: 'claude/haiku' })
const c = session({ label: 'c', model: 'claude/haiku' })`;
    const cases: Array<[string, RegExp]> = [
      ["room({ members: [a, b] })", /^room\(\): needs a goal/],
      ["room({ goal: 'x', members: [a] })", /needs members, a list of two handles at least/],
      ["room({ goal: 'x', members: [a, 'b'] })", /members\[1\] is a session handle, or \{ session, role \}/],
      ["room({ goal: 'x', members: [a, { session: b, role: 'r', label: 'b' }] })", /members\[1\] takes session and role, not label/],
      ["room({ goal: 'x', members: [a, a] })", /the label "a" names two members/],
      ["room({ goal: 'x', members: [a, b], rounds: 3 })", /rounds is not a room option\. A room takes goal, members/],
      ["room({ goal: 'x', members: [a, b], turns: 'moderated' })", /a "moderated" room needs a decider/],
      ["room({ goal: 'x', members: [a, b], schema: { type: 'object' } })", /schema is the shape of the decision, so it needs a decider/],
      ["room({ goal: 'x', members: [a, b], decider: c })", /decider is the handle of one of the members/],
      ["room({ goal: 'x', members: [a, b], maxRounds: 0 })", /maxRounds is a whole number of 1 or more/],
      ["room({ goal: 'x', members: [a, b], turns: 'random' })", /turns is "together", "in order", "moderated"/],
      ["room({ goal: 'x', members: [a, b], hears: 'none' })", /hears is "all" or "addressed"/],
      ["room({ goal: 'x', members: [a, b], opening: [{ from: 'c', to: 'all', text: 'hi' }] })", /opening\[0\]\.from is a member's label/],
      ["room({ goal: 'x', members: [a, b], opening: [{ from: 'a', to: 'a', text: 'hi' }] })", /opening\[0\] goes from a to itself/],
    ];
    for (const [call, message] of cases) {
      await assert.rejects(run(place, `${handles}\nreturn await ${call}`), (error: unknown) => {
        assert.ok(error instanceof WorkflowError, `${call}: ${String(error)}`);
        assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, `${call}: ${error.message}`);
        assert.match(error.message, message, call);
        return true;
      });
    }
    assert.deepEqual(place.lines(), [], "no turn ran");
  });

  it("ends decided after round 1 in a dry run with a decider, and agreed without one", async () => {
    const script = (name: string, decider: string) => `export const meta = { name: '${name}', description: 'a dry room' }
const a = session({ label: 'a', model: 'claude/haiku' })
const b = session({ label: 'b', model: 'codex/gpt-fake' })
const r = await room({ goal: 'Agree.', members: [a, b]${decider} })
return { ended: r.ended, rounds: r.rounds, decided: r.decision !== null }`;
    const { paths, projectDir } = testHome({ withDecider: script("withDecider", ", decider: b"), alone: script("alone", "") });
    const decided = await dryRun(paths, { who: PERSON, workflow: "withDecider", projectDir, inputs: {} });
    assert.equal(decided.status, "completed", decided.reason);
    assert.deepEqual(decided.result, { ended: "decided", rounds: 1, decided: true });
    assert.deepEqual(decided.agents, ["a", "b"]);
    const agreed = await dryRun(paths, { who: PERSON, workflow: "alone", projectDir, inputs: {} });
    assert.equal(agreed.status, "completed", agreed.reason);
    assert.deepEqual(agreed.result, { ended: "agreed", rounds: 1, decided: false });
  });

  it("takes each member's answers in a dry run from --answers, by label", async () => {
    const { paths, projectDir } = testHome({
      scripted: `export const meta = { name: 'scripted', description: 'a scripted dry room' }
const a = session({ label: 'a', model: 'claude/haiku' })
const b = session({ label: 'b', model: 'claude/haiku' })
const r = await room({ goal: 'Agree.', members: [a, b], decider: b })
return { ended: r.ended, rounds: r.rounds, decision: r.decision }`,
    });
    const dry = await dryRun(paths, {
      who: PERSON,
      workflow: "scripted",
      projectDir,
      inputs: {},
      answers: {
        a: { messages: [{ to: "b", text: "Ready?" }], done: false },
        b: [{ messages: [], done: false, decision: null }, { messages: [], done: true, decision: "go" }],
      },
    });
    assert.equal(dry.status, "completed", dry.reason);
    assert.deepEqual(dry.result, { ended: "decided", rounds: 2, decision: "go" });
    assert.deepEqual(dry.agents, ["a", "b", "b"]);
  });
});
