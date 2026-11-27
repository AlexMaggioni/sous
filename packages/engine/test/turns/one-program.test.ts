// One program per step. The turns of one step (one agent() call or one send()) run in one open
// program, which closes when the step ends. The next send() on the handle starts the program again
// with a resume. A question, a pause, a stop, the end of the run and a failed turn close it too,
// and each turn's usage and cost stay what a resume per turn gave.
//
// Each fake logs its process id on every line, so the pids tell which turns shared a program.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { createSteps } from "../../src/steps/steps.js";
import type { AgentUsage } from "../../src/steps/agent-run.js";
import { WorkflowError, WorkflowErrorCode } from "../../src/errors.js";
import { runWorkflow, type WorkflowRunOptions } from "../../src/workflow.js";
import { waitUntil } from "../helpers/async.js";
import { fakePlace, onFakes, routed, type FakeLine, type FakePlace } from "../helpers/fake-steps.js";

for (const name of ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) delete process.env[name];

const CONTINUE = "Continue the task.";
const REPORT = "Report on the task you were given.";
const meta = "export const meta = { name: 'one-program', description: 'one program per step' }";

/** True while the process runs. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const pids = (lines: FakeLine[]) => [...new Set(lines.map((line) => line.pid))];
/** The pids of the lines whose process still runs. */
const running = (lines: FakeLine[]) => pids(lines).filter(alive);

/** Lets the fakes' hold rule named `name` go on. */
const gate = (place: FakePlace, name: string) => writeFileSync(join(dirname(process.env.FAKE_LOG!), name), "");

interface Ran {
  result: unknown;
  usage: Array<AgentUsage | undefined>;
  cost: number | undefined;
  /** The fake processes still running when the run returned, before the runner was disposed. */
  left: number[];
}

/** Runs a script on the fakes. */
async function run(place: FakePlace, body: string, extra: Partial<WorkflowRunOptions> = {}): Promise<Ran> {
  const agent = createSteps(onFakes(place));
  const usage: Array<AgentUsage | undefined> = [];
  try {
    const result = await runWorkflow(`${meta}\n${body}`, {
      agent,
      persistLogs: false,
      cwd: place.cwd,
      onAgentEnd: (event) => {
        if (!event.label.endsWith(": check")) usage.push(event.usage);
      },
      ...extra,
    });
    return { result: result.result, usage, cost: result.tokenUsage?.cost, left: running(place.lines()) };
  } finally {
    await agent.dispose();
  }
}

/**
 * Starts a script on the fakes with the stop and pause signals a run's manager passes, so a test
 * can pause or stop it. settled gives what the run threw, or undefined.
 */
function start(place: FakePlace, body: string) {
  const agent = createSteps(onFakes(place));
  const stop = new AbortController();
  const pause = new AbortController();
  const options = { agent, persistLogs: false, cwd: place.cwd, signal: stop.signal, pauseSignal: pause.signal };
  const settled = runWorkflow(`${meta}\n${body}`, options).then(() => undefined, (error: unknown) => error);
  return { agent, stop, pause, settled };
}

