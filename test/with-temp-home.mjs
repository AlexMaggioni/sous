// Runs a command on a temporary home, so no test reads or writes the real one. Each package's
// test script starts through it:
//
//   node ../../test/with-temp-home.mjs tsx --test "test/**/*.test.ts"
//
// HOME, CLAUDE_CONFIG_DIR and CODEX_HOME point into a new folder. The Claude token and ORC_HOME
// are removed. A test then gives the same result on every machine and under every login.

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
const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex") };
delete env.CLAUDE_CODE_OAUTH_TOKEN;
delete env.ORC_HOME;

const child = spawn(command, args, { env, stdio: "inherit" });
child.on("error", (error) => {
  console.error(`with-temp-home: cannot start ${command}: ${error.message}`);
  process.exit(127);
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
