// Live test 11: a person steps into a session that a step started, types one line in the
// program's own full-screen view, and leaves. The step then resumes the same session and knows
// both its own word and the person's.
//
// It is off by default. It needs tmux, Claude Code and Codex, and your own logins, so run it from
// packages/harnesses without test/with-temp-home.mjs:
//
//   SOUS_LIVE_JOIN=1 ../../node_modules/.bin/tsx --test test/live/resume-by-hand.test.ts
//
// Claude Code runs on haiku at low effort, and Codex on gpt-6-luna at low effort. Each program
// keeps the sessions under ~/.claude and ~/.codex, as a session opened by hand does. The projects
// live in a temporary folder. A folder the program has never seen shows its trust question first,
// and the test answers yes, as the person would once.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createHarness } from "../../src/index.js";
import type { HarnessId } from "../../src/index.js";

const ON = process.env.SOUS_LIVE_JOIN === "1";

interface Kit {
  id: HarnessId;
  model: string;
  /** The person's command line, after the program's path. */
  byHand(sessionId: string): string[];
  /** The session's file, once the program wrote it. */
  sessionFile(sessionId: string): string | undefined;
  /** True once the session file has the program's reply to the person's line. */
  answered(text: string): boolean;
}

const KITS: Kit[] = [
  {
    id: "claude",
    model: "haiku",
    byHand: (id) => ["--resume", id, "--model", "haiku", "--effort", "low"],
    sessionFile: (id) => find(join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects"), (name) => name === `${id}.jsonl`),
    answered: (text) => after(text, PERSON_WORD).some((line) => line.includes('"type":"assistant"')),
  },
  {
    id: "codex",
    model: "gpt-6-luna",
    byHand: (id) => ["resume", id, "-m", "gpt-6-luna", "-c", "model_reasoning_effort=low", "-c", "check_for_update_on_startup=false"],
    sessionFile: (id) => find(join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions"), (name) => name.startsWith("rollout-") && name.endsWith(`${id}.jsonl`)),
    answered: (text) => after(text, PERSON_WORD).some((line) => line.includes('"task_complete"')),
  },
];

const STEP_WORD = "PLUM";
const PERSON_WORD = "KIWI";

/** The lines of text after the first line that holds word. */
function after(text: string, word: string): string[] {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.includes(word));
  return at < 0 ? [] : lines.slice(at + 1);
}

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

const quote = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;

/** A tmux server of the test's own, so the person's program gets this process's environment. */
function tmux(socket: string) {
  const env = { ...process.env };
  for (const name of ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "SOUS_RUN_ID"]) delete env[name];
  const run = (...args: string[]) => {
    const out = spawnSync("tmux", ["-L", socket, ...args], { env, encoding: "utf8" });
    if (out.status !== 0) throw new Error(`tmux ${args[0]} failed: ${out.stderr}`);
    return out.stdout;
  };
  return {
    start: (cwd: string, line: string[]) => run("new-session", "-d", "-s", "person", "-x", "200", "-y", "50", "-c", cwd, line.map(quote).join(" ")),
    screen: () => run("capture-pane", "-p", "-t", "person"),
    /** Types text, then Enter a second later. Codex takes a fast Enter as part of a paste. */
    type: async (text: string) => {
      run("send-keys", "-t", "person", "-l", text);
      await new Promise((done) => setTimeout(done, 1_000));
      run("send-keys", "-t", "person", "Enter");
    },
    keys: (...keys: string[]) => run("send-keys", "-t", "person", ...keys),
    stop: () => spawnSync("tmux", ["-L", socket, "kill-server"], { env }),
  };
}

async function until(check: () => boolean, ms: number, what: () => string) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail(what());
    await new Promise((done) => setTimeout(done, 500));
  }
}

describe("a person steps into a step's session by hand", { skip: !ON && "set SOUS_LIVE_JOIN=1 to run" }, () => {
  for (const kit of KITS) {
    test(`on ${kit.id}`, { timeout: 300_000 }, async () => {
      const harness = createHarness(kit.id);
      const found = harness.find();
      assert.ok("path" in found, `${kit.id} is not installed`);
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), `sous-live-join-${kit.id}-`)));
      const step = { cwd, model: kit.model, effort: "low" };

      const first = await harness.run({ ...step, prompt: `Remember the word ${STEP_WORD}. Reply only OK.` });
      const id = first.sessionId;

      const person = tmux(`sous-live-join-${process.pid}-${kit.id}`);
      try {
        person.start(cwd, [found.path, ...kit.byHand(id)]);
        // The trust question, if the program asks it, then the session's history.
        const answered = new Set<string>();
        await until(
          () => {
            const screen = person.screen();
            if (screen.includes(STEP_WORD)) return true;
            if (answered.has(screen)) return false;
            // Codex numbers its choices. A notice of new hooks can come first, and the test goes on
            // without trusting them. Claude Code puts the cursor on "No, exit" above "Yes".
            const numbered = /(\d)\.\s*(?:Yes|Skip\s*$|Continue without trusting)/m.exec(screen);
            if (numbered) person.keys(numbered[1]!, "Enter");
            else if (/❯\s*No\b[^\n]*\n\s*Yes/.test(screen)) person.keys("Down", "Enter");
            else return false;
            answered.add(screen);
            return false;
          },
          90_000,
          () => `the program never showed the session's history. The screen:\n${person.screen()}`,
        );
        await new Promise((done) => setTimeout(done, 2_000));
        await person.type(`Also remember the word ${PERSON_WORD}. Reply only OK.`);
        await until(
          () => {
            const file = kit.sessionFile(id);
            return file !== undefined && kit.answered(readFileSync(file, "utf8"));
          },
          120_000,
          () => `the program never answered the person's line. The screen:\n${person.screen()}`,
        );
      } finally {
        person.stop();
      }

      const last = await harness.run({ ...step, resume: id, prompt: "List every word I asked you to remember, comma separated, nothing else." });
      assert.equal(last.sessionId, id);
      assert.match(last.text, new RegExp(STEP_WORD));
      assert.match(last.text, new RegExp(PERSON_WORD));
    });
  }
});
