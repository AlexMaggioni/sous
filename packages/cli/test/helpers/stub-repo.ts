// A small fixture repository for scenarios 2 and 3: three stubbed functions in plain JavaScript
// and a test for each, which `node --test` runs with no install. Every test fails until the
// functions are written. SOLVED holds the written functions, which a fake's files rule puts in
// place as a model's edits would.

/** The command that runs the fixture's tests. */
export const TEST_COMMAND = "node --test";

/** The file that holds the three functions. */
const SOURCE = "src/text.js";

/** The fixture's files, by their path from the project folder. */
export const STUBS: Record<string, string> = {
  "package.json": `${JSON.stringify({ name: "stubs", private: true, type: "module", scripts: { test: TEST_COMMAND } }, null, 2)}\n`,
  [SOURCE]: `// Write each function so its test in test/ passes.

/** The words of a sentence, in lower case, joined with dashes: "Hello World" gives "hello-world". */
export function slug(text) {
  throw new Error("slug is not written yet");
}

/** The number, held between low and high: clamp(12, 0, 10) gives 10. */
export function clamp(value, low, high) {
  throw new Error("clamp is not written yet");
}

/** The sum of a list of numbers, 0 for an empty list. */
export function total(numbers) {
  throw new Error("total is not written yet");
}
`,
  "test/slug.test.js": `import assert from "node:assert/strict";
import { test } from "node:test";
import { slug } from "../src/text.js";

test("slug joins the lower-case words with dashes", () => {
  assert.equal(slug("Hello World"), "hello-world");
  assert.equal(slug("  Many   Spaces here "), "many-spaces-here");
});
`,
  "test/clamp.test.js": `import assert from "node:assert/strict";
import { test } from "node:test";
import { clamp } from "../src/text.js";

test("clamp holds a number between two bounds", () => {
  assert.equal(clamp(12, 0, 10), 10);
  assert.equal(clamp(-3, 0, 10), 0);
  assert.equal(clamp(4, 0, 10), 4);
});
`,
  "test/total.test.js": `import assert from "node:assert/strict";
import { test } from "node:test";
import { total } from "../src/text.js";

test("total adds a list of numbers", () => {
  assert.equal(total([1, 2, 3]), 6);
  assert.equal(total([]), 0);
});
`,
};

/** The source with every function written. */
export const SOLVED: Record<string, string> = {
  [SOURCE]: `export function slug(text) {
  return text.trim().toLowerCase().split(/\\s+/).join("-");
}

export function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

export function total(numbers) {
  return numbers.reduce((sum, number) => sum + number, 0);
}
`,
};

/** Writes the fixture into a git project and commits it, so a worktree made from the project has it. */
export function plantStubs(project: { write(path: string, text: string): void; git(...args: string[]): string }): void {
  for (const [path, text] of Object.entries(STUBS)) project.write(path, text);
  project.git("add", "--all");
  project.git("commit", "--quiet", "-m", "Stubbed functions and their tests");
}
