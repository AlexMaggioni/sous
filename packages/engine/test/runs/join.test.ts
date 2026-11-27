// `sous join`, the engine's part: find a step's session, make it the person's, and let it go when
// they leave. The runs here go through the worker in this process, with a runner of the test's own,
// so no program runs. The worker's pid is this process, so the signal `sous join` sends reaches it.
// The person's `sous join` stands in as this test's parent process, which lives through the test.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readJsonLines } from "../../src/json-file.js";
import type { HomePaths } from "../../src/runs/home.js";
import { listQuestions } from "../../src/runs/inbox.js";
import { askedWords, joinQuestion, joinTarget, leaveSession, takeSession, type JoinTarget } from "../../src/runs/join.js";
import { createRun } from "../../src/runs/launch.js";
import { activityWriter } from "../../src/runs/records.js";
import { Refusal } from "../../src/runs/refusal.js";
import { readHolder, releaseHold, takeHold } from "../../src/runs/session-hold.js";
import { holdFile, readState } from "../../src/runs/store.js";
import { runWorker } from "../../src/runs/worker.js";
import type { InnerRunner } from "../../src/steps/steps.js";
import { PERSON, fakeRunner } from "../../src/testing.js";
import { CONTINUE_PROMPT } from "../../src/turns/status.js";
import type { AgentSessionRef } from "../../src/workflow-result.js";
import { waitUntil } from "../helpers/async.js";
import { quiet, setup } from "./fixture.js";

const JOINER = process.ppid;
const REF: AgentSessionRef = { sessionId: "s-impl", backendId: "claude", poolKey: "claude", cwd: "/", reopen: { load: true, resume: true, list: true, fork: true } };
const ONE_TURN = `export const meta = { name: 'one', description: 'One turn' }
return await agent('Build it.', { label: 'impl', until: 'turn' })`;

/** A runner whose first turn opens REF and runs until it is stopped, or answers `first` when given.
 *  Each later turn answers "built". */
function sessionRunner(first?: unknown) {
  const turns: Array<{ prompt: string; continues?: string; stopped?: true }> = [];
  const inner: InnerRunner = {
    async run(prompt, request) {
      const turn: (typeof turns)[number] = { prompt, ...(request.continueFromSession ? { continues: request.continueFromSession.sessionId } : {}) };
      turns.push(turn);
      if (turns.length > 1) return "built";
      request.onSessionOpen?.({ ...REF, delivered: false });
      request.onSessionOpen?.(REF);
      if (first !== undefined) return first;
      return await new Promise((_, fail) => {
        const stop = () => ((turn.stopped = true), fail(new Error("stopped")));
        if (request.signal?.aborted) stop();
        else request.signal?.addEventListener("abort", stop);
      });
    },
  };
  return { inner, turns };
}

function start(paths: HomePaths, projectDir: string, workflow: string, inner: InnerRunner) {
  const record = createRun(paths, { who: PERSON, workflow, projectDir, inputs: {} });
  const worker = runWorker(record.runId, "start", { paths, inner, pollMs: 20, log: quiet, handleSignals: true });
  return { runId: record.runId, worker };
}

/** The target once the step's row has its session. */
async function targetOf(paths: HomePaths, runId: string, step: string): Promise<JoinTarget> {
  let target: JoinTarget | undefined;
  await waitUntil(() => {
    try {
      target = joinTarget(paths, runId, step);
      return true;
    } catch {
      return false;
    }
  }, `the step "${step}" never had a session`);
  return target!;
}

function refusalOf(run: () => unknown): Refusal {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof Refusal, `not a refusal: ${String(error)}`);
    return error;
  }
  return assert.fail("no refusal");
}

const acts = (paths: HomePaths) => readJsonLines<{ act: string; step?: string; question?: string }>(paths.actions).filter((line) => line.act === "join" || line.act === "leave");

