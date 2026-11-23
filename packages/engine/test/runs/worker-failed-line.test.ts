// The line the worker writes to the run's log when the run ends. A failed run gives its reason,
// and a run that ended well gives none.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRun } from "../../src/runs/launch.js";
import { runWorker } from "../../src/runs/worker.js";
import { heldRunner, setup } from "./fixture.js";

async function lastLine(script: string, startsWith: string): Promise<{ line: string | undefined; status: string | undefined; lines: string[] }> {
  const { paths, projectDir } = setup({ flow: script });
  const record = createRun(paths, { workflow: "flow", projectDir, inputs: {}, place: "folder" });
  const { runner } = heldRunner(() => "ok");
  const lines: string[] = [];
  const result = await runWorker(record.runId, "start", { paths, inner: runner, pollMs: 20, log: (line) => lines.push(line.slice(9)) });
  return { line: lines.filter((line) => line.startsWith(startsWith)).at(-1), status: result?.status, lines };
}

describe("the worker's last line for a run that failed", () => {
  it("names the run's reason after the workflow's name", async () => {
    const { line, status, lines } = await lastLine(
      "export const meta = { name: 'flow', description: 'fails' }\nthrow new Error('the script broke')",
      "failed",
    );
    assert.equal(status, "failed", lines.join("\n"));
    assert.equal(line, "failed     flow: the script broke");
  });

  it("gives the message of a bad call to a script function", async () => {
    const { line, status, lines } = await lastLine("export const meta = { name: 'flow', description: 'fails' }\nreturn await sh('')", "failed");
    assert.equal(status, "failed", lines.join("\n"));
    assert.match(line ?? "", /^failed     flow: sh\(command\) /);
  });
});

describe("the worker's last line for a run that completed", () => {
  it("has the status and the workflow's name, and no reason", async () => {
    const { line, status, lines } = await lastLine("export const meta = { name: 'flow', description: 'works' }\nreturn 1", "completed");
    assert.equal(status, "completed", lines.join("\n"));
    assert.equal(line, "completed  flow");
  });
});
