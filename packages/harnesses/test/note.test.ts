// A step's note goes as another text of the same user message, before the prompt: a text block on
// Claude Code, a text input item on Codex. Claude Code reads a slash command only from a message's
// last text block, so the prompt goes last. Codex reads none, so a skill's /canary goes as the text
// $canary with the skill item, and the note still goes before it. The note is never part of the
// prompt's own text, and never a turn of its own. Run against the fake programs in test/fakes.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createHarness } from "../src/index.js";
import type { HarnessId, Step } from "../src/index.js";
import { caseRoot, fakeCase } from "./helpers/fake-case.js";

const ROOT = caseRoot("note");

/** A case whose project has the skill canary, which Codex finds through skills/list. */
function newCase(id: HarnessId, rules: object[] = []) {
  const c = fakeCase(ROOT, id, rules);
  const skill = join(c.step({ prompt: "" }).cwd, ".agents", "skills", "canary");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: canary\ndescription: Says the canary word.\n---\nSay CANARY.\n");
  const harness = createHarness(id, c.options);
  return { run: (fields: Partial<Step> & { prompt: string }) => harness.run(c.step(fields)), lines: c.lines };
}

/** The text each program gets for /canary: the command on Claude Code, the skill's $ name on Codex. */
const SAID = { claude: "/canary", codex: "$canary" } as const;

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
      assert.deepEqual(lines[0]?.texts, [NOTE, SAID[id]]);
      assert.equal(lines[0]?.images?.length, 1, "the images still go with the message");
      if (id === "codex") assert.deepEqual(lines[0]?.skills?.map((skill) => skill.name), ["canary"]);
    });

    test("leaves the command last, so a rule on the command still matches with a note", async () => {
      // A slash rule reads the last text. Codex's last text is the skill's $ name.
      const rule = id === "claude" ? { slash: true } : { match: "\\$canary$" };
      const c = newCase(id, [{ ...rule, answer: "ran the command" }, { answer: "no command" }]);
      const result = await c.run({ prompt: "/canary", note: NOTE });
      assert.equal(result.text, "ran the command");
      assert.equal(c.lines()[0]?.texts?.at(-1), SAID[id]);
    });

    test("leaves a step without a note as one text", async () => {
      const c = newCase(id);
      await c.run({ prompt: "/canary" });
      const [line] = c.lines();
      assert.equal(line?.prompt, SAID[id]);
      assert.equal(line?.texts, undefined);
    });
  });
}
