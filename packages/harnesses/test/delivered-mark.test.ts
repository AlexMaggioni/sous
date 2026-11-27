// A turn's delivered mark says the program has the turn's prompt, so a session resumed after the
// program dies holds it. Claude Code marks it on the turn's first assistant, user or result frame,
// once the turn named its session. Codex marks it when turn/start returns. Run against the fake
// programs in test/fakes.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createHarness } from "../src/index.js";
import type { HarnessFailure, HarnessId, StepEvents } from "../src/index.js";
import { caseRoot, fakeCase } from "./helpers/fake-case.js";

const ROOT = caseRoot("delivered");

/** A case against the fake with its harness. */
function newCase(id: HarnessId, rules: object[]) {
  const c = fakeCase(ROOT, id, rules);
  return { ...c, harness: createHarness(id, c.options) };
}

/** Records a turn's session and delivered events in order. onDelivered runs at the mark. */
function recorder(onDelivered?: (sessionId: string) => void) {
  const seen: string[] = [];
  let sessionId = "";
  const events: StepEvents = {
    session: (id) => {
      sessionId = id;
      seen.push("session");
    },
    delivered: () => {
      seen.push("delivered");
      onDelivered?.(sessionId);
    },
  };
  return { seen, events };
}

const failureOf = async (run: Promise<unknown>) => {
  try {
    await run;
  } catch (error) {
    return (error as HarnessFailure).failure;
  }
  assert.fail("the turn did not fail");
};

for (const id of ["claude", "codex"] as const) {
  describe(`the ${id} adapter's delivered mark`, () => {
    test("comes once, after the session, while the turn still runs", { timeout: 20_000 }, async () => {
      // The turn waits for the file go, which only the mark writes.
      const c = newCase(id, [{ hold: "go", answer: "Done." }]);
      let transcript = "";
      const { seen, events } = recorder((sessionId) => {
        const file = join(c.dir, "claude-sessions", sessionId);
        if (id === "claude" && existsSync(file)) transcript = readFileSync(file, "utf8");
        writeFileSync(join(c.dir, "go"), "");
      });
      const result = await c.harness.run(c.step({ prompt: "Say done." }), events);
      assert.equal(result.text, "Done.");
      assert.deepEqual(seen, ["session", "delivered"]);
      if (id === "claude") assert.match(transcript, /Say done\./, "the session file held the prompt at the mark");
    });

    test("comes on each turn of a held program", async () => {
      const c = newCase(id, [{ answer: "Done." }]);
      try {
        const one = recorder();
        const first = await c.harness.run(c.step({ prompt: "Turn one.", hold: true }), one.events);
        const two = recorder();
        await c.harness.run(c.step({ prompt: "Turn two.", hold: true, resume: first.sessionId }), two.events);
        assert.deepEqual(one.seen, ["session", "delivered"]);
        assert.deepEqual(two.seen, ["session", "delivered"]);
      } finally {
        await c.harness.release();
      }
    });

    test("comes for a turn whose program dies mid-turn", async () => {
      const c = newCase(id, [{ exit: 3 }]);
      const { seen, events } = recorder();
      const failure = await failureOf(c.harness.run(c.step({ prompt: "Crash." }), events));
      assert.equal(failure.kind, "failed");
      assert.deepEqual(seen, ["session", "delivered"]);
    });

    test("does not come when the program never reads the prompt", async () => {
      const c = newCase(id, [{ answer: "Done." }]);
      const { seen, events } = recorder();
      const failure = await failureOf(c.harness.run(c.step({ prompt: "Resume a lost one.", resume: randomUUID() }), events));
      assert.equal(failure.kind, "no_session");
      assert.equal(seen.includes("delivered"), false);
    });
  });
}

describe("a stop at the session event", () => {
  test("on Claude Code still marks the turn, since the prompt went in before init", async () => {
    const c = newCase("claude", [{ hold: "never", answer: "Done." }]);
    const stop = new AbortController();
    const { seen, events } = recorder();
    const failure = await failureOf(c.harness.run(c.step({ prompt: "Stop me.", signal: stop.signal }), { ...events, session: (sessionId) => (events.session?.(sessionId), stop.abort()) }));
    assert.equal(failure.kind, "stopped");
    assert.deepEqual(seen, ["session", "delivered"]);
  });

  test("on Codex gives no mark, since turn/start never went", async () => {
    const c = newCase("codex", [{ answer: "Done." }]);
    const stop = new AbortController();
    const { seen, events } = recorder();
    const failure = await failureOf(c.harness.run(c.step({ prompt: "Stop me.", signal: stop.signal }), { ...events, session: (sessionId) => (events.session?.(sessionId), stop.abort()) }));
    assert.equal(failure.kind, "stopped");
    assert.deepEqual(seen, ["session"]);
    assert.equal(c.lines().length, 0, "the fake got no turn");
  });
});
