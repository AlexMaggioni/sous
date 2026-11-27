// A slash step's report turn on Claude Code. Its work turn runs with no schema, so the program it
// kept has no outputFormat, which the SDK takes once per program. The report turn still runs in
// that program, so a background process of the work turn lives on, and asks for its value as JSON
// in its text. Run against the fake program in test/fakes.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createHarness } from "../src/index.js";
import type { HarnessFailure } from "../src/index.js";
import { caseRoot, fakeCase } from "./helpers/fake-case.js";

const ROOT = caseRoot("report-turn");
const SCHEMA = { type: "object", properties: { status: { type: "string" } }, required: ["status"] };

function newCase(rules: object[]) {
  const c = fakeCase(ROOT, "claude", rules);
  return { ...c, harness: createHarness("claude", c.options) };
}

const pids = (c: ReturnType<typeof newCase>) => c.lines().map((line) => (line as { pid?: number }).pid);

describe("the claude adapter's report turn after a slash turn", () => {
  test("runs in the program the slash turn kept, and gives the JSON in its text as the value", async () => {
    const c = newCase([
      { match: "^/my-skill", answer: "Started the server." },
      { match: "^Report on the task", answer: 'Here it is: {"status":"done"}' },
    ]);
    try {
      const work = await c.harness.run(c.step({ prompt: "/my-skill start the server", hold: true }));
      const report = await c.harness.run(c.step({ prompt: "Report on the task you were given.", schema: SCHEMA, resume: work.sessionId, hold: true }));
      assert.deepEqual(report.value, { status: "done" });
      assert.equal(report.sessionId, work.sessionId);
      const [one, two] = pids(c);
      assert.ok(one !== undefined && one === two, `both turns ran in one program: ${pids(c).join(", ")}`);
      assert.match(c.lines()[1]!.prompt, /^Report on the task you were given\.\n\nAnswer with one JSON object/);
    } finally {
      await c.harness.release();
    }
  });

  test("fails as a schema failure when the text holds no JSON object, and keeps the program", async () => {
    const c = newCase([
      { match: "^/my-skill", answer: "Started the server." },
      { match: "^Report on the task", answer: "All done." },
    ]);
    try {
      const work = await c.harness.run(c.step({ prompt: "/my-skill start the server", hold: true }));
      const failure = await c.harness.run(c.step({ prompt: "Report on the task you were given.", schema: SCHEMA, resume: work.sessionId, hold: true })).then(
        () => assert.fail("the turn did not fail"),
        (error: HarnessFailure) => error.failure,
      );
      assert.equal(failure.kind, "schema");
      await c.harness.run(c.step({ prompt: "/my-skill again", resume: work.sessionId, hold: true }));
      assert.equal(new Set(pids(c)).size, 1, "every turn ran in one program");
    } finally {
      await c.harness.release();
    }
  });
});

for (const id of ["claude", "codex"] as const) {
  describe(`the ${id} adapter, stopped as its turn ends`, () => {
    test("keeps the answer of a turn that ended before the stop", async () => {
      const c = fakeCase(ROOT, id, [{ answer: "Done." }]);
      const harness = createHarness(id, c.options);
      const stop = new AbortController();
      // The seam closes at the turn's end, once its answer is in.
      const result = await harness.run(c.step({ prompt: "Say done.", signal: stop.signal }), { steer: (send) => (send === undefined ? stop.abort() : undefined) });
      assert.equal(stop.signal.aborted, true);
      assert.equal(result.text, "Done.");
    });
  });
}
