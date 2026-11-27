// A step's note goes as a second text of the same user message: a second text block on Claude
// Code, a second text input item on Codex. It is never part of the prompt's own text, and never a
// turn of its own. Run against the fake programs in test/fakes.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createHarness } from "../src/index.js";
import type { HarnessId, Step } from "../src/index.js";

const FAKES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../test/fakes");

if (!process.env.HOME || process.env.HOME === userInfo().homedir || !existsSync(process.env.HOME)) process.env.HOME = mkdtempSync(join(tmpdir(), "harness-note-home-"));
const ROOT = mkdtempSync(join(process.env.HOME, "note-"));
delete process.env.FAKE_VERSION;

/** One line of the fake's request log. */
interface LogLine {
  prompt: string;
  texts?: string[];
  images?: unknown[];
  rule?: number | null;
}

function newCase(id: HarnessId, rules: object[] = []) {
  const dir = mkdtempSync(join(ROOT, `${id}-`));
  const cwd = join(dir, "project");
  mkdirSync(cwd);
  mkdirSync(join(dir, "account"));
  const log = join(dir, "fake.log");
  const rulesFile = join(dir, "rules.json");
  writeFileSync(rulesFile, JSON.stringify(rules));
  process.env.FAKE_LOG = log;
  process.env.FAKE_RULES = rulesFile;
  const harness = createHarness(id, { path: join(FAKES, id), env: {} });
  return {
    run: (fields: Partial<Step> & { prompt: string }) => harness.run({ cwd, account: { folder: join(dir, "account") }, ...fields }),
    lines: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as LogLine) : []),
  };
}

const NOTE = "Use the v2 API this time.";
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

for (const id of ["claude", "codex"] as const) {
  describe(`the ${id} adapter's note`, () => {
    test("goes as a second text of the same message, and a rule sees it", async () => {
      const c = newCase(id, [{ match: "v2 API", answer: "saw the note" }]);
      const result = await c.run({ prompt: "/canary", note: NOTE, images: [{ mimeType: "image/png", data: PIXEL }] });
      assert.equal(result.text, "saw the note");
      const lines = c.lines();
      assert.equal(lines.length, 1, "one turn");
      assert.deepEqual(lines[0]?.texts, ["/canary", NOTE]);
      assert.equal(lines[0]?.images?.length, 1, "the images still go with the message");
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
