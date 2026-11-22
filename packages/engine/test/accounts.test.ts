// The accounts a run records, and the account each of its steps runs as. orc's account tests
// cover the commands; these cover the engine's part on its own.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { accountsForRun, addAccount, runAccounts, stepAccount } from "../src/accounts.js";
import { ensureHome, homePaths } from "../src/runs/home.js";

const home = () => ensureHome(homePaths(join(mkdtempSync(join(tmpdir(), "engine-accounts-")), "home")));

describe("accounts", () => {
  it("records the current account when the parent run is unknown", () => {
    const paths = home();
    assert.deepEqual(accountsForRun(paths, {}, { parentRunId: "nope" }).claude, { name: "default", folder: null });
    assert.deepEqual(accountsForRun(paths, { CLAUDE_CONFIG_DIR: "/somewhere" }).claude, { name: "default", folder: "/somewhere" });
  });

  it("keeps a login token from the environment that is no account of orc's, and names one that is", () => {
    const paths = home();
    addAccount(paths, "work", "sk-ant-oat-work");
    assert.equal(accountsForRun(paths, { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-work" }, { caller: true }).claude.name, "work");
    const kept = accountsForRun(paths, { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-other" }, { caller: true }).claude;
    assert.equal(kept.name, "caller");
    assert.ok(kept.kept);
    assert.deepEqual(stepAccount(paths, "claude", kept), { folder: undefined, token: "sk-ant-oat-other" });
  });

  it("runs a step as a named account, and refuses one orc no longer has", () => {
    const paths = home();
    addAccount(paths, "work", "sk-ant-oat-work");
    assert.deepEqual(stepAccount(paths, "claude", { name: "work", folder: "/claude" }), { folder: "/claude", token: "sk-ant-oat-work", named: true });
    assert.deepEqual(stepAccount(paths, "codex", { name: "default", folder: null }), { folder: undefined });
    assert.throws(() => stepAccount(paths, "claude", { name: "gone", folder: null }), /the run uses Claude Code account gone, which orc no longer has\. orc account add gone adds it again\./);
    assert.deepEqual(runAccounts(paths, undefined), {}, "a run from before accounts keeps the caller's login");
  });
});
