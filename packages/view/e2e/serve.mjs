#!/usr/bin/env node
// Starts `sous serve` on a throwaway world, for the end-to-end checks and for trying the page.
// It needs the cli built (pnpm --filter @sous-run/cli build) and the page built (pnpm --filter
// @sous-run/view build).
//
//   node packages/view/e2e/serve.mjs [--port 4417] [--token e2e] [--runs] [--root <dir>]
//
// --runs starts a few runs first, so the lists have something in them: one waits on a question,
// one on a breakpoint, one runs a long step, one fails and one ends. Agent runs on the fake
// programs follow: one plans, reviews and tests, then waits on a checkpoint, one keeps an agent
// working until `touch <world>/fake/release-investigate`, and one retries an overloaded step. On
// Ctrl-C or SIGTERM it stops the runs still going, then the server.

import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeWorld, personEnv } from "./world.mjs";

const CLI = fileURLToPath(new URL("../../cli/dist/cli.js", import.meta.url));

function flag(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}

const port = flag("port", "4417");
const token = flag("token", "e2e");
const world = makeWorld(flag("root", undefined));
const env = personEnv(world, { SOUS_SERVE_TOKEN: token });

/** One sous command in the project, as the person, with its JSON reply. */
function sous(args) {
  const done = spawnSync(process.execPath, [CLI, ...args, "--json"], { cwd: world.project, env, encoding: "utf8" });
  try {
    return JSON.parse(done.stdout);
  } catch {
    return { error: { message: (done.stderr || done.stdout).trim() } };
  }
}

if (process.argv.includes("--runs")) {
  for (const [name, ...inputs] of [["greet"], ["review"], ["slow"], ["fails"], ["fanout"], ["dark-mode"], ["investigate"], ["flaky"]]) {
    const started = sous(["run", name, ...inputs]);
    if (started.error) console.error(`could not start ${name}: ${started.error.message}`);
  }
}

const server = spawn(process.execPath, [CLI, "serve", "--no-open", "--port", port], { cwd: world.project, env, stdio: ["ignore", "inherit", "inherit"] });
console.log(`world: ${world.root}`);

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  const runs = sous(["list"]);
  for (const run of runs.runs ?? []) if (!["completed", "done", "failed", "stopped"].includes(run.status)) sous(["stop", run.runId]);
  if (server.pid) process.kill(server.pid, "SIGINT");
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
server.on("exit", (code) => process.exit(code ?? 0));
