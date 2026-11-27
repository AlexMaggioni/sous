// A running step reports its session to the host twice: at open, marked not delivered, and again
// once the program has the prompt. Each report carries the call's identity, the same as the call
// row the step ends with, so a host that saves it can go on in the session after its process died.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentSessionRef } from "../src/workflow-result.js";
import { runWorkflow, type WorkflowRunOptions } from "../src/workflow.js";
import type { WorkflowCallRecord } from "../src/workflow-result.js";
import { runnerFrom } from "./helpers/runners.js";
import { tempDirs } from "./helpers/temp.js";

type TurnSession = Parameters<NonNullable<WorkflowRunOptions["onTurnSession"]>>[0];

const script = (body: string) => `export const meta = { name: "turn-session", description: "a step's session while it runs" }
${body}`;

/** A runner that opens session s1, reports it delivered, then answers. `between` runs at each report. */
function twoReports(between: () => void) {
  return runnerFrom((_prompt, options) => {
    const ref: AgentSessionRef = { sessionId: "s1", backendId: "claude", poolKey: "claude", cwd: options.cwd ?? "", reopen: { load: true, resume: true, list: true } };
    options.onSessionOpen?.({ ...ref, delivered: false });
    between();
    options.onSessionOpen?.(ref);
    between();
    return "done";
  });
}

describe("a running step's session", () => {
  it("reaches the host at open and at delivery, with the identity of the call row it ends with", async () => {
    const dirs = tempDirs("turn-session");
    try {
      const turns: TurnSession[] = [];
      const rows: WorkflowCallRecord[] = [];
      const seen: number[] = [];
      const run = await runWorkflow(script("return await agent('finish the task', { label: 'worker', until: 'turn' })"), {
        cwd: dirs.cwd,
        persistLogs: false,
        agent: twoReports(() => seen.push(turns.length)),
        onTurnSession: (event) => turns.push(event),
        onCallRecord: (row) => rows.push(row),
      });
      assert.equal(run.result, "done");
      assert.deepEqual(seen, [1, 2], "each report reached the host while the step ran");
      assert.deepEqual(turns.map((turn) => turn.session.delivered), [false, undefined]);
      const [row] = rows;
      assert.ok(row?.inputsHash && row.resolvedCwd);
      for (const turn of turns) {
        assert.deepEqual(
          { callIndex: turn.callIndex, scope: turn.scope, hash: turn.hash, inputsHash: turn.inputsHash, path: turn.path, resolvedCwd: turn.resolvedCwd },
          { callIndex: row.index, scope: row.scope, hash: row.hash, inputsHash: row.inputsHash, path: row.path, resolvedCwd: row.resolvedCwd },
        );
        assert.deepEqual([turn.session.sessionId, turn.session.backendId, turn.session.callIndex, turn.session.label, turn.session.keptOpen], ["s1", "claude", 0, "worker", false]);
      }
    } finally {
      dirs.cleanup();
    }
  });

  it("marks a session handle's step kept open", async () => {
    const turns: TurnSession[] = [];
    await runWorkflow(script("const s = session({ label: 'worker' })\nreturn await s.send('finish the task', { until: 'turn' })"), {
      persistLogs: false,
      agent: twoReports(() => {}),
      onTurnSession: (event) => turns.push(event),
    });
    assert.deepEqual(turns.map((turn) => turn.session.keptOpen), [true, true]);
  });

  it("leaves the step running when the host throws", async () => {
    const run = await runWorkflow(script("return await agent('finish the task', { label: 'worker', until: 'turn' })"), {
      persistLogs: false,
      agent: twoReports(() => {}),
      onTurnSession: () => {
        throw new Error("disk full");
      },
    });
    assert.equal(run.result, "done");
  });
});