describe("sous join in the engine", () => {
  it("takes the session from a running turn once its program has the prompt, and the step goes on in it when the person leaves", async () => {
    const { paths, projectDir } = setup({ one: ONE_TURN });
    const { inner, turns } = sessionRunner();
    const { runId, worker } = start(paths, projectDir, "one", inner);
    const target = await targetOf(paths, runId, "impl");
    assert.deepEqual([target.step, target.label, target.call, target.session.sessionId, target.running], ["impl", "impl", 1, "s-impl", true]);

    const waits: unknown[] = [];
    await takeSession(paths, target, PERSON, { pid: JOINER, pollMs: 10, onWait: (holder) => waits.push(holder?.by) });

    const file = holdFile(paths, runId, "s-impl");
    assert.deepEqual([readHolder(file)?.pid, readHolder(file)?.by], [JOINER, "join"]);
    assert.deepEqual(waits, ["step"], "the person waited once, for the turn to hand the session over");
    await waitUntil(() => turns[0]!.stopped === true, "the turn did not stop");
    await new Promise((done) => setTimeout(done, 100));
    assert.equal(turns.length, 1, "no turn runs in the session while the person is in it");

    assert.equal(leaveSession(paths, target, PERSON, { pid: JOINER }), undefined, "the step asked nothing");
    assert.equal(readHolder(file), undefined);
    await worker;
    assert.deepEqual(turns.slice(1), [{ prompt: CONTINUE_PROMPT, continues: "s-impl" }], "the step went on in its session");
    assert.equal(readState(paths, runId)?.result, "built");
    assert.deepEqual(acts(paths).map((line) => [line.act, line.step]), [["join", "impl"], ["leave", "impl"]]);
  });

  it("answers the question the step waits on when the person leaves, and the step goes on", async () => {
    const { paths, projectDir } = setup({ one: ONE_TURN });
    const { inner, turns } = sessionRunner({ status: "question", result: null, message: "Which API?" });
    const { runId, worker } = start(paths, projectDir, "one", inner);
    await waitUntil(() => listQuestions(paths, runId).length > 0, "the step never asked");
    const target = await targetOf(paths, runId, "impl");
    const asked = joinQuestion(paths, target);
    // The person reads the agent's message in its session. The question names the step.
    assert.deepEqual([asked?.answeredBy, asked?.step, asked?.prompt], ["join", "impl", '"impl" needs you in its session.']);

    await takeSession(paths, target, PERSON, { pid: JOINER, pollMs: 10 });
    assert.equal(readHolder(holdFile(paths, runId, "s-impl"))?.pid, JOINER);
    assert.equal(turns.length, 1);

    assert.equal(leaveSession(paths, target, PERSON, { pid: JOINER })?.id, asked!.id);
    await worker;
    assert.deepEqual(turns.slice(1), [{ prompt: CONTINUE_PROMPT, continues: "s-impl" }]);
    assert.equal(readState(paths, runId)?.result, "built");
    const left = acts(paths).at(-1);
    assert.deepEqual([left?.act, left?.question], ["leave", asked!.id]);
  });

  it("takes the session itself when no worker runs, and refuses a second person", async () => {
    const { paths, projectDir } = setup({ one: ONE_TURN });
    const { runId, worker } = start(paths, projectDir, "one", sessionRunner("done").inner);
    await worker;
    const target = joinTarget(paths, runId, "impl");
    assert.equal(target.running, false);

    await takeSession(paths, target, PERSON, { pid: JOINER, pollMs: 10 });
    const file = holdFile(paths, runId, "s-impl");
    assert.deepEqual([readHolder(file)?.pid, readHolder(file)?.by], [JOINER, "join"]);
    const second = await takeSession(paths, target, PERSON, { pid: process.pid, pollMs: 10 }).then(
      () => assert.fail("a second person took the session"),
      (error: unknown) => error,
    );
    assert.ok(second instanceof Refusal && second.code === "session_joined", String(second));
    leaveSession(paths, target, PERSON, { pid: JOINER });
    assert.equal(readHolder(file), undefined);
  });

  it("waits while a step of another process holds the session", async () => {
    const { paths, projectDir } = setup({ one: ONE_TURN });
    const { runId, worker } = start(paths, projectDir, "one", sessionRunner("done").inner);
    await worker;
    const target = joinTarget(paths, runId, "impl");
    const file = holdFile(paths, runId, "s-impl");
    takeHold(file, { pid: JOINER, by: "step", at: new Date().toISOString() });
    const waits: unknown[] = [];
    const taking = takeSession(paths, target, PERSON, { pid: process.pid, pollMs: 10, onWait: (holder) => waits.push(holder?.by) });
    await waitUntil(() => waits.length > 0, "the join did not wait");
    releaseHold(file, JOINER);
    await taking;
    assert.deepEqual(waits, ["step"]);
    assert.equal(readHolder(file)?.pid, process.pid);
    releaseHold(file, process.pid);
  });

  it("gives the session back at once when its signal stops it after the worker has the request, so the step goes on", async () => {
    const { paths, projectDir } = setup({ one: ONE_TURN });
    const { inner, turns } = sessionRunner();
    const { runId, worker } = start(paths, projectDir, "one", inner);
    const target = await targetOf(paths, runId, "impl");
    const stop = new AbortController();
    const taking = takeSession(paths, target, PERSON, { pid: JOINER, pollMs: 10, signal: stop.signal, onWait: () => stop.abort() });
    await assert.rejects(taking, /stopped waiting/);
    assert.equal(readHolder(holdFile(paths, runId, "s-impl")), undefined, "the session is free again");
    await worker;
    assert.deepEqual(turns.slice(1), [{ prompt: CONTINUE_PROMPT, continues: "s-impl" }], "the step went on in its session");
    assert.equal(readState(paths, runId)?.result, "built");
    assert.deepEqual(acts(paths), [], "no one joined or left");
  });

  it("leaves the question open when the program never opened", async () => {
    const { paths, projectDir } = setup({ one: ONE_TURN });
    const { inner } = sessionRunner({ status: "question", result: null, message: "Which API?" });
    const { runId } = start(paths, projectDir, "one", inner);
    await waitUntil(() => listQuestions(paths, runId).length > 0, "the step never asked");
    const target = await targetOf(paths, runId, "impl");
    const asked = joinQuestion(paths, target)!;
    await takeSession(paths, target, PERSON, { pid: JOINER, pollMs: 10 });
    assert.equal(leaveSession(paths, target, PERSON, { pid: JOINER, answer: false }), undefined);
    assert.equal(readHolder(holdFile(paths, runId, "s-impl")), undefined);
    assert.equal(joinQuestion(paths, target)?.id, asked.id, "the step still waits for the person");
    await takeSession(paths, target, PERSON, { pid: JOINER, pollMs: 10 });
    assert.ok(leaveSession(paths, target, PERSON, { pid: JOINER }));
  });

  it("stops waiting when its signal stops it", async () => {
    const { paths, projectDir } = setup({ one: ONE_TURN });
    const { runId, worker } = start(paths, projectDir, "one", sessionRunner("done").inner);
    await worker;
    const target = joinTarget(paths, runId, "impl");
    const file = holdFile(paths, runId, "s-impl");
    takeHold(file, { pid: JOINER, by: "step", at: new Date().toISOString() });
    const stop = new AbortController();
    const taking = takeSession(paths, target, PERSON, { pid: process.pid, pollMs: 10, signal: stop.signal, onWait: () => stop.abort() });
    await assert.rejects(taking, /stopped waiting/);
    assert.equal(readHolder(file)?.pid, JOINER);
    releaseHold(file, JOINER);
  });

  it("gives what the agent asked with its program's own tool in the call, and nothing for a call that asked through its status", () => {
    const { paths } = setup();
    const runId = "run-asked";
    const write = activityWriter(paths, runId);
    const at = (callIndex: number) => ({ scope: runId, callIndex, label: "impl" });
    write(at(0), { kind: "prompt", text: "Build it." });
    write(at(0), { kind: "tool", tool: "request_user_input", text: "Which API should I call?\nOptions: v1, v2" });
    // The person answered, and the turn after it asked again, through its status.
    write(at(1), { kind: "prompt", text: CONTINUE_PROMPT });
    write(at(1), { kind: "tool", tool: "Bash", text: "ls" });
    write(at(1), { kind: "text", text: '{"status":"question","result":null,"message":"Which port?"}' });
    const target = (callIndex?: number): JoinTarget => ({
      runId,
      step: "impl",
      label: "impl",
      scope: runId,
      call: 1,
      ...(callIndex === undefined ? {} : { callIndex }),
      session: { ...REF, callIndex: callIndex ?? 1, label: "impl", keptOpen: false },
      running: false,
    });
    assert.equal(askedWords(paths, target(0)), "Which API should I call?\nOptions: v1, v2");
    assert.equal(askedWords(paths, target(1)), undefined, "that call asked through its status");
    assert.equal(askedWords(paths, target()), undefined, "by its label, the step's last turn began after the answer");
  });

  it("finds a handle's session by the handle's label, and refuses a step with no session", async () => {
    const script = `export const meta = { name: 'h', description: 'A handle, a code step, and a step that opens no session' }
const plan = session({ label: 'planner' })
await plan.send('Plan it.', { label: 'draft' })
await sh('echo hi', { label: 'shell' })
await agent('Quiet.', { label: 'quiet', until: 'turn' })
return 1`;
    const { paths, projectDir } = setup({ h: script });
    const { runner } = fakeRunner(() => "ok");
    const opensNone: InnerRunner = { run: async (prompt, request) => (request.label === "quiet" ? "ok" : runner.run(prompt, request)) };
    const { runId, worker } = start(paths, projectDir, "h", opensNone);
    await worker;

    const byHandle = joinTarget(paths, runId, "planner");
    assert.deepEqual([byHandle.step, byHandle.label, byHandle.session.handle, byHandle.session.sessionId], ["planner", "draft", "planner", "s1"]);
    assert.equal(joinTarget(paths, runId, "draft").session.sessionId, "s1", "a turn's own label names it too");

    assert.equal(refusalOf(() => joinTarget(paths, runId, "nope")).code, "no_such_step");
    const code = refusalOf(() => joinTarget(paths, runId, "shell"));
    assert.deepEqual([code.code, code.message], ["step_has_no_session", '"shell" is a code step, so it has no session to step into.']);
    assert.equal(refusalOf(() => joinTarget(paths, runId, "quiet")).code, "step_has_no_session");
    assert.equal(refusalOf(() => joinTarget(paths, runId, "draft", { call: 2 })).code, "no_such_step");
  });
});
