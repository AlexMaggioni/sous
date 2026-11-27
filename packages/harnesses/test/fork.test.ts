// A step with fork and resume starts a new session that begins with the resumed session's
// messages, and leaves the resumed session as it was. Run against the fake programs in
// test/fakes, whose recall rule answers with the canary words of a session's earlier messages.

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createHarness } from "../src/index.js";
import type { HarnessFailure, HarnessId } from "../src/index.js";
import { caseRoot, fakeCase } from "./helpers/fake-case.js";

const ROOT = caseRoot("fork");

/** The fields of a fake's log line this file reads. */
interface ForkLine {
  sessionId: string;
  cwd: string;
  pid: number;
  prompt: string;
  fork?: boolean;
}

// A prompt with "recall" gets the canary words the session saw before. Any other gets "Noted."
const RULES = [{ match: "recall", recall: true }, { answer: "Noted." }];
const RECALL = "What words do you recall?";

/** A case against the fake with its harness, and the file that keeps a session's messages. */
function newCase(id: HarnessId) {
  const c = fakeCase(ROOT, id, RULES);
  const sessionFile = (sessionId: string) => join(c.dir, id === "claude" ? "claude-sessions" : "codex-threads", sessionId);
  return { ...c, harness: createHarness(id, c.options), sessionFile, forkLines: () => c.lines() as unknown as ForkLine[] };
}

const failureOf = async (run: Promise<unknown>): Promise<HarnessFailure> => {
  try {
    await run;
  } catch (error) {
    return error as HarnessFailure;
  }
  return assert.fail("the step did not fail");
};

for (const id of ["claude", "codex"] as const) {
  describe(`a fork on ${id}`, () => {
    test("starts a new session that knows the parent's messages", async () => {
      const c = newCase(id);
      const parent = await c.harness.run(c.step({ prompt: "Keep the word PLUM." }));
      const named: string[] = [];
      const fork = await c.harness.run(c.step({ prompt: RECALL, resume: parent.sessionId, fork: true }), { session: (sessionId) => named.push(sessionId) });
      assert.notEqual(fork.sessionId, parent.sessionId);
      assert.deepEqual(named, [fork.sessionId], "the session event names the fork");
      assert.equal(fork.text, "PLUM");
      const line = c.forkLines().at(-1)!;
      assert.equal(line.fork, true, "the program opened a fork");
      assert.equal(line.sessionId, fork.sessionId);
    });

    test("leaves the parent's session as it was", async () => {
      const c = newCase(id);
      const parent = await c.harness.run(c.step({ prompt: "Keep the word PLUM." }));
      const before = readFileSync(c.sessionFile(parent.sessionId), "utf8");
      const fork = await c.harness.run(c.step({ prompt: "Keep the word KIWI.", resume: parent.sessionId, fork: true }));
      const again = await c.harness.run(c.step({ prompt: RECALL, resume: fork.sessionId }));
      assert.equal(again.text, "PLUM KIWI", "the fork keeps its own messages");
      assert.equal(readFileSync(c.sessionFile(parent.sessionId), "utf8"), before, "the parent's file did not change");
      const back = await c.harness.run(c.step({ prompt: RECALL, resume: parent.sessionId }));
      assert.equal(back.sessionId, parent.sessionId);
      assert.equal(back.text, "PLUM", "the parent does not know the fork's word");
    });

    test("runs in its own folder", async () => {
      const c = newCase(id);
      const parent = await c.harness.run(c.step({ prompt: "Keep the word PLUM." }));
      const other = join(c.dir, "other");
      mkdirSync(other);
      const fork = await c.harness.run(c.step({ prompt: RECALL, resume: parent.sessionId, fork: true, cwd: other }));
      assert.notEqual(fork.sessionId, parent.sessionId);
      assert.equal(fork.text, "PLUM");
      const line = c.forkLines().at(-1)!;
      assert.equal(line.sessionId, fork.sessionId);
      // Claude Code logs its working folder with links resolved, such as /private/var on macOS.
      assert.equal(realpathSync(line.cwd), realpathSync(other));
    });

    test("without resume fails before the program starts", async () => {
      const c = newCase(id);
      const failure = await failureOf(c.harness.run(c.step({ prompt: "Keep the word PLUM.", fork: true })));
      assert.deepEqual(failure.failure, { kind: "failed", retry: false });
      assert.match(failure.message, /resume/);
      assert.equal(c.lines().length, 0, "the fake got no turn");
    });

    test("of a missing session names the session it could not fork", async () => {
      const c = newCase(id);
      const missing = "00000000-0000-4000-8000-000000000000";
      const failure = await failureOf(c.harness.run(c.step({ prompt: RECALL, resume: missing, fork: true })));
      assert.deepEqual(failure.failure, { kind: "no_session", sessionId: missing });
      assert.match(failure.message, new RegExp(`${missing} to fork`));
    });

    test("never takes the parent's held program, which stays held for the parent", async () => {
      const c = newCase(id);
      try {
        const parent = await c.harness.run(c.step({ prompt: "Keep the word PLUM.", hold: true }));
        const parentPid = c.forkLines().at(-1)!.pid;
        const fork = await c.harness.run(c.step({ prompt: "Keep the word KIWI.", resume: parent.sessionId, fork: true, hold: true }));
        const forkPid = c.forkLines().at(-1)!.pid;
        assert.notEqual(forkPid, parentPid, "the fork ran in a program of its own");

        const back = await c.harness.run(c.step({ prompt: RECALL, resume: parent.sessionId, hold: true }));
        assert.equal(back.text, "PLUM");
        assert.equal(c.forkLines().at(-1)!.pid, parentPid, "the parent's turn ran in the parent's held program");

        const forkAgain = await c.harness.run(c.step({ prompt: RECALL, resume: fork.sessionId, hold: true }));
        assert.equal(forkAgain.text, "PLUM KIWI");
        assert.equal(c.forkLines().at(-1)!.pid, forkPid, "the fork's program is held under the fork's session");
      } finally {
        await c.harness.release();
      }
    });
  });
}
