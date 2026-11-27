// Live test 9 of the workflow shape, through `sous run` on both programs: models fill the status
// object with no contract paragraph, and a model that stops early reports "working". The status
// schema's field descriptions are the only contract the model sees. For each program:
//
// - a plain step with no schema: its row holds a status that readStatus reads, and the program got
//   the script's prompt as written;
// - a plain step with a schema: the "done" result fits it;
// - a step that asks for a long job and to stop after its first part: its first turn reports
//   "working", and sous sends "Continue the task." in the same session.
//
// It is off by default. It needs Claude Code and Codex and your own logins, so run it from
// packages/cli without test/with-temp-home.mjs, after pnpm build:
//
//   env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID SOUS_LIVE_STATUS=1 ../../node_modules/.bin/tsx --test test/live/status.test.ts
//
// Claude Code runs on haiku at low effort, and Codex on gpt-6-luna at low effort, its lowest. The
// test prints each turn's status, cost, tokens and time. A model that ignores the status fails the
// test, which names the program and the turn.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readStatus } from "@sous-run/engine/testing";
import { liveWorld, programPrompts, turnLine, turnsOf, type StepTurn } from "../helpers/live-run.js";

const ON = process.env.SOUS_LIVE_STATUS === "1";
const EFFORT = "low";
const PLAIN = "Name the largest planet in the solar system, in one word.";
const SHAPED = "Name the largest planet in the solar system, and say how many letters its name has.";
// The prompt stops the model after the first part, with work left, and does not ask it to check
// with the person. A prompt that says "ask me" asks for the person, so "question" is right there.
const EARLY = "This task has two parts. Part one: list the files in this folder. Part two: give the first line of README.md. Do only part one in this turn, then end your turn. Do part two in your next turn.";
const CONTINUE = "Continue the task.";
const SCHEMA = {
  type: "object",
  properties: { planet: { type: "string" }, letters: { type: "integer" } },
  required: ["planet", "letters"],
  additionalProperties: false,
};

const PROGRAMS = [
  { program: "claude", model: "claude/haiku" },
  { program: "codex", model: "codex/gpt-6-luna" },
] as const;

/** The workflow: the three steps, in the project folder. */
const script = (model: string) => `export const meta = { name: 'status', description: 'The status with no contract', place: 'folder' }
const plain = await agent(${JSON.stringify(PLAIN)}, { label: 'plain', model: '${model}', effort: '${EFFORT}' })
const shaped = await agent(${JSON.stringify(SHAPED)}, { label: 'shaped', model: '${model}', effort: '${EFFORT}', schema: ${JSON.stringify(SCHEMA)} })
const early = await agent(${JSON.stringify(EARLY)}, { label: 'early', model: '${model}', effort: '${EFFORT}' })
return { plain, shaped, early }`;

/** A turn's status as readStatus reads it from the turn's row, or fails naming the program and turn. */
function statusOf(program: string, turn: StepTurn) {
  const status = readStatus(turn.result);
  assert.ok(status, `${program}, step ${turn.label}, call ${turn.index}: the row holds no status: ${JSON.stringify(turn.result)}`);
  return status;
}

describe("live test 9: the status with no contract paragraph", { skip: ON ? false : "set SOUS_LIVE_STATUS=1 to run it, on your own logins" }, () => {
  for (const { program, model } of PROGRAMS) {
    test(`on ${program}, plain and schema steps report done, and an early stop reports working and gets Continue the task.`, { timeout: 900_000 }, async (t) => {
      const world = liveWorld(t, `status-${program}`);
      world.write(".sous/workflows/status.js", script(model));
      t.diagnostic(`home ${world.home}, project ${world.project}`);
      const start = Date.now();

      const run = await world.sous("run", "status", "--wait", "--json");

      const state = world.state();
      const plain = turnsOf(state, "plain");
      const shaped = turnsOf(state, "shaped");
      const early = turnsOf(state, "early");
      for (const turn of [...plain, ...shaped, ...early]) t.diagnostic(`${program} ${turnLine(turn)}`);
      t.diagnostic(`${program} run ${state.status}, sous run exit ${run.code}: $${state.tokenUsage?.cost ?? "?"}, ${state.tokenUsage?.total ?? "?"} tokens, ${Date.now() - start} ms`);

      // A plain step with no schema: the row holds the status, and the program got the prompt as
      // the script wrote it, with no label line and no contract paragraph.
      assert.equal(plain.length, 1, `${program}, step plain: ${plain.length} turns`);
      const answer = statusOf(program, plain[0]!);
      assert.equal(answer.status, "done", `${program}, step plain, turn 1 said ${answer.status}`);
      assert.equal(typeof answer.result, "string");
      const plainPrompts = programPrompts(program, plain[0]!.sessionId!);
      t.diagnostic(`${program} plain step's user messages: ${JSON.stringify(plainPrompts)}`);
      assert.equal(plainPrompts[0], PLAIN, `${program}: the plain step's prompt is not the script's text as written`);

      // A plain step with a schema: the done result fits it.
      assert.ok(shaped.length >= 1, `${program}, step shaped: no turn`);
      const done = statusOf(program, shaped.at(-1)!);
      assert.equal(done.status, "done", `${program}, step shaped, turn ${shaped.length} said ${done.status}`);
      const value = done.result as Record<string, unknown>;
      assert.deepEqual(Object.keys(value ?? {}).sort(), ["letters", "planet"], `${program}, step shaped: ${JSON.stringify(value)}`);
      assert.equal(typeof value.planet, "string");
      assert.ok(Number.isInteger(value.letters), `${program}, step shaped: letters is ${JSON.stringify(value.letters)}`);

      // The early stop: the first turn ends with part two left, so it says working. Sous sends
      // Continue the task. in the same session, and the step ends with done.
      assert.ok(early.length >= 1, `${program}, step early: no turn`);
      const first = statusOf(program, early[0]!);
      assert.equal(first.status, "working", `${program}, step early, turn 1 said ${first.status}, not working, when it stopped with part two left: ${JSON.stringify(early[0]!.result)}`);
      assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
      assert.equal(state.status, "completed");
      assert.ok(early.length >= 2, `${program}, step early: one turn`);
      const last = statusOf(program, early.at(-1)!);
      assert.equal(last.status, "done", `${program}, step early, turn ${early.length} said ${last.status}`);
      const session = early[0]!.sessionId;
      assert.ok(session, `${program}, step early: no session`);
      assert.deepEqual(
        early.map((turn) => turn.sessionId),
        early.map(() => session),
      );
      const earlyPrompts = programPrompts(program, session);
      t.diagnostic(`${program} early step's user messages: ${JSON.stringify(earlyPrompts)}`);
      assert.deepEqual(earlyPrompts.slice(0, 2), [EARLY, CONTINUE]);
    });
  }
});
