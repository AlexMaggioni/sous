// A fork, live. A step keeps one word in a session. A step with fork and resume starts a new
// session that knows that word, and keeps a second word there. The first session then still knows
// only its own word, and its file is as it was before the fork. A fork in another folder knows the
// word too.
//
// It is off by default. It needs Claude Code and Codex and your own logins, so run it from
// packages/harnesses without test/with-temp-home.mjs:
//
//   env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID SOUS_LIVE_FORK=1 ../../node_modules/.bin/tsx --test test/live/fork.test.ts
//
// Claude Code runs on haiku at low effort, and Codex on gpt-6-luna at low effort. Each project is a
// new temporary folder. Each program keeps its sessions under its own folder, as a session opened
// by hand does.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import { createHarness } from "../../src/index.js";
import type { HarnessId, StepResult } from "../../src/index.js";

const ON = process.env.SOUS_LIVE_FORK === "1";

const KITS: Array<{ id: HarnessId; model: string; sessionFile(id: string): string | undefined }> = [
  {
    id: "claude",
    model: "haiku",
    sessionFile: (id) => find(join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects"), (name) => name === `${id}.jsonl`),
  },
  {
    id: "codex",
    model: "gpt-6-luna",
    sessionFile: (id) => find(join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions"), (name) => name.startsWith("rollout-") && name.endsWith(`${id}.jsonl`)),
  },
];

const PARENT_WORD = "PLUM";
const FORK_WORD = "KIWI";
const LIST = "List every word I asked you to remember, comma separated, nothing else.";

/** The first file under folder whose name passes the test, searched depth first. */
function find(folder: string, test: (name: string) => boolean): string | undefined {
  if (!existsSync(folder)) return undefined;
  for (const name of readdirSync(folder)) {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) {
      const found = find(path, test);
      if (found) return found;
    } else if (test(name)) return path;
  }
  return undefined;
}

const show = (t: TestContext, what: string, result: StepResult) => t.diagnostic(`${what}: session ${result.sessionId}, ${JSON.stringify(result.text.slice(0, 120))}`);

describe("a fork, live", { skip: !ON && "set SOUS_LIVE_FORK=1 to run" }, () => {
  for (const kit of KITS) {
    const project = () => realpathSync(mkdtempSync(join(tmpdir(), `sous-live-fork-${kit.id}-`)));

    test(`${kit.id}: a fork knows the parent's word, and the parent never learns the fork's`, { timeout: 300_000 }, async (t) => {
      const harness = createHarness(kit.id);
      const step = { cwd: project(), model: kit.model, effort: "low" };

      const parent = await harness.run({ ...step, prompt: `Remember the word ${PARENT_WORD}. Reply only OK.` });
      show(t, "parent", parent);
      const file = kit.sessionFile(parent.sessionId);
      assert.ok(file, "the parent's session file exists");
      const before = readFileSync(file, "utf8");

      const fork = await harness.run({ ...step, resume: parent.sessionId, fork: true, prompt: `Also remember the word ${FORK_WORD}. ${LIST}` });
      show(t, "fork", fork);
      assert.notEqual(fork.sessionId, parent.sessionId);
      assert.match(fork.text, new RegExp(PARENT_WORD));
      assert.match(fork.text, new RegExp(FORK_WORD));
      assert.equal(readFileSync(file, "utf8"), before, "the fork left the parent's file as it was");

      const back = await harness.run({ ...step, resume: parent.sessionId, prompt: LIST });
      show(t, "parent again", back);
      assert.equal(back.sessionId, parent.sessionId);
      assert.match(back.text, new RegExp(PARENT_WORD));
      assert.doesNotMatch(back.text, new RegExp(FORK_WORD));
    });

    test(`${kit.id}: a fork in another folder knows the parent's word`, { timeout: 300_000 }, async (t) => {
      const harness = createHarness(kit.id);
      const step = { model: kit.model, effort: "low" };
      const parent = await harness.run({ ...step, cwd: project(), prompt: `Remember the word ${PARENT_WORD}. Reply only OK.` });
      show(t, "parent", parent);
      const fork = await harness.run({ ...step, cwd: project(), resume: parent.sessionId, fork: true, prompt: LIST });
      show(t, "fork elsewhere", fork);
      assert.notEqual(fork.sessionId, parent.sessionId);
      assert.match(fork.text, new RegExp(PARENT_WORD));
    });
  }
});
