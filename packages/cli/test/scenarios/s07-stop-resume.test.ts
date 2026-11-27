// Scenario 7, a stop does not lose the session. An implementer handle runs three turns, and the
// fakes hold the third one open after a tool call. The run then pauses, once through
// `sous stop <run> --step implementer` and once through a kill of its worker, and `sous resume`
// goes on. The two finished turns are not asked again. The next request resumes the third turn's
// session in the same folder with "Continue the task.", and the recall rule answers with the word
// the first turn gave, so the session kept its memory.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { listRecords } from "@sous-run/engine";
import { readState } from "@sous-run/engine/testing";
import { fakeWorld, type FakeLine, type FakeRule, type FakeWorld } from "../helpers/fake-world.js";

const CANARY = "PELICAN-4417";
const FIRST = `Implement the parser. Keep this word in mind: ${CANARY}.`;
const FIX = "Make the change the reviewer asked for.";
const HELD = "Write the tests, then say the word you were given.";
const CONTINUE = "Continue the task.";

/** The third turn runs a tool call, then holds until the file "release" exists or the turn ends.
 *  The tool call's message is what tells the engine the program has the prompt. */
const RULES: FakeRule[] = [
  { match: "Write the tests", tool: "echo working", hold: "release", answer: "Done." },
  { match: CONTINUE, recall: true },
];

const script = (model: string) => `export const meta = { name: 'held', description: 'An implementer stopped on its third turn' }
const impl = session({ label: 'implementer', model: '${model}' })
await impl.send(${JSON.stringify(FIRST)})
await impl.send(${JSON.stringify(FIX)})
return await impl.send(${JSON.stringify(HELD)})`;

/** The fakes' turns: the log lines that carry a prompt. */
const turns = (lines: FakeLine[]) => lines.filter((line) => line.prompt !== undefined);

/** Start the run and wait until its third turn runs and the saved state says the program has its prompt. */
async function heldRun(world: FakeWorld): Promise<string> {
  const started = await world.sous("run", "held", "--json");
  assert.equal(started.code, 0, `${started.stdout}\n${started.stderr}`);
  const runId = (JSON.parse(started.stdout) as { runId: string }).runId;
  for (let i = 0; i < 400; i++) {
    const held = readState(world.paths, runId)?.agents?.find((row) => row.status === "running" && row.session !== undefined);
    if (held?.session && held.session.delivered !== false && turns(world.log()).some((line) => line.prompt === HELD)) return runId;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`the third turn never ran with its prompt delivered:\n${JSON.stringify(readState(world.paths, runId), null, 2)}`);
}

/** Kill the run's worker and the fake programs in its process group, as a crash would, and wait
 *  until the worker has ended. */
async function killWorker(world: FakeWorld, runId: string): Promise<void> {
  const pid = listRecords(world.paths).find((record) => record.runId === runId)?.pid;
  assert.ok(pid, "the run has a worker");
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, "SIGKILL");
    } catch {
      // The group or the process has ended already.
    }
  }
  for (let i = 0; i < 200 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(alive(pid), false, "the worker ended");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Resume the run, wait for it, and check what the fakes were asked after the pause. */
async function resumedInSession(world: FakeWorld, runId: string, program: string): Promise<void> {
  const before = turns(world.log());
  assert.deepEqual(
    before.map((line) => [line.program, line.prompt]),
    [FIRST, FIX, HELD].map((prompt) => [program, prompt]),
  );
  const held = before[2]!;

  const resumed = await world.sous("resume", runId, "--wait", "--json").catch((error: Error) => {
    // A resume that hangs shows what the fakes were asked and what the run saved.
    const asked = turns(world.log()).map((line) => `${line.prompt} (session ${line.sessionId}, resume ${line.resume})`);
    throw new Error(`${error.message}\nasked:\n${asked.join("\n")}\nsaved:\n${JSON.stringify(readState(world.paths, runId), null, 2)}`);
  });
  assert.equal(resumed.code, 0, `${resumed.stdout}\n${resumed.stderr}`);
  assert.equal(readState(world.paths, runId)?.status, "completed");
  assert.equal((JSON.parse(resumed.stdout) as { result?: unknown }).result, CANARY, "recall gives the word the first turn got");

  const after = turns(world.log()).slice(before.length);
  assert.deepEqual(
    after.map((line) => line.prompt),
    [CONTINUE],
    "the finished turns are not asked again, and the held turn goes on with the continuation",
  );
  const [next] = after;
  assert.equal(typeof held.sessionId, "string");
  assert.equal(next!.sessionId, held.sessionId, "the same session");
  assert.equal(next!.resume, true, "a new program resumed the session");
  assert.equal(next!.cwd, held.cwd, "in the same folder");
}

for (const [program, model] of [
  ["claude", "claude/haiku"],
  ["codex", "codex/gpt-fake"],
] as const) {
  describe(`a stopped implementer on the fake ${program}`, () => {
    it("sous stop --step pauses the run, and sous resume goes on in the same session", async (t) => {
      const world = fakeWorld(t, { rules: RULES });
      world.workflow("held", script(model));
      const runId = await heldRun(world);
      try {
        const stopped = await world.sous("stop", runId, "--step", "implementer", "--json");
        assert.equal(stopped.code, 0, `${stopped.stdout}\n${stopped.stderr}`);
        const waited = await world.sous("wait", runId, "--timeout", "20", "--json");
        assert.equal(waited.code, 2, waited.stdout);
        assert.equal(readState(world.paths, runId)?.pauseReason, "step_stopped");
      } finally {
        // A failure leaves no fake waiting.
        writeFileSync(join(world.dir, "release"), "");
      }
      await resumedInSession(world, runId, program);
    });

    it("a killed worker leaves the run interrupted, and sous resume goes on in the same session", async (t) => {
      const world = fakeWorld(t, { rules: RULES });
      world.workflow("held", script(model));
      const runId = await heldRun(world);
      await killWorker(world, runId);
      const shown = await world.sous("show", runId, "--json");
      assert.equal((JSON.parse(shown.stdout) as { status?: string }).status, "interrupted", shown.stdout);
      await resumedInSession(world, runId, program);
    });
  });
}
