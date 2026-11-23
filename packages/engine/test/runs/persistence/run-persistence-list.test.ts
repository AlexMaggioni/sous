// list() reads every saved run of a project. A folder it cannot read gives no runs and no error.

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { workflowProjectPaths } from "../../../src/runs/persistence/project-paths.js";
import { createRunPersistence, type PersistedRunState } from "../../../src/runs/persistence/run-persistence.js";

const run = (runId: string): PersistedRunState => ({
  runId,
  workflowName: "list",
  script: "export const meta = { name: 'list', description: 'list' }\nreturn 1",
  status: "completed",
  phases: [],
  agents: [],
  logs: [],
  startedAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
});

describe("list() on runs it cannot read", () => {
  let cwd: string;
  let persistenceRoot: string;
  before(() => {
    cwd = mkdtempSync(join(tmpdir(), "engine-run-list-cwd-"));
    persistenceRoot = mkdtempSync(join(tmpdir(), "engine-run-list-root-"));
  });
  after(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(persistenceRoot, { recursive: true, force: true });
  });

  /** A folder of its own for each test, so one test's runs folder does not reach the next. */
  function project(name: string) {
    const projectDir = join(cwd, name);
    mkdirSync(projectDir, { recursive: true });
    const { runsDir } = workflowProjectPaths(projectDir, { persistenceRoot });
    return { persistence: createRunPersistence(projectDir, undefined, { persistenceRoot }), runsDir };
  }

  it("gives no runs when the runs path is a file, not a folder", () => {
    const { persistence, runsDir } = project("file-not-folder");
    mkdirSync(join(runsDir, ".."), { recursive: true });
    writeFileSync(runsDir, "not a folder");
    assert.deepEqual(persistence.list(), []);
  });

  it("gives no runs when the runs folder has no read permission", { skip: process.getuid?.() === 0 ? "root reads any folder" : false }, () => {
    const { persistence, runsDir } = project("no-permission");
    persistence.save(run("saved-before"));
    assert.equal(persistence.list().length, 1, "the run is listed while the folder can be read");
    chmodSync(runsDir, 0o000);
    try {
      assert.deepEqual(persistence.list(), []);
    } finally {
      chmodSync(runsDir, 0o755);
    }
  });

  it("skips a run file it cannot read and lists the runs beside it", () => {
    const { persistence, runsDir } = project("one-bad-file");
    persistence.save(run("kept"));
    mkdirSync(join(runsDir, "folder-named-like-a-run.json"));
    assert.deepEqual(persistence.list().map((saved) => saved.runId), ["kept"]);
  });
});
