// Runs a command on a temporary home, so no test reads or writes the real one. Each package's
// test script starts through it:
//
//   node ../../test/with-temp-home.mjs tsx --test "test/**/*.test.ts"
//
// HOME, CLAUDE_CONFIG_DIR, CODEX_HOME and XDG_CONFIG_HOME point into a new folder. The Claude
// token, ORC_HOME and AGENTPRISM_DEFAULT_BACKEND are removed. The agent lookup then reads empty
// login folders, and a bare model name routes to Claude. A test gives the same result on every
// machine and under every login.
//
// To run one test file, put the same command in front of it, from the package folder:
//
//   node ../../test/with-temp-home.mjs ../../node_modules/.bin/tsx --test test/some.test.ts

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("usage: with-temp-home.mjs <command> [args...]");
  process.exit(2);
}

const home = mkdtempSync(join(tmpdir(), "orc-test-home-"));
const env = {
  ...process.env,
  HOME: home,
  CLAUDE_CONFIG_DIR: join(home, ".claude"),
  CODEX_HOME: join(home, ".codex"),
  XDG_CONFIG_HOME: join(home, ".config"),
};
delete env.CLAUDE_CODE_OAUTH_TOKEN;
delete env.ORC_HOME;
delete env.AGENTPRISM_DEFAULT_BACKEND;

const child = spawn(command, args, { env, stdio: "inherit" });
child.on("error", (error) => {
  console.error(`with-temp-home: cannot start ${command}: ${error.message}`);
  process.exit(127);
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