for (const [harness, model] of [
  ["claude", "claude/haiku"],
  ["codex", "codex/gpt-6.1-sol"],
] as const) {
  const handle = `const s = session({ label: 'impl', model: '${model}' })`;

  describe(`one program per step on ${harness}`, () => {
    it("runs working, working, done as three turns in one program", async () => {
      const place = fakePlace([{ status: ["working", "working", { status: "done", result: "All built." }] }]);
      const ran = await run(place, `${handle}\nreturn await s.send('Build it.')`);
      assert.equal(ran.result, "All built.");
      const lines = place.lines();
      assert.deepEqual(
        lines.map((line) => line.prompt),
        ["Build it.", CONTINUE, CONTINUE],
      );
      assert.equal(pids(lines).length, 1, `one pid: ${JSON.stringify(pids(lines))}`);
      assert.equal(new Set(lines.map((line) => line.sessionId)).size, 1, "one session");
    });

    it("starts the next send() on the handle in a new program that resumes the session", async () => {
      const place = fakePlace([{ status: ["working", "done", "done"] }]);
      await run(place, `${handle}\nawait s.send('One.')\nreturn await s.send('Two.')`);
      const lines = place.lines();
      assert.deepEqual(
        lines.map((line) => line.prompt),
        ["One.", CONTINUE, "Two."],
      );
      assert.equal(lines[1]!.pid, lines[0]!.pid, "the first send's two turns share a program");
      assert.notEqual(lines[2]!.pid, lines[1]!.pid, "the next send starts the program again");
      assert.equal(lines[2]!.resume, true);
      assert.equal(lines[2]!.sessionId, lines[0]!.sessionId);
    });

    it("sends a failed check's feedback into the same program", async () => {
      // Fails the first time it runs in a folder, with "2 tests fail", and passes after.
      const flaky = "if [ -f checked ]; then exit 0; else touch checked; echo '2 tests fail'; exit 3; fi";
      const place = fakePlace([{ status: [{ status: "done", result: "first" }, { status: "done", result: "second" }] }]);
      const ran = await run(place, `${handle}\nreturn await s.send('Build it.', { check: ${JSON.stringify(flaky)} })`);
      assert.equal(ran.result, "second");
      const lines = place.lines();
      assert.equal(lines.length, 2);
      assert.match(lines[1]!.prompt, /2 tests fail/);
      assert.equal(lines[1]!.pid, lines[0]!.pid);
    });

    it(`runs a slash step's slash turn and report turn in ${harness === "claude" ? "two programs, since the report turn's schema differs" : "one program"}`, async () => {
      const place = fakePlace();
      await run(place, `return await agent('/canary', { label: 'impl', model: '${model}' })`);
      const lines = place.lines();
      assert.deepEqual(
        lines.map((line) => [line.prompt, line.schema === null]),
        [
          ["/canary", true],
          [REPORT, false],
        ],
      );
      assert.equal(lines[1]!.sessionId, lines[0]!.sessionId);
      if (harness === "claude") {
        assert.notEqual(lines[1]!.pid, lines[0]!.pid);
        assert.equal(lines[1]!.resume, true, "the report turn resumes the session");
      } else {
        assert.equal(lines[1]!.pid, lines[0]!.pid);
      }
    });

    it("closes the program before a question waits on its join row, and resumes in a new one after", async () => {
      const place = fakePlace([{ status: ["working", { status: "question", message: "Return 404 or an empty list?" }, { status: "done", result: "404 it is." }] }]);
      let atJoin: { lines: FakeLine[]; left: number[] } | undefined;
      const ran = await run(place, `${handle}\nreturn await s.send('Build it.')`, {
        confirm: async () => {
          const lines = place.lines();
          atJoin = { lines, left: running(lines) };
          return "404.";
        },
      });
      assert.equal(ran.result, "404 it is.");
      assert.ok(atJoin, "the step asked");
      assert.equal(atJoin.lines.length, 2);
      assert.equal(pids(atJoin.lines).length, 1, "the turns before the question share a program");
      assert.deepEqual(atJoin.left, [], "the program exited before the join row waits");
      const lines = place.lines();
      assert.equal(lines.length, 3);
      assert.notEqual(lines[2]!.pid, lines[1]!.pid);
      assert.equal(lines[2]!.resume, true);
      assert.equal(lines[2]!.sessionId, lines[0]!.sessionId);
    });

    it("leaves no program running when the run pauses in the middle of a step", async () => {
      const place = fakePlace([
        { match: "^Build", status: ["working"] },
        { match: "^Continue", hold: "go", status: ["working"] },
      ]);
      const { agent, pause, settled } = start(place, `${handle}\nreturn await s.send('Build it.')`);
      try {
        await waitUntil(() => place.lines().length === 2, "the second turn to start", 15_000);
        pause.abort();
        gate(place, "go");
        const error = await settled;
        assert.ok(error instanceof WorkflowError && error.code === WorkflowErrorCode.PAUSE_REQUESTED, `the run paused: ${String(error)}`);
        const lines = place.lines();
        assert.equal(lines.length, 2, "the third turn never starts");
        assert.equal(pids(lines).length, 1, "the step's turns share a program");
        assert.deepEqual(running(lines), [], "the program exited");
      } finally {
        gate(place, "go");
        await agent.dispose();
      }
    });

    it("leaves no program running when the run stops in the middle of a turn", async () => {
      const place = fakePlace([
        { match: "^Build", status: ["working"] },
        { match: "^Continue", hold: "never" },
      ]);
      const { agent, stop, settled } = start(place, `${handle}\nreturn await s.send('Build it.')`);
      try {
        await waitUntil(() => place.lines().length === 2, "the second turn to start", 15_000);
        stop.abort();
        assert.ok((await settled) !== undefined, "the stopped run threw");
        const lines = place.lines();
        assert.equal(pids(lines).length, 1, "the step's turns share a program");
        await waitUntil(() => running(lines).length === 0, "the program to exit", 15_000);
      } finally {
        await agent.dispose();
      }
    });

    it("leaves no program running when the run ends, for a step that runs until done and one that runs one turn", async () => {
      const place = fakePlace([{ match: "^Build", status: ["working", "done"] }]);
      const ran = await run(
        place,
        `${handle}\nawait s.send('Build it.')\nreturn await agent('Say hi.', { label: 'hi', model: '${model}', until: 'turn' })`,
      );
      const lines = place.lines();
      assert.equal(lines.length, 3);
      assert.equal(lines[1]!.pid, lines[0]!.pid);
      assert.deepEqual(ran.left, [], "no program runs once the run returned");
    });

    it("keeps a held program open until the runner closes it", async () => {
      const place = fakePlace();
      const steps = createSteps(onFakes(place));
      try {
        const done = await steps.run("Build it.", routed(steps, { label: "impl", model }, { hold: true }));
        assert.ok(done !== undefined);
        assert.equal(running(place.lines()).length, 1, "a held program outlives its turn");
      } finally {
        await steps.dispose();
      }
      assert.deepEqual(running(place.lines()), [], "dispose closes it");
    });

    it("retries a crashed turn in a new program that resumes the session", async () => {
      const place = fakePlace([
        { match: "^Build", status: ["working"] },
        { match: "^Continue", times: 1, exit: 1 },
        { match: "^Continue", status: [{ status: "done", result: "Recovered." }] },
      ]);
      const ran = await run(place, `${handle}\nreturn await s.send('Build it.', { retries: 1 })`);
      assert.equal(ran.result, "Recovered.");
      const lines = place.lines();
      assert.deepEqual(
        lines.map((line) => line.outcome),
        ["answer", "exit", "answer"],
      );
      assert.equal(lines[1]!.pid, lines[0]!.pid, "the crashed turn ran in the step's program");
      assert.notEqual(lines[2]!.pid, lines[1]!.pid, "the retry starts the program again");
      assert.equal(lines[2]!.resume, true);
      assert.equal(lines[2]!.sessionId, lines[0]!.sessionId);
      assert.deepEqual(ran.left, []);
    });

    it("gives each turn the usage and cost a resume per turn gave, and the run the same cost", async () => {
      // Three turns of one step, in one program.
      const held = fakePlace([{ status: ["working", "working", "done"] }]);
      const one = await run(held, `${handle}\nreturn await s.send('Build it.')`);
      assert.equal(pids(held.lines()).length, 1, "one program");
      // The same three turns as three steps, each in a program of its own that resumes the session.
      const apart = fakePlace([{ status: ["working", "working", "done"] }]);
      const three = await run(
        apart,
        `${handle}\nawait s.send('Build it.', { until: 'turn' })\nawait s.send('${CONTINUE}', { until: 'turn' })\nreturn await s.send('${CONTINUE}', { until: 'turn' })`,
      );
      assert.equal(pids(apart.lines()).length, 3, "three programs");
      assert.equal(one.usage.length, 3);
      // Codex reports tokens and no cost, so its cost is 0 both ways.
      assert.ok(one.usage.every((usage) => usage !== undefined && usage.total > 0 && (harness === "codex" || usage.cost > 0)), JSON.stringify(one.usage));
      const tokens = ({ cost: _cost, ...rest }: AgentUsage) => rest;
      assert.deepEqual(one.usage.map((usage) => tokens(usage!)), three.usage.map((usage) => tokens(usage!)), "each turn's tokens");
      one.usage.forEach((usage, i) => assert.ok(Math.abs(usage!.cost - three.usage[i]!.cost) < 1e-9, `turn ${i + 1}'s cost: ${usage!.cost} is not ${three.usage[i]!.cost}`));
      assert.ok(one.cost !== undefined && three.cost !== undefined);
      assert.ok(Math.abs(one.cost - three.cost) < 1e-9, `the run's cost: ${one.cost} is not ${three.cost}`);
    });
  });
}
