import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { loadRecord } from "../../src/runs/records.js";
import { managerFor, runWorker } from "../../src/runs/worker.js";
import type { PersistedRunState } from "../../src/runs/persistence/run-persistence.js";
import { heldRunner, setup } from "./fixture.js";

// A run the code before step 4 started. Its sh and js steps went to the steps module as agent
// calls with model "exec" and finished; its agent step failed, so the run paused. The fixture
// holds its record and the state the engine saved.
const FIXTURE = join(import.meta.dirname, "..", "fixtures", "old-code-steps-run.json");

describe("a run started by the old code", () => {
  it("resumes on the new code and replays its finished code steps without running them", async () => {
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
      record: { runId: string };
      workflows: Record<string, string>;
      state: PersistedRunState;
    };
    const { paths, projectDir } = setup({ old_journal: fixture.workflows.old_journal! });
    const root = dirname(projectDir);
    const place = <T>(value: T): T => JSON.parse(JSON.stringify(value).replaceAll("__ROOT__", root)) as T;
    const runId = fixture.record.runId;
    writeFileSync(join(paths.records, `${runId}.json`), JSON.stringify(place(fixture.record), null, 2));
    writeFileSync(join(paths.records, `${runId}.workflows`), JSON.stringify(fixture.workflows));
    managerFor(paths, projectDir).getPersistence().save(place(fixture.state));
    // The old run's sh step appended this line. A second run of it would add another.
    const marker = join(projectDir, "marker.txt");
    writeFileSync(marker, "ran\n");

    const { runner, calls } = heldRunner(() => "a line");
    const lines: string[] = [];
    const result = await runWorker(runId, "resume", { paths, inner: runner, pollMs: 20, log: (line) => lines.push(line.slice(9)) });

    assert.equal(readFileSync(marker, "utf8"), "ran\n", "the sh step did not run again");
    assert.deepEqual(calls.map((call) => call.label), ["writer"], "only the agent step reached the runner");
    assert.equal(result?.status, "completed", lines.join("\n"));
    assert.deepEqual(JSON.parse(JSON.stringify(result?.result)), { first: "first", sum: 42, text: "a line" });
    assert.equal(loadRecord(paths, runId)?.runId, runId);
  });
});
