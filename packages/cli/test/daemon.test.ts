import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { daemonLog, daemonPid, type HomePaths } from "@sous/engine";
import { processAlive, testHome } from "@sous/engine/testing";
import { cliFile } from "../src/cli.js";
import { sous, waitFor } from "./sous.js";
import { deadPid } from "./helpers/process.js";

// sous daemon start, stop and status. The commands that need no process run in this process, on a
// pid file that names a stand-in. One test starts the real service from the built sous.

const plant = (paths: HomePaths, pid: number) => writeFileSync(paths.daemonPid, JSON.stringify({ pid, since: "2026-11-23T10:00:00.000Z" }));

/** A process that does nothing until it gets a signal, and how it ended. */
function standIn() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  let ended: string | undefined;
  child.on("exit", (code, signal) => (ended = signal ?? `exit ${code}`));
  return { pid: child.pid!, ended: () => ended, kill: () => child.kill("SIGKILL") };
}

describe("sous daemon", () => {
  it("says the service is not running, with exit 0 for status and stop, since it is a state", async () => {
    const { paths } = testHome();
    const status = await sous(paths, ["daemon", "status"]);
    assert.deepEqual(status, { code: 0, out: "the service is not running: sous daemon start\nnext: sous daemon start --json  (starts the service)\n" });
    assert.deepEqual(await sous(paths, ["daemon"]), status, "status is the default");
    assert.deepEqual(await sous(paths, ["daemon", "stop"]), { code: 0, out: "the service is not running\n" });
  });

  it("does not count a pid file whose process has ended", async () => {
    const { paths } = testHome();
    plant(paths, deadPid());
    assert.deepEqual(await sous(paths, ["daemon", "status"]), { code: 0, out: "the service is not running: sous daemon start\nnext: sous daemon start --json  (starts the service)\n" });
    assert.deepEqual(await sous(paths, ["daemon", "stop"]), { code: 0, out: "the service is not running\n" });
  });

  it("replies with --json: whether the service runs, its pid and its log, with a note and next when it does not run", async () => {
    const { paths } = testHome();
    const log = daemonLog(paths);
    const status = await sous(paths, ["daemon", "status", "--json"]);
    assert.equal(status.code, 0, status.out);
    assert.deepEqual(JSON.parse(status.out), {
      running: false,
      pid: null,
      log,
      notes: ["the service is not running"],
      next: [{ call: "sous daemon start --json", does: "starts the service" }],
    });
    const stop = await sous(paths, ["daemon", "stop", "--json"]);
    assert.deepEqual(JSON.parse(stop.out), { running: false, pid: null, log, notes: ["the service is not running, so nothing stops."], next: [] });

    const service = standIn();
    try {
      plant(paths, service.pid);
      assert.deepEqual(JSON.parse((await sous(paths, ["daemon", "status", "--json"])).out), { running: true, pid: service.pid, log, notes: [], next: [] });
      const start = JSON.parse((await sous(paths, ["daemon", "start", "--json"])).out) as { running: boolean; pid: number; notes: string[] };
      assert.deepEqual([start.running, start.pid, start.notes], [true, service.pid, ["the service runs already, so nothing started."]]);
      const stopping = await sous(paths, ["daemon", "stop", "--json"]);
      assert.equal(stopping.code, 0, stopping.out);
      assert.deepEqual((JSON.parse(stopping.out) as { pid: number }).pid, service.pid);
      await waitFor(() => service.ended() !== undefined, "the service to end");
    } finally {
      service.kill();
    }
  });

  it("refuses an action it does not know", async () => {
    const { paths } = testHome();
    const run = await sous(paths, ["daemon", "restart"]);
    assert.deepEqual(run, { code: 64, out: "usage: sous daemon start|stop|status|run\n  change: Fix the command line. sous help lists the commands and their flags.\n" });
  });

  it("reports a running service, starts no second one, and stops it with SIGTERM", async () => {
    const { paths } = testHome();
    const service = standIn();
    try {
      plant(paths, service.pid);
      const log = daemonLog(paths);
      assert.deepEqual(await sous(paths, ["daemon", "status"]), { code: 0, out: `the service runs (pid ${service.pid}). Log: ${log}\n` });
      assert.deepEqual(await sous(paths, ["daemon", "start"]), { code: 0, out: `the service runs already (pid ${service.pid})\n` });
      assert.equal(existsSync(log), false, "no second service opened the log");
      assert.equal(service.ended(), undefined, "the stand-in still runs");

      assert.deepEqual(await sous(paths, ["daemon", "stop"]), { code: 0, out: `stopping the service (pid ${service.pid})\nnext: sous daemon status --json  (says whether the service still runs)\n` });
      await waitFor(() => service.ended() !== undefined, "the service to end");
      assert.equal(service.ended(), "SIGTERM");
    } finally {
      service.kill();
    }
  });

  it("starts the service as a process of its own, and stops it, which removes its pid file", async () => {
    const { paths } = testHome();
    const env = { ...process.env, SOUS_HOME: paths.home };
    const log = daemonLog(paths);
    try {
      // The service is the built sous, since a start spawns the file it was started from.
      const started = execFileSync(process.execPath, [cliFile(), "daemon", "start"], { env, encoding: "utf8" });
      const pid = Number(/^the service started \(pid (\d+)\)\. Log: (.+)\n$/.exec(started)?.[1]);
      assert.ok(pid > 0, started);
      assert.ok(started.endsWith(`Log: ${log}\n`), started);
      await waitFor(() => daemonPid(paths) === pid, "the service to write its pid file");

      assert.deepEqual(await sous(paths, ["daemon", "status"]), { code: 0, out: `the service runs (pid ${pid}). Log: ${log}\n` });
      assert.deepEqual(await sous(paths, ["daemon", "start"]), { code: 0, out: `the service runs already (pid ${pid})\n` });

      assert.deepEqual(await sous(paths, ["daemon", "stop"]), { code: 0, out: `stopping the service (pid ${pid})\nnext: sous daemon status --json  (says whether the service still runs)\n` });
      await waitFor(() => !processAlive(pid), "the service to end");
      assert.equal(existsSync(paths.daemonPid), false, "it removes its pid file");
      assert.match(readFileSync(log, "utf8"), / service started\n.* service stopped\n$/);
      assert.deepEqual(await sous(paths, ["daemon", "status"]), { code: 0, out: "the service is not running: sous daemon start\nnext: sous daemon start --json  (starts the service)\n" });
    } finally {
      const left = daemonPid(paths);
      if (left) process.kill(left, "SIGKILL");
    }
  });
});
