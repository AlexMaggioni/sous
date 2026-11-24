// The sous that a proof session finds on its PATH. bin/sous runs this file with the build's
// cli.js and the call log, after it sets SOUS_HOME and SOUS_NOTIFY=0.
// It passes stdin, stdout, stderr and the exit code through, and appends two lines per call to
// the log: one when the call starts and one when it ends, with its output.
//
// Usage: node sous-wrapper.mjs <cli.js> <calls.jsonl> [sous args...]

import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const [cli, log, ...args] = process.argv.slice(2);
const id = `${process.pid}-${Date.now()}`;
const KEEP = 20000;

// Names only, never values: which program's shell ran the call.
const markers = Object.keys(process.env)
  .filter((name) => /^(CLAUDECODE|CLAUDE_CODE_SESSION_ID|CODEX_THREAD_ID|CODEX_SESSION_ID|CODEX_SANDBOX|SOUS_RUN_ID)$/.test(name))
  .sort();

function line(entry) {
  try {
    appendFileSync(log, `${JSON.stringify(entry)}\n`);
  } catch {
    // A log we cannot write must not change what the agent sees.
  }
}

line({ id, phase: "start", at: new Date().toISOString(), cwd: process.cwd(), args, markers, tty: Boolean(process.stdout.isTTY) });

const started = Date.now();
const child = spawn(process.execPath, [cli, ...args], { stdio: ["inherit", "pipe", "pipe"], env: process.env });
let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  if (stdout.length < KEEP) stdout += chunk;
});
child.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
  if (stderr.length < KEEP) stderr += chunk;
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("close", (code, signal) => {
  line({ id, phase: "end", at: new Date().toISOString(), ms: Date.now() - started, exit: code, signal, stdout: stdout.slice(0, KEEP), stderr: stderr.slice(0, KEEP) });
  process.exitCode = code ?? 1;
});
