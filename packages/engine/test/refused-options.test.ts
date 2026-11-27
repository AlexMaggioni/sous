import assert from "node:assert/strict";
import test from "node:test";
import type { TSchema } from "typebox";
import type { AgentResult } from "../src/steps/agent-run.js";
import type { AgentRunner } from "../src/steps/agent-runner.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { runWorkflow } from "../src/workflow.js";

// The names a session handle replaced. A script that still uses one is refused before any step
// runs, with a message that names what to write instead.

function countingRunner(): { runner: AgentRunner; calls: () => number } {
  let calls = 0;
  const runner: AgentRunner = {
    async run<S extends TSchema | undefined = undefined>(): Promise<AgentResult<S>> {
      calls++;
      return "ok" as AgentResult<S>;
    },
  };
  return { runner, calls: () => calls };
}

async function refuses(body: string, message: string): Promise<void> {
  const { runner, calls } = countingRunner();
  const script = `export const meta = { name: 'refused', description: 'refused' }\n${body}`;
  await assert.rejects(runWorkflow(script, { agent: runner, persistLogs: false }), (error: unknown) => {
    assert.ok(error instanceof WorkflowError);
    assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
    assert.equal(error.message, message);
    return true;
  });
  assert.equal(calls(), 0, "the script never reaches the runner");
}

const SESSION = "Make a session with session() and send() each turn on it.";
const LOOP = "Give the step check and maxTurns, or write a plain loop.";

const REFUSED_STEP_OPTIONS = [
  { option: "keepSession", value: "true", message: `keepSession is gone. ${SESSION}` },
  { option: "continue", value: "'a'", message: `continue is gone. ${SESSION}` },
  { option: "isolation", value: "'worktree'", message: 'isolation is gone. Write place: "worktree" instead.' },
  { option: "configOptions", value: "{ thinking: 'high' }", message: "configOptions is gone. No program read it. Remove it from the step." },
  { option: "answeredBy", value: "'anyone'", message: "answeredBy is gone. Remove it. The person steps in with `sous join`." },
];

for (const { option, value, message } of REFUSED_STEP_OPTIONS) {
  test(`agent() refuses ${option} with what to write instead`, async () => {
    await refuses(`return await agent('p', { label: 'a', ${option}: ${value} })`, message);
  });
}

test("send() refuses keepSession with what to write instead", async () => {
  await refuses(`const s = session({ label: 's' })\nreturn await s.send('p', { keepSession: true })`, `keepSession is gone. ${SESSION}`);
});

const REFUSED_GLOBALS = [
  { call: "retry(() => agent('p'))", message: `retry() is gone. ${LOOP}` },
  { call: "gate(() => agent('p'), () => true)", message: `gate() is gone. ${LOOP}` },
  { call: "checkpoint('Ship it?')", message: "checkpoint() is gone. Use ask() to ask the person." },
];

for (const { call, message } of REFUSED_GLOBALS) {
  test(`${call.split("(")[0]}() fails the script with what to write instead`, async () => {
    await refuses(`return await ${call}`, message);
  });
}

test("a place other than worktree on session() or agent() fails the script", async () => {
  await refuses("const s = session({ label: 's', place: 'folder' })\nreturn await s.send('p')", 'session "s": place is "worktree"');
  await refuses("return await agent('p', { place: 'folder' })", 'agent(): place is "worktree"');
});
