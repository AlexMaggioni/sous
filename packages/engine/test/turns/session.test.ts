// session() makes a handle, and send() runs one turn on it in the handle's one session. agent()
// is one send on a session no later step uses.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WorkflowError, WorkflowErrorCode } from "../../src/errors.js";
import { createSteps } from "../../src/steps/steps.js";
import { runWorkflow, type WorkflowRunOptions } from "../../src/workflow.js";
import { fakePlace, onFakes, type FakeLine, type FakePlace } from "../helpers/fake-steps.js";

for (const name of ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) delete process.env[name];

const MODEL = "claude/haiku";
const meta = "export const meta = { name: 'handles', description: 'session handles' }";

async function run(place: FakePlace, body: string, extra: Partial<WorkflowRunOptions> = {}) {
  const agent = createSteps(onFakes(place));
  try {
    return await runWorkflow(`${meta}\n${body}`, { agent, persistLogs: false, cwd: place.cwd, ...extra });
  } finally {
    await agent.dispose();
  }
}

/** Runs a script that the engine must refuse, and gives the refusal's message. */
async function refused(place: FakePlace, body: string, extra: Partial<WorkflowRunOptions> = {}): Promise<string> {
  let message = "";
  await assert.rejects(run(place, body, extra), (error: unknown) => {
    assert.ok(error instanceof WorkflowError, String(error));
    assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, error.message);
    message = error.message;
    return true;
  });
  return message;
}

const modelOf = (line: FakeLine | undefined) => (line as { model?: string } | undefined)?.model;

describe("session handles", () => {
  it("fails a second session() with a label in use, and a nested workflow has labels of its own", async () => {
    const place = fakePlace();
    const message = await refused(place, "session({ label: 'impl' })\nsession({ label: 'impl' })\nreturn 'no'");
    assert.match(message, /"impl"/);
    const child = "export const meta = { name: 'child', description: 'c' }\nreturn session({ label: 'impl' }).label";
    const result = await run(place, `const own = session({ label: 'impl' })\nreturn [own.label, await workflow(${JSON.stringify(child)})]`);
    assert.deepEqual(JSON.parse(JSON.stringify(result.result)), ["impl", "impl"]);
    assert.deepEqual(place.lines(), [], "a handle starts nothing");
  });

  it("fails a second send() on a handle while one runs", async () => {
    const place = fakePlace();
    const message = await refused(
      place,
      `const s = session({ label: 'impl', model: '${MODEL}' })
return await Promise.all([s.send('One.'), s.send('Two.')])`,
    );
    assert.match(message, /"impl"/);
    assert.match(message, /one turn at a time/);
  });

  it("runs three sends in one session: the first opens it, the second and third resume it", async () => {
    const place = fakePlace();
    const result = await run(
      place,
      `const s = session({ label: 'impl', model: '${MODEL}' })
await s.send('One.')
await s.send('Two.', { label: 'impl: two' })
await s.send('Three.')
return [s.label, s.cwd]`,
    );
    assert.deepEqual(JSON.parse(JSON.stringify(result.result)), ["impl", place.cwd]);
    const lines = place.lines();
    assert.equal(lines.length, 3);
    assert.deepEqual(lines.map((line) => line.resume), [false, true, true]);
    assert.equal(new Set(lines.map((line) => line.sessionId)).size, 1, "one session id");
  });

  it("gives each agent() call a fresh session, also after a handle's send", async () => {
    const place = fakePlace();
    await run(
      place,
      `const s = session({ label: 'impl', model: '${MODEL}' })
await s.send('One.')
await agent('Other.', { label: 'other', model: '${MODEL}' })
await agent('Other again.', { label: 'other', model: '${MODEL}' })
return 'ok'`,
    );
    const lines = place.lines();
    assert.deepEqual(lines.map((line) => line.resume), [false, false, false]);
    assert.equal(new Set(lines.map((line) => line.sessionId)).size, 3, "three sessions");
  });

  it("lets --set change a handle's model on the same program, and refuses another key or program", async () => {
    const place = fakePlace();
    const body = `const s = session({ label: 'impl', model: '${MODEL}' })
await s.send('One.')
await s.send('Two.')
return 'ok'`;
    await run(place, body, { stepOverrides: { impl: { model: "claude/sonnet" } } });
    assert.deepEqual(place.lines().map(modelOf), ["sonnet", "sonnet"]);
    assert.match(await refused(place, body, { stepOverrides: { impl: { effort: "high" } } }), /effort/);
    assert.match(await refused(place, body, { stepOverrides: { impl: { model: "codex/gpt-6.1-sol" } } }), /codex/);
    assert.equal(place.lines().length, 2, "a refused change runs no turn");
  });
});
