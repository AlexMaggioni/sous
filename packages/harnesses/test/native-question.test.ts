// The program's own question tool on a step with ask, on both adapters through the fakes. With
// ask the adapter refuses the tool, ends the turn and gives the question in asked. Without ask the
// tool stays off on Claude Code, and Codex reads an error that tells it to ask in its answer.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createHarness } from "../src/index.js";
import type { HarnessId, Step } from "../src/index.js";

const FAKES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../test/fakes");

if (!process.env.HOME || process.env.HOME === userInfo().homedir || !existsSync(process.env.HOME)) process.env.HOME = mkdtempSync(join(tmpdir(), "native-question-home-"));
const ROOT = mkdtempSync(join(process.env.HOME, "native-question-"));
delete process.env.FAKE_VERSION;

const REFUSAL = "The person will step into this session to answer you. End your turn now.";
const QUESTION = "Which color do you want?";
const SCHEMA = { type: "object", properties: { color: { type: "string" } }, required: ["color"], additionalProperties: false };

interface LogLine {
  sessionId: string;
  pid: number;
  prompt?: string;
  ask?: { behavior?: string; message?: string; interrupt?: boolean; skipped?: string; answers?: unknown; error?: string };
}

function newCase(program: HarnessId) {
  const dir = mkdtempSync(join(ROOT, `${program}-`));
  const cwd = join(dir, "project");
  const account = join(dir, "account");
  mkdirSync(cwd);
  mkdirSync(account);
  const log = join(dir, "fake.log");
  const rules = join(dir, "rules.json");
  process.env.FAKE_LOG = log;
  process.env.FAKE_RULES = rules;
  writeFileSync(
    rules,
    JSON.stringify([
      { match: "^The person answered", answer: "blue" },
      { ask: QUESTION, answer: "I went on." },
    ]),
  );
  const harness = createHarness(program, { path: join(FAKES, program), env: {} });
  return {
    harness,
    lines: (): LogLine[] => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as LogLine) : []),
    run: (fields: Partial<Step> & { prompt: string }) => harness.run({ cwd, account: { folder: account }, ...fields }),
  };
}

/** What the fake logged about the question tool, per program, with ask on. */
const REFUSED: Record<HarnessId, object> = {
  claude: { behavior: "deny", message: REFUSAL, interrupt: true },
  codex: { answers: { question: { answers: [REFUSAL] } } },
};

/** What the fake logged about the question tool, per program, with ask off. */
const OFF: Record<HarnessId, object> = {
  claude: { skipped: "disallowed" },
  codex: { error: "No one answers questions during a step. Ask the question in your answer instead." },
};

for (const program of ["claude", "codex"] as const) {
  describe(`the native question on ${program}`, () => {
    test("with ask, the turn ends on the question and the result gives it in asked", async () => {
      const c = newCase(program);
      const answer = await c.run({ prompt: "Do the task.", ask: true });
      assert.equal(answer.asked, QUESTION);
      assert.equal(answer.text, "");
      assert.equal(answer.value, undefined);
      assert.deepEqual(
        c.lines().filter((line) => line.ask).map((line) => line.ask),
        [REFUSED[program]],
      );
      // The session goes on after the person answers.
      const next = await c.run({ prompt: "The person answered: blue.", resume: answer.sessionId });
      assert.equal(next.text, "blue");
      assert.equal(next.asked, undefined);
    });

    test("with ask and a schema, the question comes back with no value and no failure", async () => {
      const c = newCase(program);
      const answer = await c.run({ prompt: "Do the task.", ask: true, schema: SCHEMA });
      assert.equal(answer.asked, QUESTION);
      assert.equal(answer.value, undefined);
    });

    test("with ask and hold, a turn that asked closes its program", async () => {
      const c = newCase(program);
      const answer = await c.run({ prompt: "Do the task.", ask: true, hold: true });
      assert.equal(answer.asked, QUESTION);
      const next = await c.run({ prompt: "The person answered: blue.", resume: answer.sessionId, ask: true, hold: true });
      assert.equal(next.text, "blue");
      await c.harness.release();
      const pids = c.lines().filter((line) => line.prompt !== undefined).map((line) => line.pid);
      assert.equal(pids.length, 2);
      assert.notEqual(pids[0], pids[1]);
    });

    test("without ask, the question tool stays off as before and the turn answers", async () => {
      const c = newCase(program);
      const answer = await c.run({ prompt: "Do the task." });
      assert.equal(answer.text, "I went on.");
      assert.equal(answer.asked, undefined);
      assert.deepEqual(
        c.lines().filter((line) => line.ask).map((line) => line.ask),
        [OFF[program]],
      );
    });
  });
}
