// A Codex step whose prompt starts with a slash command, against the fake codex in test/fakes.
// /goal goes to thread/goal/set and the step ends once the goal stops, after all its turns.
// /goal alone reports the goal and /goal clear clears it, with no turn. A skill goes as the
// skill item, /review and /compact go to their own methods, and /prompts:<name> sends the file's
// text. A command Codex does not have fails the step, and a path is plain text.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createHarness } from "../src/index.js";
import type { HarnessFailure, HistoryEntry, Steer, StepEvents } from "../src/index.js";
import { caseRoot, fakeCase } from "./helpers/fake-case.js";

const ROOT = caseRoot("codex-goal");
const OBJECTIVE = "every test in test/ passes";
const MET = "The goal is met: every test in test/ passes.";
const TURNS = 3;

/** The fields of the fake's log lines this file reads. */
interface Line {
  program: string;
  sessionId: string;
  prompt?: string;
  objective?: string;
  effort?: string | null;
  model?: string;
  approvalPolicy?: string | null;
  sandboxPolicy?: string | null;
  resume?: boolean;
  goal?: { turn: number; of: number };
  goalStatus?: string | null;
  ask?: { answers?: unknown; error?: string };
  skills?: Array<{ name: string; path: string }>;
  review?: { type: string; instructions?: string };
  compact?: boolean;
  steer?: { text: string };
  state?: string;
  texts?: string[];
}

function newCase(rules: object[]) {
  const c = fakeCase(ROOT, "codex", rules);
  const cwd = c.step({ prompt: "" }).cwd;
  return { ...c, cwd, harness: createHarness("codex", c.options), log: () => c.lines() as unknown as Line[] };
}

/** The events a step gave: its history, the last usage and how often the prompt was delivered. */
function recorder() {
  const history: HistoryEntry[] = [];
  const seen = { delivered: 0, steers: 0 };
  const events: StepEvents = {
    history: (entry) => history.push(entry),
    delivered: () => seen.delivered++,
    steer: (send) => {
      if (send) seen.steers++;
    },
  };
  return { events, seen, said: () => history.filter((entry) => entry.role === "assistant" && entry.kind === "text").map((entry) => entry.text) };
}

const failureOf = async (run: Promise<unknown>): Promise<HarnessFailure> => {
  try {
    await run;
  } catch (error) {
    return error as HarnessFailure;
  }
  return assert.fail("the step did not fail");
};

