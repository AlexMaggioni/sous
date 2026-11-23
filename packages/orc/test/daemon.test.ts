import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { daemonLog, daemonPid, type HomePaths } from "@orchestrator/engine";
import { processAlive, testHome } from "@orchestrator/engine/testing";
import { cliFile } from "../src/cli.js";
import { orc, waitFor } from "./orc.js";
import "./harness-home.js";

// orc daemon start, stop and status. The commands that need no process run in this process, on a
// pid file that names a stand-in. One test starts the real service from the built orc.

const plant = (paths: HomePaths, pid: number) => writeFileSync(paths.daemonPid, JSON.stringify({ pid, since: "2026-11-23T10:00:00.000Z" }));

/** A pid that no process has now: a child that already ended. */
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid!;

/** A process that does nothing until it gets a signal, and how it ended. */
function standIn() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  let ended: string | undefined;
  child.on("exit", (code, signal) => (ended = signal ?? `exit ${code}`));
  return { pid: child.pid!, ended: () => ended, kill: () => child.kill("SIGKILL") };
}

describe("orc daemon", () => {
  it("says the service is not running, with exit 1 for status and 0 for stop", async () => {
    const { paths } = testHome();
    const status = await orc(paths, ["daemon", "status"]);
    assert.deepEqual(status, { code: 1, out: "the service is not running: orc daemon start\n" });
    assert.deepEqual(await orc(paths, ["daemon"]), status, "status is the default");
    assert.deepEqual(await orc(paths, ["daemon", "stop"]), { code: 0, out: "the service is not running\n" });
  });

  it("does not count a pid file whose process has ended", async () => {
    const { paths } = testHome();
    plant(paths, deadPid());
    assert.deepEqual(await orc(paths, ["daemon", "status"]), { code: 1, out: "the service is not running: orc daemon start\n" });
    assert.deepEqual(await orc(paths, ["daemon", "stop"]), { code: 0, out: "the service is not running\n" });
  });

  it("refuses an action it does not know", async () => {
    const { paths } = testHome();
    const run = await orc(paths, ["daemon", "restart"]);
    assert.deepEqual(run, { code: 64, out: "usage: orc daemon start|stop|status|run\n" });
  });

  it("reports a running service, starts no second one, and stops it with SIGTERM", async () => {
    const { paths } = testHome();
    const service = standIn();
    try {
      plant(paths, service.pid);
      const log = daemonLog(paths);
      assert.deepEqual(await orc(paths, ["daemon", "status"]), { code: 0, out: `the service runs (pid ${service.pid}). Log: ${log}\n` });
      assert.deepEqual(await orc(paths, ["daemon", "start"]), { code: 0, out: `the service runs already (pid ${service.pid})\n` });
      assert.equal(existsSync(log), false, "no second service opened the log");
      assert.equal(service.ended(), undefined, "the stand-in still runs");

      assert.deepEqual(await orc(paths, ["daemon", "stop"]), { code: 0, out: `stopping the service (pid ${service.pid})\n` });
      await waitFor(() => service.ended() !== undefined, "the service to end");
      assert.equal(service.ended(), "SIGTERM");
    } finally {
      service.kill();
    }
  });

  it("starts the service as a process of its own, and stops it, which removes its pid file", async () => {
    const { paths } = testHome();
    const env = { ...process.env, ORC_HOME: paths.home };
    const log = daemonLog(paths);
    try {
      // The service is the built orc, since a start spawns the file it was started from.
      const started = execFileSync(process.execPath, [cliFile(), "daemon", "start"], { env, encoding: "utf8" });
      const pid = Number(/^the service started \(pid (\d+)\)\. Log: (.+)\n$/.exec(started)?.[1]);
      assert.ok(pid > 0, started);
      assert.ok(started.endsWith(`Log: ${log}\n`), started);
      await waitFor(() => daemonPid(paths) === pid, "the service to write its pid file");

      assert.deepEqual(await orc(paths, ["daemon", "status"]), { code: 0, out: `the service runs (pid ${pid}). Log: ${log}\n` });
      assert.deepEqual(await orc(paths, ["daemon", "start"]), { code: 0, out: `the service runs already (pid ${pid})\n` });

      assert.deepEqual(await orc(paths, ["daemon", "stop"]), { code: 0, out: `stopping the service (pid ${pid})\n` });
      await waitFor(() => !processAlive(pid), "the service to end");
      assert.equal(existsSync(paths.daemonPid), false, "it removes its pid file");
      assert.match(readFileSync(log, "utf8"), / service started\n.* service stopped\n$/);
      assert.equal((await orc(paths, ["daemon", "status"])).code, 1);
    } finally {
      const left = daemonPid(paths);
      if (left) process.kill(left, "SIGKILL");
    }
  });
});
