// Scenario 10, a room actually talks. A Claude member and a GPT member each get a different canary
// while they work alone. They then meet in a room with a mediator that decides, and the decision
// holds both canaries, so what each member knew crossed the room to the mediator. The fakes stand
// in for the programs: a recall rule answers each turn with the canary words its session heard,
// and a room turn reads its own prompt too, where sous puts what the other members said.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listRecords } from "@sous-run/engine";
import { readState } from "@sous-run/engine/testing";
import { fakeWorld, type FakeLine, type FakeRule } from "../helpers/fake-world.js";

const CLAUDE_WORD = "PELICAN-4417";
const GPT_WORD = "HERON-2210";
const NOTHING = "Nothing to recall.";
const alone = (word: string) => `Read the parser and say the words you were given. Keep this word in mind: ${word}.`;

const RULES: FakeRule[] = [
  { match: "words you were given", recall: true },
  { match: "^Round ", recall: true },
];

const WORKFLOW = `export const meta = { name: 'meet', description: 'Two agents work alone, then meet with a mediator' }
const claude = session({ label: 'claude', model: 'claude/haiku' })
const gpt = session({ label: 'gpt', model: 'codex/gpt-fake' })
const mediator = session({ label: 'mediator', model: 'claude/haiku' })
await parallel([() => claude.send(${JSON.stringify(alone(CLAUDE_WORD))}), () => gpt.send(${JSON.stringify(alone(GPT_WORD))})])
const talk = await room({ name: 'plan', goal: 'Share the words you were given, then the mediator writes them all down.', members: [mediator, claude, gpt], decider: mediator })
return { ended: talk.ended, decision: talk.decision, rounds: talk.rounds, transcript: talk.transcript }`;

/** The fakes' turns: the log lines that carry a prompt. */
const turns = (lines: FakeLine[]) => lines.filter((line) => line.prompt !== undefined);

describe("a room of a Claude member, a GPT member and a mediator on the fakes", () => {
  it("the mediator decides with both words, which only the room could have given it", async (t) => {
    const world = fakeWorld(t, { rules: RULES });
    world.workflow("meet", WORKFLOW);

    const run = await world.sous("run", "meet", "--wait", "--json");

    assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
    const records = listRecords(world.paths);
    assert.equal(records.length, 1);
    assert.equal(readState(world.paths, records[0]!.runId)?.status, "completed");
    const { result } = JSON.parse(run.stdout) as { result: { ended: string; decision: unknown; rounds: number; transcript: unknown[] } };
    assert.equal(result.ended, "decided");
    assert.equal(result.decision, `${CLAUDE_WORD} ${GPT_WORD}`, "the decision holds both words");
    assert.equal(result.rounds, 2);
    assert.deepEqual(result.transcript, [
      { round: 1, from: "claude", to: "all", text: CLAUDE_WORD },
      { round: 1, from: "gpt", to: "all", text: GPT_WORD },
      { round: 2, from: "mediator", to: "all", text: `${CLAUDE_WORD} ${GPT_WORD}` },
      { round: 2, from: "claude", to: "all", text: `${CLAUDE_WORD} ${GPT_WORD}` },
      { round: 2, from: "gpt", to: "all", text: `${GPT_WORD} ${CLAUDE_WORD}` },
    ]);

    const lines = turns(world.log());
    /** Every turn of the session whose first turn got `prompt`. */
    const sessionOf = (prompt: string) => {
      const first = lines.find((line) => line.prompt === prompt);
      assert.equal(typeof first?.sessionId, "string");
      return lines.filter((line) => line.sessionId === first!.sessionId);
    };
    // Each member goes on in the session it worked alone in, on its own program.
    for (const [label, program, word] of [
      ["claude", "claude", CLAUDE_WORD],
      ["gpt", "codex", GPT_WORD],
    ] as const) {
      const own = sessionOf(alone(word));
      assert.equal(own.length, 3, `${label} worked alone once and spoke in both rounds`);
      assert.ok(own.every((line) => line.program === program), `${label} runs on ${program}`);
      assert.ok(own.slice(1).every((line) => line.prompt!.startsWith("Round ")));
    }
    // The mediator never got a word before the room: only the room's second round told it both.
    const mediator = lines.filter((line) => line.prompt!.startsWith("Round ") && line.prompt!.includes('You are "mediator"'));
    assert.equal(mediator.length, 1);
    const said = lines.filter((line) => line.sessionId === mediator[0]!.sessionId);
    assert.equal(said.length, 2, "the mediator spoke in both rounds");
    assert.ok(!said[0]!.prompt!.includes(CLAUDE_WORD) && !said[0]!.prompt!.includes(GPT_WORD), "its first turn held no word");
    assert.match(said[1]!.prompt!, new RegExp(`\\[claude to all\\] ${CLAUDE_WORD}\\n\\[gpt to all\\] ${GPT_WORD}`));
    assert.ok(said.every((line) => line.program === "claude"));

    const dry = await world.sous("check", "meet", "--dry-run", "--json");
    assert.equal(dry.code, 0, `${dry.stdout}\n${dry.stderr}`);
    const dryRun = (JSON.parse(dry.stdout) as { dryRun: { status: string } }).dryRun;
    assert.equal(dryRun.status, "completed");
  });

  it("a mediator that hears nothing decides nothing, and the room ends without a decision", async (t) => {
    // The members keep their words: they recall nothing, so they say nothing.
    const world = fakeWorld(t, { rules: [{ match: "^Read the parser", answer: "Read." }, ...RULES] });
    world.workflow("meet", WORKFLOW.replace(/Keep this word in mind: [A-Z]+-\d+\./g, "Keep it to yourself."));

    const run = await world.sous("run", "meet", "--wait", "--json");

    assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
    const { result } = JSON.parse(run.stdout) as { result: { ended: string; decision: unknown; transcript: unknown[] } };
    assert.equal(result.ended, "quiet");
    assert.equal(result.decision, null);
    assert.deepEqual(result.transcript, []);
    assert.ok(!run.stdout.includes(NOTHING), "a room turn with no word sends no message");
  });
});
