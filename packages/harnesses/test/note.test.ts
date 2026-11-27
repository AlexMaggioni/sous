// A step's note goes as another text of the same user message, before the prompt: a text block on
// Claude Code, a text input item on Codex. Claude Code reads a slash command only from a message's
// last text block, so the prompt goes last. The note is never part of the prompt's own text, and
// never a turn of its own. Run against the fake programs in test/fakes.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createHarness } from "../src/index.js";
import type { HarnessId, Step } from "../src/index.js";
import { caseRoot, fakeCase } from "./helpers/fake-case.js";

const ROOT = caseRoot("note");

function newCase(id: HarnessId, rules: object[] = []) {
  const c = fakeCase(ROOT, id, rules);
  const harness = createHarness(id, c.options);
  return { run: (fields: Partial<Step> & { prompt: string }) => harness.run(c.step(fields)), lines: c.lines };
}

const NOTE = "Use the v2 API this time.";
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

for (const id of ["claude", "codex"] as const) {
  describe(`the ${id} adapter's note`, () => {
    test("goes as a text before the prompt in the same message, and a rule sees it", async () => {
      const c = newCase(id, [{ match: "v2 API", answer: "saw the note" }]);
      const result = await c.run({ prompt: "/canary", note: NOTE, images: [{ mimeType: "image/png", data: PIXEL }] });
      assert.equal(result.text, "saw the note");
      const lines = c.lines();
      assert.equal(lines.length, 1, "one turn");
      assert.deepEqual(lines[0]?.texts, [NOTE, "/canary"]);
      assert.equal(lines[0]?.images?.length, 1, "the images still go with the message");
    });

    test("leaves the slash prompt last, so a slash rule still matches with a note", async () => {
      const c = newCase(id, [{ slash: true, answer: "ran the command" }, { answer: "no command" }]);
      const result = await c.run({ prompt: "/canary", note: NOTE });
      assert.equal(result.text, "ran the command");
      assert.equal(c.lines()[0]?.texts?.at(-1), "/canary");
    });

    test("leaves a step without a note as one text", async () => {
      const c = newCase(id);
      await c.run({ prompt: "/canary" });
      const [line] = c.lines();
      assert.equal(line?.prompt, "/canary");
      assert.equal(line?.texts, undefined);
    });
  });
}
