// An agent asks the person through its program's own question tool (design, decision 9). Every
// agent step may ask unless it says ask: false. The adapter refuses the tool and ends the turn,
// and the steps module returns the turn as the status "question", which the step's loop waits on
// until the person steps into the session. With ask false the program's tool stays off.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Type } from "typebox";
import type { StepRequest } from "../src/steps/agent-run.js";
import { createSteps } from "../src/steps/steps.js";
import { untilFields, untilHash } from "../src/turns/until.js";
import { fakePlace, onFakes, plantSkill, routed, said, type FakePlace } from "./helpers/fake-steps.js";

for (const name of ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) delete process.env[name];

const QUESTION = "Which API should I call?";
const REFUSAL = "The person will step into this session to answer you. End your turn now.";
const ASKED = { status: "question", result: null, message: QUESTION };

/** What each fake logged about its question tool. */
function asks(place: FakePlace): unknown[] {
  const log = join(place.dir, "fake.log");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { ask?: unknown })
    .filter((line) => line.ask !== undefined)
    .map((line) => line.ask);
}

async function step(prompt: string, fields: Omit<StepRequest, "route">, rules: object[], model: string) {
  const place = fakePlace(rules);
  plantSkill(place, "plan");
  const steps = createSteps(onFakes(place));
  try {
    const value = await steps.run(prompt, routed(steps, { label: "builder", model }, fields));
    return { value, place };
  } finally {
    await steps.dispose();
  }
}

const REFUSED: Record<string, unknown> = {
  claude: { behavior: "deny", message: REFUSAL, interrupt: true },
  codex: { answers: { question: { answers: [REFUSAL] } } },
};
const OFF: Record<string, unknown> = {
  claude: { skipped: "disallowed" },
  codex: { error: "No one answers questions during a step. Ask the question in your answer instead." },
};

for (const [program, model] of [
  ["claude", "claude/haiku"],
  ["codex", "codex/gpt-fake"],
] as const) {
  describe(`the program's own question on the fake ${program}`, () => {
    it("ends a one-turn step as a question, since every step may ask", async () => {
      const { value, place } = await step("Build it.", {}, [{ ask: QUESTION, answer: "Never." }], model);
      assert.deepEqual(value, ASKED);
      assert.deepEqual(asks(place), [REFUSED[program]]);
    });

    it("ends a step that runs until done as a question, with no repair turn", async () => {
      const schema = Type.Object({ ok: Type.Boolean() });
      const { value, place } = await step("Build it.", { untilDone: true, schema }, [{ ask: QUESTION, answer: "Never." }], model);
      assert.deepEqual(value, ASKED);
      assert.equal(place.lines().length, 1, "one turn, and no repair after the question");
    });

    it("ends a slash step on its work turn, with no report turn", async () => {
      const { value, place } = await step("/plan the work", { untilDone: true }, [{ match: "^[/$]plan", ask: QUESTION, answer: "Never." }], model);
      assert.deepEqual(value, ASKED);
      assert.deepEqual(place.lines().map((line) => line.prompt), [said(program, "/plan the work")]);
    });

    it("keeps the tool off with ask false, so the agent answers", async () => {
      const { value, place } = await step("Build it.", { ask: false }, [{ ask: QUESTION, answer: "I chose one." }], model);
      assert.equal(value, "I chose one.");
      assert.deepEqual(asks(place), [OFF[program]]);
    });
  });
}

describe("ask in a step's until", () => {
  it("reaches the runner and the call hash only when false, on a one-turn step too", () => {
    assert.deepEqual(untilFields({ end: "turn", ask: false }), { ask: false });
    assert.deepEqual(untilFields({ end: "turn", ask: true }), {});
    assert.deepEqual(untilFields({ end: "done", ask: false, maxTurns: 3 }), { untilDone: true, ask: false, limits: { maxTurns: 3 } });
    assert.deepEqual(untilHash({ end: "turn", ask: false }), { ask: false });
    assert.deepEqual(untilHash({ end: "done", ask: false }), { until: "done", ask: false });
    assert.deepEqual(untilHash("turn"), {});
  });
});
