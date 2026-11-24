// Piece 8, questions. mayAnswer(question, record, who) says who may answer a question, in this
// order (design, "Questions"):
//   1. The person may answer any question, typed in their terminal or passed on with --by person.
//   2. Nothing else answers a breakpoint. It is refused with question_for_people, and its change
//      names approve, send-back and stop.
//   3. Anyone, an agent or a step of a run, may answer a question whose author set answeredBy "anyone".
//   4. An agent may answer a people question of a run started with --let-agent-answer. The
//      record is the root run's, so it covers nested runs.
//   Otherwise question_for_people, with the call that passes on the person's answer: --by person.
// An old question file without answeredBy is a people question.
//
// mayAnswer comes through a dynamic import, so each test fails on its own while it is missing.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Who } from "../../src/runs/actions.js";
import { Refusal } from "../../src/runs/refusal.js";

type MayAnswer = (question: object, record: object, who: Who) => void;

async function mayAnswer(): Promise<MayAnswer> {
  const consent = (await import("../../src/runs/consent.js")) as Record<string, unknown>;
  assert.equal(typeof consent.mayAnswer, "function", "consent.ts exports mayAnswer");
  return consent.mayAnswer as MayAnswer;
}

const PERSON: Who = { by: "person", through: { kind: "person" } };
const AGENT: Who = { by: "agent", through: { kind: "agent", program: "claude", session: "s1" } };
const CODEX: Who = { by: "agent", through: { kind: "agent", program: "codex", session: "t1" } };
const PASSED_ON: Who = { by: "person", through: { kind: "agent", program: "claude", session: "s1" } };
const RUN_STEP: Who = { by: "agent", through: { kind: "run", runId: "r1" } };

const base = { runId: "run-1", scope: "run-1", callIndex: 0, hash: "h0", workflow: "asks", prompt: "Which color?", askedAt: "2026-11-24T10:00:00.000Z" };
const people = { ...base, id: "run-1--0", kind: "select", choices: ["red", "blue"], breakpoint: false, answeredBy: "people" };
const anyone = { ...people, answeredBy: "anyone" };
const breakpoint = { ...base, id: "run-1--1", callIndex: 1, kind: "input", breakpoint: true, answeredBy: "people" };
/** A question file written before piece 8, with no answeredBy. */
const old = { ...base, id: "run-1--2", callIndex: 2, kind: "select", choices: ["red", "blue"], breakpoint: false };

const record = { runId: "run-1", workflow: "asks" };
const letAgent = { ...record, letAgentAnswer: { by: "person", through: { kind: "person" }, at: "2026-11-24T09:59:00.000Z" } };

function refusedFor(run: () => void, what: string): Refusal {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Refusal, `${what} is refused with a Refusal, got ${String(caught)}`);
  assert.equal(caught.code, "question_for_people", what);
  assert.equal(caught.missing, false, `${what}: question_for_people exits 66`);
  return caught;
}

describe("piece 8: mayAnswer", () => {
  it("rule 1: the person may answer a people question, an anyone question and a breakpoint", async () => {
    const may = await mayAnswer();
    for (const question of [people, anyone, breakpoint, old]) {
      assert.doesNotThrow(() => may(question, record, PERSON), question.id);
      assert.doesNotThrow(() => may(question, letAgent, PERSON), question.id);
    }
  });

  it("rule 1: an agent that passes on the person's answer with --by person may answer every question, a breakpoint too", async () => {
    const may = await mayAnswer();
    for (const question of [people, anyone, breakpoint, old]) assert.doesNotThrow(() => may(question, record, PASSED_ON), question.id);
  });

  it("rule 2: an agent never answers a breakpoint, even with --let-agent-answer or a breakpoint file that says anyone", async () => {
    const may = await mayAnswer();
    const forged = { ...breakpoint, answeredBy: "anyone" };
    for (const [question, run, who] of [
      [breakpoint, record, AGENT],
      [breakpoint, letAgent, AGENT],
      [forged, record, AGENT],
      [forged, letAgent, CODEX],
      [breakpoint, letAgent, RUN_STEP],
    ] as const) {
      const refusal = refusedFor(() => may(question, run, who), `${question.id} by ${who.through.kind}`);
      assert.match(refusal.message, new RegExp(question.id), refusal.message);
      for (const verb of ["approve", "send-back", "stop"]) assert.match(refusal.change, new RegExp(verb), `the change names ${verb}: ${refusal.change}`);
      assert.ok(refusal.call?.includes(question.id), `the call names the question: ${refusal.call}`);
      assert.ok(refusal.call?.includes("--by person"), `the call passes on the person's decision: ${refusal.call}`);
    }
  });

  it("rule 3: an agent and a step of a run may answer a question whose author set answeredBy anyone", async () => {
    const may = await mayAnswer();
    for (const who of [AGENT, CODEX, RUN_STEP]) assert.doesNotThrow(() => may(anyone, record, who), who.through.kind);
  });

  it("rule 4: an agent may answer a people question of a run started with --let-agent-answer, an old file too", async () => {
    const may = await mayAnswer();
    for (const question of [people, old]) {
      assert.doesNotThrow(() => may(question, letAgent, AGENT), question.id);
      assert.doesNotThrow(() => may(question, letAgent, CODEX), question.id);
    }
  });

  it("otherwise an agent's answer to a people question is refused with question_for_people and the --by person call", async () => {
    const may = await mayAnswer();
    for (const question of [people, old]) {
      for (const who of [AGENT, CODEX, RUN_STEP]) {
        const refusal = refusedFor(() => may(question, record, who), `${question.id} by ${who.through.kind}`);
        assert.match(refusal.message, new RegExp(`${question.id}.*person`), refusal.message);
        assert.ok(refusal.change.length > 0, "the refusal says what to change");
        assert.ok(refusal.call?.startsWith(`sous answer ${question.id} <red|blue>`), `the call answers with one of the choices: ${refusal.call}`);
        assert.ok(refusal.call?.includes("--by person"), `the call passes on the person's choice: ${refusal.call}`);
      }
    }
  });
});
