import assert from "node:assert/strict";
import { request } from "node:http";
import { describe, it } from "node:test";
import { testHome } from "@sous-run/engine/testing";
import { main } from "../src/cli.js";
import type { Machine } from "../src/commands/index.js";
import { waitFor } from "./sous.js";

// sous serve as a command: who may start it, what it prints, and how it stops.

/** A terminal that keeps what sous prints and the links it opens. Ctrl-C is stop(). */
function terminal(isTerminal: boolean) {
  const out: string[] = [];
  const opened: string[] = [];
  let stop = () => {};
  const stopped = new Promise<void>((done) => (stop = done));
  const no = () => {
    throw new Error("sous serve does not do this");
  };
  const machine: Machine = {
    readText: no,
    exists: no,
    guideDir: "",
    skillDir: "",
    spawnDaemon: no,
    kill: no,
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    version: "0.0.0",
    cliPath: "",
    latestVersion: no,
    run: no,
    isTerminal,
    ask: no,
    open: (url) => opened.push(url),
    untilStopped: () => stopped,
    out: (line) => out.push(line),
    write: (text) => out.push(text),
    err: (line) => out.push(line),
  };
  return { machine, out, opened, stop };
}

/** Run sous on a test home with this environment, as main runs at the terminal. */
async function onHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  const before = process.env.SOUS_HOME;
  process.env.SOUS_HOME = home;
  try {
    return await run();
  } finally {
    if (before === undefined) delete process.env.SOUS_HOME;
    else process.env.SOUS_HOME = before;
  }
}

function get(url: string): Promise<{ status: number; location?: string; cookie?: string }> {
  return new Promise((done, fail) => {
    request(url, (res) => {
      res.resume();
      res.on("end", () => done({ status: res.statusCode!, location: res.headers.location, cookie: res.headers["set-cookie"]?.[0] }));
    })
      .on("error", fail)
      .end();
  });
}

describe("sous serve", () => {
  it("is refused through a step of a run, which has no person to read the page", async () => {
    const { paths, projectDir } = testHome();
    const { machine, out } = terminal(false);
    const env = { ...process.env, SOUS_RUN_ID: "r-1" };
    const code = await onHome(paths.home, () => main(["serve", "--project", projectDir, "--json"], { machine, env }));
    assert.equal(code, 66);
    const { error } = JSON.parse(out.join("\n")) as { error: { code: string; call: string | null } };
    assert.equal(error.code, "no_person_here");
    assert.equal(error.call, null);
  });

  it("from an agent, needs --by person, and says so with the call to make", async () => {
    const { paths } = testHome();
    const { machine, out } = terminal(false);
    const env = { ...process.env, CLAUDECODE: "1" };
    const code = await onHome(paths.home, () => main(["serve", "--no-open", "--port", "0", "--json"], { machine, env }));
    assert.notEqual(code, 0);
    const { error } = JSON.parse(out.join("\n")) as { error: { code: string; change: string; call: string | null } };
    assert.equal(error.code, "needs_person");
    assert.match(error.change, /Ask the person first/);
    assert.equal(error.call, "sous serve --no-open --port 0 --by person");
  });

  it("prints the link, opens it, serves until Ctrl-C, then stops", async () => {
    const { paths, projectDir } = testHome();
    const { machine, out, opened, stop } = terminal(true);
    const env = { ...process.env, SOUS_SERVE_TOKEN: "test-token" };
    const running = onHome(paths.home, () => main(["serve", "--port", "0", "--project", projectDir], { machine, env }));
    await waitFor(() => out.some((line) => line.startsWith("sous serve: ")), "the link");
    const url = out.find((line) => line.startsWith("sous serve: "))!.slice("sous serve: ".length);
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/\?t=test-token$/);
    assert.deepEqual(opened, [url]);
    assert.ok(out.includes(`Open the link to see the runs of ${paths.home}. Ctrl-C stops the server.`));
    const link = await get(url);
    assert.equal(link.status, 302);
    assert.match(link.cookie!, /=test-token; HttpOnly; SameSite=Strict/);

    stop();
    assert.equal(await running, 0);
    assert.equal(out.at(-1), "sous serve stopped.");
    await assert.rejects(get(url), "the server is closed");
  });

  it("opens nothing with --no-open", async () => {
    const { paths, projectDir } = testHome();
    const { machine, out, opened, stop } = terminal(true);
    const running = onHome(paths.home, () => main(["serve", "--no-open", "--port", "0", "--project", projectDir], { machine }));
    await waitFor(() => out.some((line) => line.startsWith("sous serve: ")), "the link");
    stop();
    assert.equal(await running, 0);
    assert.deepEqual(opened, []);
  });
});
