// The line the worker writes to the run's log when the run ends.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRun } from "../../src/runs/launch.js";
import { runWorker } from "../../src/runs/worker.js";
import { heldRunner, setup } from "./fixture.js";

describe("the worker's last line", () => {
  it("says why a step failed, on a start and on a resume alike", async () => {
    const { paths, projectDir } = setup({
      two: `export const meta = { name: 'two', description: 'one step' }\nreturn await agent('write it', { label: 'writer' })`,
    });
    const record = createRun(paths, { workflow: "two", projectDir, inputs: {}, place: "folder" });
    const { runner } = heldRunner(() => new Error("the disk is full"));
    const last = async (mode: "start" | "resume") => {
      const lines: string[] = [];
      const result = await runWorker(record.runId, mode, { paths, inner: runner, pollMs: 20, log: (line) => lines.push(line.slice(9)) });
      assert.equal(result?.status ?? "paused", "paused", lines.join("\n"));
      return lines.filter((line) => line.startsWith("paused ")).at(-1);
    };
    const started = await last("start");
    const resumed = await last("resume");
    assert.equal(started, 'paused     two (step_failed): step "writer" failed after 3 tries: the disk is full');
    assert.equal(resumed, started);
  });
});
