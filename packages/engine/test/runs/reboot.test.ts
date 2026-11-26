import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { bootId, processAlive } from "../../src/process-alive.js";
import { knownProjects, rememberProject } from "../../src/runs/home.js";
import { createRun } from "../../src/runs/launch.js";
import { updateRecord } from "../../src/runs/records.js";
import { runDetail, stopRun } from "../../src/runs/run.js";
import { daemonPid, saveSchedules, tick } from "../../src/runs/service.js";
import { PERSON } from "../../src/testing.js";
import { plantState, quiet, setup } from "./fixture.js";

// What sous finds after a power cut, a dead battery or a crash of the service. A pid saved before
// a reboot may name another process now, and a file written just before the cut may not be on the
// disk. In each case sous neither starts a thing twice nor signals a process that is not its own.

/** A boot id that is not this boot's. */
const EARLIER_BOOT = "00000000-0000-0000-0000-000000000000";

const job = `export const meta = { name: 'job', description: 'j' }\nreturn 'done'`;
const AT = "2026-11-21T03:00:00.000Z";

describe("a pid saved in an earlier boot", () => {
  it("names no live process, though a process of this boot has its number", () => {
    assert.ok(bootId(), "Linux and macOS give a boot id");
    assert.equal(processAlive(process.pid), true, "a pid with no boot, as an older sous saved it");
    assert.equal(processAlive(process.pid, bootId()), true);
    assert.equal(processAlive(process.pid, EARLIER_BOOT), false);
  });

  it("leaves its run interrupted, and sous stop sends no signal to the process that has its number now", async () => {
    const { paths, projectDir } = setup({ job });
    const record = createRun(paths, { who: PERSON, workflow: "job", projectDir, inputs: {} });
    plantState(paths, { runId: record.runId, status: "running", startedAt: AT, updatedAt: AT, agents: [], logs: [], phases: [], script: readFileSync(record.file, "utf8") });

    updateRecord(paths, record.runId, { pid: process.pid, boot: bootId() });
    assert.equal(runDetail(paths, record.runId).status, "running", "a worker of this boot runs");

    // This process stands in for the one the new boot gave the old worker's pid.
    updateRecord(paths, record.runId, { pid: process.pid, boot: EARLIER_BOOT });
    assert.equal(runDetail(paths, record.runId).status, "interrupted");
    let signalled = false;
    const onTerm = () => {
      signalled = true;
    };
    process.on("SIGTERM", onTerm);
    try {
      assert.equal(stopRun(paths, record.runId, PERSON).outcome, "stopped");
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off("SIGTERM", onTerm);
    }
    assert.equal(signalled, false, "no SIGTERM to a process that is not the worker");
  });

  it("in the service's pid file names no service", () => {
    const { paths } = setup();
    const since = new Date().toISOString();
    writeFileSync(paths.daemonPid, JSON.stringify({ pid: process.pid, boot: EARLIER_BOOT, since }));
    assert.equal(daemonPid(paths), undefined);
    writeFileSync(paths.daemonPid, JSON.stringify({ pid: process.pid, boot: bootId(), since }));
    assert.equal(daemonPid(paths), process.pid);
    writeFileSync(paths.daemonPid, JSON.stringify({ pid: process.pid, since }));
    assert.equal(daemonPid(paths), process.pid, "a file an older sous wrote has the pid check alone");
  });
});

describe("a schedule after the service dies", () => {
  it("does not start twice when the service dies after the start and comes back within the minute", () => {
    const { paths, projectDir } = setup({ nightly: `export const meta = { name: 'nightly', description: 'n' }\nreturn 1` });
    saveSchedules(paths, [{ name: "n", workflow: join(projectDir, ".sous", "workflows", "nightly.js"), projectDir, cron: "0 3 * * *", inputs: {}, enabled: true, createdAt: "" }]);
    const started: string[] = [];
    let onDisk = "";
    const launch = (_paths: unknown, runId: string) => {
      started.push(runId);
      onDisk = existsSync(paths.daemonState) ? readFileSync(paths.daemonState, "utf8") : JSON.stringify({ fired: {}, resumes: {} });
    };
    tick(paths, launch, { now: new Date(2026, 10, 21, 3, 0, 5), log: quiet });
    assert.equal(started.length, 1);
    assert.equal((JSON.parse(onDisk) as { fired: Record<string, string> }).fired.n, "2026-11-21T03:00", "the minute is on the disk before the run starts");

    // The service died as the run started, before the end of its tick. The run was quick and done.
    writeFileSync(paths.daemonState, onDisk);
    plantState(paths, { runId: started[0]!, status: "completed", startedAt: AT, updatedAt: AT, completedAt: AT, agents: [], logs: [], phases: [] });
    tick(paths, launch, { now: new Date(2026, 10, 21, 3, 0, 40), log: quiet });
    assert.equal(started.length, 1, "the service that came back finds the minute fired");
  });

  it("starts each schedule once, though its project's runs work in worktrees that hold the same workflow files", () => {
    const nightly = `export const meta = { name: 'nightly', description: 'n', schedule: '0 3 * * *' }\nreturn 1`;
    const { paths, projectDir } = setup({ nightly });
    rememberProject(paths, projectDir);

    // A run's worktree is a checkout of the project, with its workflow files.
    const worktree = join(paths.worktrees, "nightly-abc123");
    mkdirSync(join(worktree, ".sous", "workflows"), { recursive: true });
    writeFileSync(join(worktree, ".sous", "workflows", "nightly.js"), nightly);
    rememberProject(paths, worktree);
    rememberProject(paths, realpathSync(worktree));
    assert.deepEqual(knownProjects(paths), [projectDir], "a worktree is not a project");

    // An older sous noted the worktrees of runs in projects.json.
    writeFileSync(paths.projects, JSON.stringify([projectDir, worktree, realpathSync(worktree)]));
    assert.deepEqual(knownProjects(paths), [projectDir]);

    const started: string[] = [];
    tick(paths, (_paths, runId) => started.push(runId), { now: new Date(2026, 10, 21, 3, 0, 5), log: quiet });
    assert.equal(started.length, 1);
  });
});
