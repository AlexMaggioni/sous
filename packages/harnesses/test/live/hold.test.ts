// One program per step, live. A step of two turns runs in one program: turn 1 starts a background
// shell that writes its pid to a file and sleeps, and turn 2 finds that shell still alive. Once
// the step ends and the adapter releases the session, the program has exited. The test prints
// each turn's usage and cost, so a person can see what a second turn in the same program reports.
//
// It is off by default. It needs Claude Code and Codex and your own logins, so run it from
// packages/harnesses without test/with-temp-home.mjs:
//
//   env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID SOUS_LIVE_HOLD=1 ../../node_modules/.bin/tsx --test test/live/hold.test.ts
//
// Claude Code runs on haiku at low effort, and Codex on gpt-6-luna at low effort. Each project is a
// new temporary folder. Each program keeps its session under its own folder, as a session opened
// by hand does.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import { createHarness } from "../../src/index.js";
import type { HarnessId, HistoryEntry, StepResult } from "../../src/index.js";

const ON = process.env.SOUS_LIVE_HOLD === "1";

const KITS: Array<{ id: HarnessId; model: string; start: string }> = [
  {
    id: "claude",
    model: "haiku",
    start: "Use your Bash tool with run_in_background set to true to run exactly this command: sh -c 'echo $$ > bg.pid; exec sleep 600'. Do not wait for it. Then reply only STARTED.",
  },
  {
    id: "codex",
    model: "gpt-6-luna",
    start: "Run exactly this shell command, which starts a background process and returns at once: sleep 600 > /dev/null 2>&1 & echo $! > bg.pid. Then reply only STARTED.",
  },
];
const EFFORT = "low";
const CHECK = "Run exactly this shell command: kill -0 $(cat bg.pid) && echo ALIVE || echo GONE. Reply only with what it printed.";

/** True while the process runs. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The pids of this process's children. tsx runs one of its own, so the test compares with the children from before the step. */
function children(): number[] {
  const ps = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
  return ps.stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, ppid]) => ppid === process.pid && pid !== ps.pid)
    .map(([pid]) => pid!);
}

/** Prints the turn's tool calls and results, so a failure shows what the agent ran. */
const tools = (t: TestContext, what: string) => ({
  history: (entry: HistoryEntry) => {
    if (entry.kind !== "text") t.diagnostic(`  ${what} ${entry.role} ${entry.kind}: ${entry.text.slice(0, 160).replaceAll("\n", " ")}`);
  },
});

const show = (t: TestContext, what: string, result: StepResult) =>
  t.diagnostic(`${what}: ${JSON.stringify(result.text.slice(0, 120))}, usage ${JSON.stringify(result.usage)}`);

describe("one program per step, live", { skip: !ON && "set SOUS_LIVE_HOLD=1 to run" }, () => {
  for (const kit of KITS) {
    test(`${kit.id}: two turns of a step share one program, which exits once the step ends`, { timeout: 300_000 }, async (t) => {
      const harness = createHarness(kit.id);
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), `sous-live-hold-${kit.id}-`)));
      const base = { cwd, model: kit.model, effort: EFFORT, hold: true };
      let shell: number | undefined;
      const before = children();
      /** The programs the adapter started: the children that were not there before the step. */
      const started = () => children().filter((pid) => !before.includes(pid));
      try {
        const first = await harness.run({ ...base, prompt: kit.start }, tools(t, "turn 1"));
        show(t, "turn 1", first);
        const programs = started();
        t.diagnostic(`after turn 1: programs ${JSON.stringify(programs)}, bg.pid ${existsSync(join(cwd, "bg.pid")) ? readFileSync(join(cwd, "bg.pid"), "utf8").trim() : "missing"}`);
        assert.equal(programs.length, 1, "the held program still runs after turn 1");
        assert.ok(existsSync(join(cwd, "bg.pid")), "turn 1 wrote no bg.pid");
        shell = Number(readFileSync(join(cwd, "bg.pid"), "utf8").trim());

        const second = await harness.run({ ...base, prompt: CHECK, resume: first.sessionId }, tools(t, "turn 2"));
        show(t, "turn 2", second);
        t.diagnostic(`after turn 2: programs ${JSON.stringify(started())}, background shell ${shell} alive: ${alive(shell)}`);
        assert.equal(second.sessionId, first.sessionId);
        assert.deepEqual(started(), programs, "turn 2 ran in turn 1's program");
        assert.ok(alive(shell), "the background shell from turn 1 still runs");
        assert.match(second.text, /ALIVE/, "turn 2 found the background shell alive");
        if (first.usage.costUsd !== undefined && second.usage.costUsd !== undefined) {
          t.diagnostic(`cost: turn 1 $${first.usage.costUsd}, turn 2 $${second.usage.costUsd}, difference $${second.usage.costUsd - first.usage.costUsd}`);
        }

        await harness.release(first.sessionId);
        t.diagnostic(`after release: programs ${JSON.stringify(started())}, programs alive ${JSON.stringify(programs.filter(alive))}, background shell alive: ${alive(shell)}`);
        assert.deepEqual(programs.filter(alive), [], "the program exited once the step ended");
      } finally {
        await harness.release();
        if (shell !== undefined && alive(shell)) process.kill(shell, "SIGKILL");
      }
    });
  }
});
