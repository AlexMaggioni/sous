// Live test of scenarios 10 and 11: a room actually talks, and an agent kept alone hears nothing.
// A Claude Code member and a Codex member each get a different code word while they work alone.
// They meet in a room with a Claude Code mediator that decides, and the decision holds both words.
// A third agent of the same run works outside the room, before and after it, and names neither.
//
// It is off by default. It needs Claude Code and Codex and your own logins, so run it from
// packages/cli without test/with-temp-home.mjs, after pnpm build:
//
//   env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID SOUS_LIVE_ROOM=1 ../../node_modules/.bin/tsx --test test/live/room.test.ts
//
// Claude Code runs on haiku at low effort, and Codex on gpt-6-luna at low effort. The room stops
// after 4 rounds, a limit this test sets so a model that never decides costs little.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { listRecords } from "@sous-run/engine";
import { liveWorld, turnLine, turnsOf } from "../helpers/live-run.js";

const ON = process.env.SOUS_LIVE_ROOM === "1";
const CLAUDE_WORD = "PELICAN-4417";
const GPT_WORD = "HERON-2210";
const remember = (word: string) => `Remember the code word ${word}. Reply with only OK.`;
const GOAL = [
  "claude and gpt were each given a code word earlier in their own conversation.",
  "claude and gpt: send your code word to all, then set done to true.",
  "mediator: wait until you have read a code word from claude and one from gpt.",
  "Then decide: your decision is both code words, separated by one space. Until then your decision is null.",
].join("\n");
const RECALL = "If this conversation gave you a code word, reply with only that word. Otherwise reply with only NONE.";

const WORKFLOW = `export const meta = { name: 'meet', description: 'Two agents work alone, then meet with a mediator', place: 'none' }
const claude = session({ label: 'claude', model: 'claude/haiku', effort: 'low' })
const gpt = session({ label: 'gpt', model: 'codex/gpt-6-luna', effort: 'low' })
const mediator = session({ label: 'mediator', model: 'claude/haiku', effort: 'low' })
const outsider = session({ label: 'outsider', model: 'codex/gpt-6-luna', effort: 'low' })
await parallel([
  () => claude.send(${JSON.stringify(remember(CLAUDE_WORD))}),
  () => gpt.send(${JSON.stringify(remember(GPT_WORD))}),
  () => outsider.send('Reply with only OK.'),
])
const talk = await room({ name: 'plan', goal: ${JSON.stringify(GOAL)}, members: [claude, gpt, mediator], decider: mediator, maxRounds: 4 })
const heard = await outsider.send(${JSON.stringify(RECALL)}, { label: 'outsider recall' })
return { ended: talk.ended, decision: talk.decision, rounds: talk.rounds, transcript: talk.transcript, heard }`;

interface Result {
  ended: string;
  decision: unknown;
  rounds: number;
  transcript: Array<{ round: number; from: string; to: string; text: string }>;
  heard: string;
}

describe("a live room of Claude Code and Codex", { skip: ON ? false : "set SOUS_LIVE_ROOM=1 to run it, on your own logins" }, () => {
  test("the mediator decides with both words, and the outsider names neither", { timeout: 900_000 }, async (t) => {
    const world = liveWorld(t, "room");
    world.write(".sous/workflows/meet.js", WORKFLOW);
    t.diagnostic(`home ${world.home}, project ${world.project}`);
    const start = Date.now();

    const run = await world.sous("run", "meet", "--wait", "--json");

    assert.equal(listRecords(world.paths).length, 1, "the room ran in the one run");
    const state = world.state();
    for (const label of ["claude", "gpt", "mediator", "outsider", "outsider recall"]) for (const turn of turnsOf(state, label)) t.diagnostic(turnLine(turn));
    t.diagnostic(`run ${state.status}: $${state.tokenUsage?.cost ?? "?"}, ${state.tokenUsage?.total ?? "?"} tokens, ${Date.now() - start} ms`);
    assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
    const result = (JSON.parse(run.stdout) as { result: Result }).result;
    for (const message of result.transcript) t.diagnostic(`round ${message.round}, ${message.from} to ${message.to}: ${message.text}`);
    t.diagnostic(`ended ${result.ended} after ${result.rounds} rounds, decision ${JSON.stringify(result.decision)}, outsider ${JSON.stringify(result.heard)}`);

    assert.equal(result.ended, "decided");
    const decision = JSON.stringify(result.decision);
    assert.ok(decision.includes(CLAUDE_WORD) && decision.includes(GPT_WORD), `the decision is ${decision}`);
    assert.ok(!result.heard.includes(CLAUDE_WORD) && !result.heard.includes(GPT_WORD), `the outsider said ${JSON.stringify(result.heard)}`);

    // Each member goes on in its own session through the room, and the room has its turns.
    for (const label of ["claude", "gpt", "mediator"]) {
      const turns = turnsOf(state, label);
      assert.ok(turns.length >= 2 || label === "mediator", `${label} took ${turns.length} turns`);
      assert.equal(new Set(turns.map((turn) => turn.sessionId)).size, 1, `${label} kept one session`);
    }
    const outsider = [...turnsOf(state, "outsider"), ...turnsOf(state, "outsider recall")].map((turn) => turn.sessionId);
    assert.equal(new Set(outsider).size, 1, "the outsider kept one session");
    assert.ok(!["claude", "gpt", "mediator"].some((label) => turnsOf(state, label).some((turn) => turn.sessionId === outsider[0])));
    assert.deepEqual(
      state.rooms?.map((room) => [room.name, room.call, room.ended]),
      [["plan", 1, "decided"]],
      "the run saved the room",
    );
  });
});
