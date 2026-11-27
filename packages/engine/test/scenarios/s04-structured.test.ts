// Scenario 4 of docs/features/workflow-shape/ACCEPTANCE.md: structured data between steps.
// A planner returns tickets against a schema. Each ticket goes into a nested workflow as typed
// input, and each returns { branch, summary, tests }. A ticket that misses a required field fails
// before its nested workflow's first step runs.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { startRun } from "../../src/runs/run.js";
import { PERSON, fakeRunner, inProcess, testHome } from "../../src/testing.js";

// The planner runs one turn: the done loop of phase 3 is not in yet.
const PLAN = `export const meta = { name: 'plan', description: 'plans tickets and builds each' }
const plan = await agent('Plan the work', { label: 'planner', until: 'turn', schema: {
  type: 'object', required: ['tickets'],
  properties: { tickets: { type: 'array', items: { type: 'object' } } } } })
return await parallel(plan.tickets.map((ticket) => () => workflow('ticket', { ticket })))`;

const TICKET = `export const meta = { name: 'ticket', description: 'builds one ticket',
  inputs: { ticket: { type: 'json', schema: {
    type: 'object', required: ['id', 'title'],
    properties: { id: { type: 'string' }, title: { type: 'string' } } } } },
  schema: {
    type: 'object', required: ['branch', 'summary', 'tests'],
    properties: { branch: { type: 'string' }, summary: { type: 'string' }, tests: { type: 'array', items: { type: 'string' } } } } }
return await agent('Build ' + args.ticket.title, { label: 'build ' + args.ticket.id, until: 'turn' })`;

const TICKETS = [
  { id: "t1", title: "Add the flag" },
  { title: "No id" },
  { id: "t3", title: "Write the docs" },
];

describe("scenario 4: structured data between steps", () => {
  it("a ticket that misses a required field fails before its nested workflow's first step, and the others return checked objects", async () => {
    const { paths, projectDir } = testHome({ plan: PLAN, ticket: TICKET });
    const { runner, calls } = fakeRunner((call) => {
      if (call.label === "planner") return { tickets: TICKETS };
      const id = String(call.label).replace("build ", "");
      return { branch: `sous/${id}`, summary: `built ${id}`, tests: [`${id}.test.ts`] };
    });
    const lines: string[] = [];
    const workers = inProcess({ inner: runner, log: (line) => lines.push(line) });
    const record = startRun(paths, workers.launch, { who: PERSON, workflow: "plan", projectDir, inputs: {} });
    const result = await workers.ended(record.runId);

    const root = record.runId;
    assert.deepEqual(
      calls.map((call) => [call.label, call.options.runId]).sort(),
      [["build t1", `${root}-nested1`], ["build t3", `${root}-nested3`], ["planner", root]],
      "the second ticket's nested workflow ran no step",
    );
    const failed = lines.find((line) => line.includes("parallel[1] failed"));
    assert.match(failed ?? "", /workflow\("ticket"\): --ticket does not fit its schema: .*id/);
    assert.equal(result?.status, "completed");
    assert.deepEqual(result?.result, [
      { branch: "sous/t1", summary: "built t1", tests: ["t1.test.ts"] },
      null,
      { branch: "sous/t3", summary: "built t3", tests: ["t3.test.ts"] },
    ]);
  });

  it("a nested workflow whose result misses a field fails its workflow() call", async () => {
    const { paths, projectDir } = testHome({ plan: PLAN, ticket: TICKET });
    const { runner } = fakeRunner((call) => (call.label === "planner" ? { tickets: [TICKETS[0]] } : { branch: "sous/t1", summary: "no tests" }));
    const lines: string[] = [];
    const workers = inProcess({ inner: runner, log: (line) => lines.push(line) });
    const record = startRun(paths, workers.launch, { who: PERSON, workflow: "plan", projectDir, inputs: {} });
    const result = await workers.ended(record.runId);
    assert.deepEqual(result?.result, [null]);
    assert.ok(lines.some((line) => /parallel\[0\] failed: workflow\("ticket"\): its result does not fit meta.schema: .*tests/.test(line)));
  });
});
