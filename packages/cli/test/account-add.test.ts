import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { listAccounts } from "@sous/engine";
import { testHome } from "@sous/engine/testing";
import { cmdAccount } from "../src/account-cli.js";
import { capture } from "./sous.js";

// sous account add in a terminal reads the token as the person types or pastes it, and shows
// nothing of it. The terminal here is a stream that says it is one and records how sous sets it.

const WORK = "sk-ant-oat01-made-up-work-token";

/**
 * Run `sous account add work` in a terminal where the person types `keys`. Returns what the command
 * did, what it printed, how it set the terminal, and the stream, to see what it left on it.
 */
async function addInTerminal(keys: string) {
  const { paths } = testHome();
  const rawModes: boolean[] = [];
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: (on: boolean) => rawModes.push(on) });
  const stdin = Object.getOwnPropertyDescriptor(process, "stdin")!;
  Object.defineProperty(process, "stdin", { configurable: true, get: () => input });
  const before = process.env.SOUS_HOME;
  process.env.SOUS_HOME = paths.home;
  const printed: string[] = [];
  const restore = capture(printed);
  const lines: string[] = [];
  let setups = 0;
  try {
    const adding = cmdAccount(["add", "work"], { out: (line) => lines.push(line), setupToken: () => setups++ });
    // The command has set the terminal and listens by now, since it does that before it first waits.
    input.write(keys);
    const outcome = await adding.then(
      (code) => ({ code }),
      (error: Error) => ({ error: error.message }),
    );
    return { outcome, printed: printed.join(""), lines, rawModes, input, setups, paths };
  } finally {
    restore();
    if (before === undefined) delete process.env.SOUS_HOME;
    else process.env.SOUS_HOME = before;
    Object.defineProperty(process, "stdin", stdin);
  }
}

describe("sous account add in a terminal", () => {
  it("adds the token the person types, and shows none of it", async () => {
    // A paste arrives wrapped in marks, and a typo is deleted with backspace.
    const run = await addInTerminal(`\u001b[200~${WORK}x\u007f\u001b[201~\r`);
    assert.deepEqual(run.outcome, { code: 0 });
    assert.equal(run.setups, 1, "claude setup-token runs first, in the terminal");
    assert.deepEqual(run.lines, [
      "Claude Code opens a login in the browser. Log in with the account to add.",
      "added Claude Code account work. sous account use work makes sous use it.",
    ]);
    assert.equal(run.printed, "Paste the token it printed (it stays hidden): \n", "it prompts, and echoes nothing but the line break");
    assert.deepEqual(listAccounts(run.paths).map((row) => `${row.program}/${row.name}`), ["claude/default", "claude/work", "codex/default"]);
    assert.match(readFileSync(run.paths.accounts, "utf8"), new RegExp(`${WORK}"`));
  });

  it("puts the terminal back as it found it", async () => {
    const run = await addInTerminal(`${WORK}\n`);
    assert.deepEqual(run.rawModes, [true, false], "raw while it reads, normal after");
    assert.equal(run.input.listenerCount("data"), 0, "it stops listening");
    assert.equal(run.input.isPaused(), true, "it stops reading");
  });

  for (const [key, name] of [
    ["\u0003", "Ctrl-C"],
    ["\u0004", "Ctrl-D"],
  ] as const) {
    it(`${name} cancels, adds nothing, and puts the terminal back`, async () => {
      const run = await addInTerminal(`sk-ant-oat01-half${key}`);
      assert.deepEqual(run.outcome, { error: "cancelled, nothing added" });
      assert.deepEqual(listAccounts(run.paths).map((row) => row.name), ["default", "default"]);
      assert.deepEqual(run.rawModes, [true, false]);
      assert.equal(run.input.listenerCount("data"), 0);
      assert.equal(run.input.isPaused(), true);
    });
  }
});