/** Waits until the case's log has a line that fits. */
async function logged(c: ReturnType<typeof newCase>, fits: (line: Line) => boolean): Promise<void> {
  const until = Date.now() + 10_000;
  while (!c.log().some(fits)) {
    if (Date.now() > until) assert.fail(`no log line fits, after ${JSON.stringify(c.log())}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("/goal on codex", () => {
  test("runs the goal's turns with no turn/start and gives one answer, the last turn's", async () => {
    const c = newCase([{ match: "^/goal ", goal: TURNS, answer: MET }]);
    const r = recorder();
    const answer = await c.harness.run(c.step({ prompt: `/goal ${OBJECTIVE}`, effort: "low", mode: "agent-full-access" }), r.events);

    assert.equal(answer.text, MET);
    const lines = c.log();
    // One line for the goal and one per turn, and none for a turn/start.
    const work = lines.filter((line) => line.prompt !== undefined);
    assert.deepEqual(work.map((line) => [line.prompt, line.objective]), [[`/goal ${OBJECTIVE}`, OBJECTIVE]]);
    assert.deepEqual(lines.filter((line) => line.goal).map((line) => line.goal), Array.from({ length: TURNS }, (_, at) => ({ turn: at + 1, of: TURNS })));
    assert.equal(work[0]!.sessionId, answer.sessionId);
    // The step's effort and policies reached the goal's turns through thread/settings/update.
    assert.equal(work[0]!.effort, "low");
    assert.equal(work[0]!.approvalPolicy, "never");
    assert.equal(work[0]!.sandboxPolicy, "dangerFullAccess");
    // Each turn spent 120 input and 30 output tokens, and the step counts all three.
    assert.equal(answer.usage.input, 120 * TURNS);
    assert.equal(answer.usage.output, 30 * TURNS);
    // The history has each turn's message, the prompt was delivered once, and each turn could be steered.
    assert.deepEqual(r.said(), [...Array.from({ length: TURNS - 1 }, (_, at) => `Working on the goal, model turn ${at + 1}.`), MET]);
    assert.equal(r.seen.delivered, 1);
    assert.equal(r.seen.steers, TURNS);
  });

  test("a message sent during a goal's turn goes to that turn", async () => {
    const c = newCase([{ match: "^/goal ", goal: 2, hold: "go", answer: MET }]);
    // The seam opens at the first turn/started, which the fake sends after it logs the turn, and
    // the first turn waits for the go file, so the message goes to it.
    let opened!: (send: Steer) => void;
    const seam = new Promise<Steer>((resolve) => (opened = resolve));
    const run = c.harness.run(c.step({ prompt: `/goal ${OBJECTIVE}` }), { steer: (given) => given && opened(given) });
    const send = await seam;
    assert.ok(c.log().some((line) => line.goal?.turn === 1) && !c.log().some((line) => line.goal?.turn === 2));
    assert.equal(await send("Also keep the old names.", "m1"), "delivered");
    writeFileSync(join(c.dir, "go"), "");
    assert.equal((await run).text, MET);
    assert.deepEqual(
      c.log().filter((line) => line.steer).map((line) => [line.steer!.text, line.state]),
      [["Also keep the old names.", "read"]],
    );
  });

  test("a stop interrupts the turn and pauses the goal", async () => {
    const c = newCase([{ match: "^/goal ", goal: TURNS, hold: "never", answer: MET }]);
    const stopper = new AbortController();
    const run = c.harness.run(c.step({ prompt: `/goal ${OBJECTIVE}`, signal: stopper.signal }));
    await logged(c, (line) => line.goal?.turn === 1);
    stopper.abort();
    const failure = await failureOf(run);
    assert.equal(failure.failure.kind, "stopped");
    await logged(c, (line) => line.goalStatus === "paused");
    assert.equal(c.log().filter((line) => line.goal).length, 1, "no turn ran after the stop");
  });

  test("a question during a goal ends the step with the question", async () => {
    const c = newCase([{ match: "^/goal ", goal: TURNS, ask: "Which region?", answer: MET }]);
    const answer = await c.harness.run(c.step({ prompt: `/goal ${OBJECTIVE}`, ask: true }));
    assert.equal(answer.asked, "Which region?");
    assert.equal(c.log().filter((line) => line.goal).length, 1, "the goal stopped at the question");
    assert.ok(c.log().some((line) => line.ask?.answers), "the adapter refused the question");
  });

  test("a note goes after the objective, since a goal has no other input", async () => {
    const c = newCase([{ match: "^/goal ", answer: MET }]);
    await c.harness.run(c.step({ prompt: `/goal ${OBJECTIVE}`, note: "Use the new parser." }));
    assert.equal(c.log().find((line) => line.objective)?.objective, `${OBJECTIVE}\n\nUse the new parser.`);
  });

  test("/goal alone reports the goal, /goal clear clears it, and neither runs a turn", async () => {
    const c = newCase([{ match: "^/goal ", answer: MET }, { answer: "Noted." }]);
    const none = await c.harness.run(c.step({ prompt: "/goal", hold: true }));
    assert.equal(none.text, "No goal set");
    const set = await c.harness.run(c.step({ prompt: `/goal ${OBJECTIVE}`, resume: none.sessionId, hold: true }));
    assert.equal(set.sessionId, none.sessionId);
    const shown = await c.harness.run(c.step({ prompt: "/goal", resume: none.sessionId, hold: true }));
    assert.equal(shown.text, `Goal (complete): ${OBJECTIVE}`);
    const cleared = await c.harness.run(c.step({ prompt: "/goal clear", resume: none.sessionId, hold: true }));
    assert.equal(cleared.text, "Goal cleared");
    const again = await c.harness.run(c.step({ prompt: "/goal clear", resume: none.sessionId, hold: true }));
    assert.equal(again.text, "No goal set");
    // After the goal, a plain turn goes on in the same thread.
    const next = await c.harness.run(c.step({ prompt: "What next?", resume: none.sessionId }));
    assert.equal(next.text, "Noted.");
    assert.deepEqual(
      c.log().filter((line) => line.prompt !== undefined).map((line) => [line.prompt, line.sessionId]),
      [
        [`/goal ${OBJECTIVE}`, none.sessionId],
        ["What next?", none.sessionId],
      ],
    );
    await c.harness.release();
  });
});

describe("other slash commands on codex", () => {
  test("a skill skills/list names goes as $name and the skill item", async () => {
    const c = newCase([{ match: "^\\$canary", answer: "CANARY" }]);
    const skill = join(c.cwd, ".agents", "skills", "canary", "SKILL.md");
    mkdirSync(join(skill, ".."), { recursive: true });
    writeFileSync(skill, "---\nname: canary\ndescription: Says the canary word.\n---\nSay CANARY.\n");
    const answer = await c.harness.run(c.step({ prompt: "/canary loudly" }));
    assert.equal(answer.text, "CANARY");
    const line = c.log().find((found) => found.prompt !== undefined)!;
    assert.equal(line.prompt, "$canary loudly");
    assert.deepEqual(line.skills, [{ name: "canary", path: skill }]);
  });

  test("a command Codex does not have fails the step and names it", async () => {
    const c = newCase([{ answer: "Noted." }]);
    const failure = await failureOf(c.harness.run(c.step({ prompt: "/status" })));
    assert.match(failure.message, /Codex has no command or skill \/status\./);
    assert.deepEqual(failure.failure, { kind: "failed", retry: false });
    assert.equal(c.log().filter((line) => line.prompt !== undefined).length, 0, "no turn ran");
  });

  test("a prompt that starts with a path goes as text", async () => {
    const c = newCase([{ answer: "Noted." }]);
    const answer = await c.harness.run(c.step({ prompt: "/tmp/notes.txt is empty, fill it" }));
    assert.equal(answer.text, "Noted.");
    assert.equal(c.log().find((line) => line.prompt !== undefined)?.prompt, "/tmp/notes.txt is empty, fill it");
  });

  test("/review reviews the changes, or follows its own instructions, and answers with the review", async () => {
    const c = newCase([{ match: "^/review focus", answer: "The tests miss the empty case." }, { match: "^/review$", answer: "No problems found." }]);
    const plain = await c.harness.run(c.step({ prompt: "/review", effort: "low" }));
    assert.equal(plain.text, "No problems found.");
    const custom = await c.harness.run(c.step({ prompt: "/review focus on the tests" }));
    assert.equal(custom.text, "The tests miss the empty case.");
    assert.deepEqual(
      c.log().filter((line) => line.review).map((line) => [line.review, line.effort]),
      [
        [{ type: "uncommittedChanges" }, "low"],
        [{ type: "custom", instructions: "focus on the tests" }, null],
      ],
    );
  });

  test("a custom review takes the note after its instructions, and /review alone or /compact says it dropped the note", async () => {
    const c = newCase([{ match: "^/review", answer: "Fine." }, { answer: "Noted." }]);
    const custom = await c.harness.run(c.step({ prompt: "/review focus on the tests", note: "Look at the parser too." }));
    assert.equal(custom.notes, undefined);
    const plain = await c.harness.run(c.step({ prompt: "/review", note: "Look at the parser too." }));
    assert.deepEqual(
      c.log().filter((line) => line.review).map((line) => line.review),
      [{ type: "custom", instructions: "focus on the tests\n\nLook at the parser too." }, { type: "uncommittedChanges" }],
    );
    assert.deepEqual(plain.notes, ["Codex's /review takes no note, so the note did not reach it."]);

    const first = await c.harness.run(c.step({ prompt: "Keep going.", hold: true }));
    const compacted = await c.harness.run(c.step({ prompt: "/compact", resume: first.sessionId, note: "Keep the plan." }));
    assert.deepEqual(compacted.notes, ["Codex's /compact takes no note, so the note did not reach it."]);
  });

  test("/compact compacts the thread", async () => {
    const c = newCase([{ answer: "Noted." }]);
    const first = await c.harness.run(c.step({ prompt: "Keep going.", hold: true }));
    const compacted = await c.harness.run(c.step({ prompt: "/compact", resume: first.sessionId }));
    assert.equal(compacted.sessionId, first.sessionId);
    assert.equal(compacted.text, "");
    assert.deepEqual(
      c.log().filter((line) => line.compact).map((line) => line.sessionId),
      [first.sessionId],
    );
  });

  test("/prompts:<name> sends the prompt file's text with its arguments", async () => {
    const c = newCase([{ answer: "Noted." }]);
    const prompts = join(c.dir, "account", "prompts");
    mkdirSync(prompts);
    writeFileSync(join(prompts, "fix.md"), "---\ndescription: Fix a module\n---\nFix $1 in $FILE. All: $ARGUMENTS. Cost: $$5.\n");
    await c.harness.run(c.step({ prompt: "/prompts:fix parser FILE=src/a.ts" }));
    assert.equal(c.log().find((line) => line.prompt !== undefined)?.prompt, "Fix parser in src/a.ts. All: parser FILE=src/a.ts. Cost: $5.\n");

    const failure = await failureOf(c.harness.run(c.step({ prompt: "/prompts:missing" })));
    assert.match(failure.message, /Codex has no prompt \/prompts:missing/);
    assert.ok(!existsSync(join(prompts, "missing.md")));
  });
});
