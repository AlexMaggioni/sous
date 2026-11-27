// The hold on a session: one writer at a time, a holder whose process ended holds nothing, and a
// hand-over from the worker to the person's `sous join`.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { PERSON } from "../../src/testing.js";
import { createRun } from "../../src/runs/launch.js";
import { readHolder, releaseHold, sessionHolds, takeHold, type Holder } from "../../src/runs/session-hold.js";
import { holdFile, removeRunFiles } from "../../src/runs/store.js";
import { setup } from "./fixture.js";

const RUN = "run-1";
const SESSION = "0b9f6c1e-5a2d-4c3b-9e8f-1a2b3c4d5e6f";
const at = "2026-11-27T00:00:00.000Z";

/** The pid of a process that has ended. */
const deadPid = (): number => spawnSync("true").pid!;

function home() {
  const { paths } = setup();
  mkdirSync(paths.records, { recursive: true });
  return paths;
}

describe("the hold on a session", () => {
  it("lives next to the run's record, named after the root run, and refuses a name that is not a session id", () => {
    const paths = home();
    assert.equal(holdFile(paths, `${RUN}-nested2`, SESSION), holdFile(paths, RUN, SESSION));
    assert.ok(holdFile(paths, RUN, SESSION).startsWith(paths.records));
    assert.throws(() => holdFile(paths, RUN, "../etc"), /not a session id/);
  });

  it("takes one holder at a time, and a second take gets the live holder", () => {
    const file = holdFile(home(), RUN, SESSION);
    const step: Holder = { pid: process.pid, by: "step", at, label: "build" };
    assert.equal(takeHold(file, step), undefined);
    assert.deepEqual(readHolder(file), step);
    const person: Holder = { pid: process.ppid, by: "join", at };
    assert.deepEqual(takeHold(file, person), step, "the step keeps the session");
    assert.deepEqual(readHolder(file), step);
  });

  it("lets a new holder take a session whose holder's process ended", () => {
    const file = holdFile(home(), RUN, SESSION);
    writeFileSync(file, JSON.stringify({ pid: deadPid(), by: "join", at }));
    assert.equal(readHolder(file), undefined, "an ended holder holds nothing");
    const step: Holder = { pid: process.pid, by: "step", at };
    assert.equal(takeHold(file, step), undefined);
    assert.deepEqual(readHolder(file), step);
  });

  it("lets a new holder take a session whose file is broken", () => {
    const file = holdFile(home(), RUN, SESSION);
    writeFileSync(file, "{");
    assert.equal(takeHold(file, { pid: process.pid, by: "step", at }), undefined);
    assert.equal(readHolder(file)?.pid, process.pid);
  });

  it("hands the session over only from its holder, or when nobody holds it", () => {
    const paths = home();
    const file = holdFile(paths, RUN, SESSION);
    const holds = sessionHolds(paths);
    const who = (holder: Holder | undefined) => [holder?.pid, holder?.by];
    assert.equal(holds.give(RUN, SESSION, process.ppid), undefined, "nobody held it");
    assert.deepEqual(who(readHolder(file)), [process.ppid, "join"]);
    assert.deepEqual(who(holds.give(RUN, SESSION, process.pid)), [process.ppid, "join"], "the person keeps it");
    releaseHold(file, process.ppid);
    assert.equal(existsSync(file), false);
    takeHold(file, { pid: process.pid, by: "step", at });
    assert.equal(holds.give(RUN, SESSION, process.ppid), undefined, "the holder hands it over");
    assert.deepEqual(who(readHolder(file)), [process.ppid, "join"]);
  });

  it("lets go only of a session its own process holds", () => {
    const file = holdFile(home(), RUN, SESSION);
    takeHold(file, { pid: process.ppid, by: "join", at });
    releaseHold(file, process.pid);
    assert.equal(readHolder(file)?.pid, process.ppid, "another process keeps its hold");
    releaseHold(file, process.ppid);
    assert.equal(existsSync(file), false);
  });

  it("is bound to a home and a process for the steps module, and the run's delete removes every hold", () => {
    const { paths, projectDir } = setup({ one: "export const meta = { name: 'one', description: 'One' }\nreturn 1" });
    const record = createRun(paths, { who: PERSON, workflow: "one", projectDir, inputs: {} });
    const RUN = record.runId;
    const holds = sessionHolds(paths, { pollMs: 10 });
    assert.equal(holds.pollMs, 10);
    assert.equal(holds.take(RUN, SESSION, "build"), undefined);
    assert.deepEqual(
      { pid: holds.held(RUN, SESSION)?.pid, by: holds.held(RUN, SESSION)?.by, label: holds.held(RUN, SESSION)?.label },
      { pid: process.pid, by: "step", label: "build" },
    );
    assert.equal(holds.take(`${RUN}-nested1`, "other-session", "review"), undefined);
    assert.equal(holdFile(paths, `${RUN}-nested1`, "other-session"), holdFile(paths, RUN, "other-session"), "a nested run's hold is its root run's");
    const other = holdFile(paths, "run-2", SESSION);
    takeHold(other, { pid: process.pid, by: "step", at });

    assert.equal(holds.give(RUN, SESSION, process.ppid), undefined);
    assert.deepEqual(JSON.parse(readFileSync(holdFile(paths, RUN, SESSION), "utf8")).by, "join");
    holds.release(RUN, SESSION);
    assert.equal(holds.held(RUN, SESSION)?.pid, process.ppid, "the worker no longer holds what it handed over");

    removeRunFiles(paths, record);
    assert.deepEqual([existsSync(holdFile(paths, RUN, SESSION)), existsSync(holdFile(paths, RUN, "other-session"))], [false, false]);
    assert.equal(existsSync(other), true, "another run keeps its holds");
  });
});
