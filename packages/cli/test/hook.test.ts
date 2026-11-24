import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import type { HomePaths } from "@sous/engine";
import { testHome } from "@sous/engine/testing";
import { callProblem } from "./helpers/calls.js";
import { sous } from "./sous.js";

// Piece 15, the hook. `sous hook install` adds one SessionStart command to Claude Code's
// settings.json, keeps a backup of the file next to it, and finds its own entry again by that exact
// command. `sous hook remove` deletes only that entry. Codex has no hook yet, so the reply says so.
// Each test runs on a home of its own under the temporary folder: HOME and CLAUDE_CONFIG_DIR point
// there, in process.env and in the env main reads, so no test touches the real ~/.claude.

delete process.env.SOUS_RUN_ID;
delete process.env.CLAUDECODE;

/** The one command the hook runs. It prints the status line, or nothing, and never fails. */
const COMMAND = "sous status --line 2>/dev/null || true";
const REAL_HOME = userInfo().homedir;

interface Home {
  paths: HomePaths;
  home: string;
  /** Claude Code's settings file, under CLAUDE_CONFIG_DIR. */
  settings: string;
  /** The backup sous keeps next to it. */
  backup: string;
}

function newHome(): Home {
  const home = mkdtempSync(join(tmpdir(), "sous-hook-home-"));
  assert.ok(!home.startsWith(`${REAL_HOME}/.`), "the test home is inside a dot folder of the real home");
  const settings = join(home, "claude-config", "settings.json");
  return { paths: testHome().paths, home, settings, backup: `${settings}.sous-backup` };
}

/** Run sous with HOME and CLAUDE_CONFIG_DIR on the test's home, then put them back. */
async function call(h: Home, argv: string[]): Promise<{ code: number; out: string }> {
  const saved = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  const moved = { HOME: h.home, CLAUDE_CONFIG_DIR: join(h.home, "claude-config") };
  Object.assign(process.env, moved);
  try {
    return await sous(h.paths, argv, { env: { ...process.env, ...moved } });
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** Settings with other keys and other hooks, a SessionStart hook of the person's own among them. */
const PERSONS_SETTINGS = {
  model: "opus",
  permissions: { allow: ["Bash(git status)"] },
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo pre" }] }],
    SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo hello from me" }] }],
  },
};

/** Write the settings file as a person would, and give its bytes. */
function plantSettings(h: Home, value: unknown = PERSONS_SETTINGS): string {
  mkdirSync(dirname(h.settings), { recursive: true });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(h.settings, text);
  return text;
}

const readSettings = (h: Home) => JSON.parse(readFileSync(h.settings, "utf8")) as { hooks?: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>> } & Record<string, unknown>;

/** Every SessionStart command in the settings, in order. */
function sessionStartCommands(h: Home): string[] {
  const groups = readSettings(h).hooks?.SessionStart ?? [];
  assert.ok(Array.isArray(groups), "hooks.SessionStart is not a list");
  return groups.flatMap((group) => {
    assert.ok(Array.isArray(group.hooks), `a SessionStart entry has no hooks list: ${JSON.stringify(group)}`);
    return group.hooks.map((hook) => {
      assert.equal(hook.type, "command", JSON.stringify(hook));
      return hook.command;
    });
  });
}

const ours = (h: Home) => sessionStartCommands(h).filter((command) => command === COMMAND).length;

type Parsed = Record<string, unknown> & { notes: string[]; next: Array<{ call: string; does: string }> };

/** A JSON reply: its data, with notes and next arrays whose calls parse. */
function replyOf(printed: { code: number; out: string }): Parsed {
  let parsed: Parsed | undefined;
  assert.doesNotThrow(() => (parsed = JSON.parse(printed.out) as Parsed), `sous printed no JSON object (exit ${printed.code}):\n${printed.out}`);
  assert.ok(!("error" in parsed!), printed.out);
  assert.ok(Array.isArray(parsed!.notes), `no notes array: ${printed.out}`);
  assert.ok(Array.isArray(parsed!.next), `no next array: ${printed.out}`);
  for (const next of parsed!.next) {
    assert.equal(callProblem(next.call), undefined);
    assert.ok(next.call.split(" ").includes("--json"), `a next call without --json: ${next.call}`);
  }
  return parsed!;
}

describe("sous hook install", () => {
  it("adds one SessionStart entry that runs sous status --line, and keeps a backup of the file as it was", async () => {
    const h = newHome();
    const before = plantSettings(h);
    const printed = await call(h, ["hook", "install", "--json"]);
    assert.equal(printed.code, 0, printed.out);
    const reply = replyOf(printed);
    assert.equal(reply.settings, h.settings, printed.out);
    assert.equal(reply.command, COMMAND, printed.out);
    assert.equal(reply.already, false, printed.out);
    assert.equal(reply.backup, h.backup, printed.out);
    assert.equal(ours(h), 1, readFileSync(h.settings, "utf8"));
    assert.ok(existsSync(h.backup), `no backup at ${h.backup}`);
    assert.equal(readFileSync(h.backup, "utf8"), before, "the backup is not the file as it was before the install");
  });

  it("creates the settings file and its folder when there is none", async () => {
    const h = newHome();
    const printed = await call(h, ["hook", "install", "--json"]);
    assert.equal(printed.code, 0, printed.out);
    assert.deepEqual(sessionStartCommands(h), [COMMAND]);
  });

  it("adds nothing on a second install, says it is already there, and leaves the file and the backup alone", async () => {
    const h = newHome();
    plantSettings(h);
    assert.equal((await call(h, ["hook", "install"])).code, 0);
    const settings = readFileSync(h.settings, "utf8");
    const backup = readFileSync(h.backup, "utf8");
    const printed = await call(h, ["hook", "install", "--json"]);
    assert.equal(printed.code, 0, printed.out);
    assert.equal(replyOf(printed).already, true, printed.out);
    assert.equal(ours(h), 1);
    assert.equal(readFileSync(h.settings, "utf8"), settings, "a second install changed the settings");
    assert.equal(readFileSync(h.backup, "utf8"), backup, "a second install wrote the backup again");
  });

  it("keeps the other keys and hooks of the file, the person's own SessionStart hook included", async () => {
    const h = newHome();
    plantSettings(h);
    assert.equal((await call(h, ["hook", "install"])).code, 0);
    const after = readSettings(h);
    assert.equal(after.model, "opus");
    assert.deepEqual(after.permissions, PERSONS_SETTINGS.permissions);
    assert.deepEqual(after.hooks!.PreToolUse, PERSONS_SETTINGS.hooks.PreToolUse);
    assert.deepEqual(sessionStartCommands(h).sort(), ["echo hello from me", COMMAND].sort());
    assert.ok(after.hooks!.SessionStart!.some((group) => JSON.stringify(group) === JSON.stringify(PERSONS_SETTINGS.hooks.SessionStart[0])), "the person's own SessionStart entry changed");
  });

  it("says in a note that Codex has no hook yet", async () => {
    const h = newHome();
    const reply = replyOf(await call(h, ["hook", "install", "--json"]));
    assert.ok(reply.notes.some((note) => /Codex/.test(note)), JSON.stringify(reply.notes));
  });

  it("names the settings file in text", async () => {
    const h = newHome();
    const printed = await call(h, ["hook", "install"]);
    assert.equal(printed.code, 0, printed.out);
    assert.ok(printed.out.includes(h.settings), printed.out);
  });

  it("refuses a settings file that does not parse with not_ours, and leaves it as it is", async () => {
    const h = newHome();
    mkdirSync(dirname(h.settings), { recursive: true });
    writeFileSync(h.settings, "{ this is not json\n");
    const printed = await call(h, ["hook", "install", "--json"]);
    assert.equal(printed.code, 66, printed.out);
    const { error } = JSON.parse(printed.out) as { error: { code: string; message: string; change: string; call: string | null } };
    assert.equal(error.code, "not_ours");
    assert.ok(error.change.includes(h.settings), `the change does not name ${h.settings}: ${error.change}`);
    assert.equal(typeof error.call, "string", printed.out);
    assert.equal(callProblem(error.call!), undefined);
    assert.equal(readFileSync(h.settings, "utf8"), "{ this is not json\n");
  });
});

describe("sous hook install, the backup and links", () => {
  it("keeps the first backup byte for byte through install, remove, install", async () => {
    const h = newHome();
    const first = plantSettings(h);
    assert.equal((await call(h, ["hook", "install"])).code, 0);
    assert.equal((await call(h, ["hook", "remove"])).code, 0);
    plantSettings(h, { ...PERSONS_SETTINGS, model: "sonnet" });
    const printed = await call(h, ["hook", "install", "--json"]);
    assert.equal(printed.code, 0, printed.out);
    assert.equal(replyOf(printed).backup, h.backup, printed.out);
    assert.equal(readFileSync(h.backup, "utf8"), first, "the second install wrote over the first backup");
    assert.equal(readSettings(h).model, "sonnet");
  });

  it("keeps a linked settings.json a link, and writes the hook into its target", async () => {
    const h = newHome();
    const target = join(h.home, "dotfiles", "claude-settings.json");
    mkdirSync(dirname(target), { recursive: true });
    const text = `${JSON.stringify(PERSONS_SETTINGS, null, 2)}\n`;
    writeFileSync(target, text);
    mkdirSync(dirname(h.settings), { recursive: true });
    symlinkSync(target, h.settings);
    const printed = await call(h, ["hook", "install", "--json"]);
    assert.equal(printed.code, 0, printed.out);
    assert.ok(lstatSync(h.settings).isSymbolicLink(), "the install replaced the link with a file");
    assert.equal(readlinkSync(h.settings), target);
    assert.ok(readFileSync(target, "utf8").includes(COMMAND), "the link's target has no hook");
    assert.equal(readFileSync(h.backup, "utf8"), text);
  });

  it("refuses a settings.json that links into a missing folder with not_ours, naming the link", async () => {
    const h = newHome();
    const gone = join(h.home, "gone", "settings.json");
    mkdirSync(dirname(h.settings), { recursive: true });
    symlinkSync(gone, h.settings);
    const printed = await call(h, ["hook", "install", "--json"]);
    assert.equal(printed.code, 66, printed.out);
    const { error } = JSON.parse(printed.out) as { error: { code: string; message: string; change: string; call: string | null } };
    assert.equal(error.code, "not_ours", printed.out);
    assert.ok(error.change.includes(h.settings), `the change does not name the link ${h.settings}: ${error.change}`);
    assert.ok(error.message.includes(gone), `the message does not name where the link points: ${error.message}`);
    assert.equal(callProblem(error.call!), undefined);
    assert.ok(!existsSync(dirname(gone)), "the install made the missing folder");
    assert.equal(readlinkSync(h.settings), gone);
  });
});

describe("sous hook remove", () => {
  it("leaves the file as it was before the install", async () => {
    const h = newHome();
    const before = plantSettings(h);
    assert.equal((await call(h, ["hook", "install"])).code, 0);
    assert.equal(ours(h), 1);
    const printed = await call(h, ["hook", "remove", "--json"]);
    assert.equal(printed.code, 0, printed.out);
    assert.equal(replyOf(printed).removed, true, printed.out);
    assert.equal(readFileSync(h.settings, "utf8"), before, "remove did not give back the bytes from before the install");
  });

  it("deletes the settings file it created when the remove leaves it empty", async () => {
    const h = newHome();
    assert.equal((await call(h, ["hook", "install"])).code, 0);
    assert.ok(existsSync(h.settings));
    const printed = await call(h, ["hook", "remove", "--json"]);
    assert.equal(printed.code, 0, printed.out);
    assert.equal(replyOf(printed).removed, true, printed.out);
    assert.ok(!existsSync(h.settings), "remove left an empty settings file that sous made");
  });

  it("deletes only sous's entry, and keeps a SessionStart hook the person added after the install", async () => {
    const h = newHome();
    plantSettings(h);
    assert.equal((await call(h, ["hook", "install"])).code, 0);
    // The person adds another SessionStart hook after the install.
    const edited = readSettings(h);
    edited.hooks!.SessionStart!.push({ hooks: [{ type: "command", command: "echo later" }] });
    writeFileSync(h.settings, JSON.stringify(edited, null, 2));
    assert.equal((await call(h, ["hook", "remove"])).code, 0);
    assert.deepEqual(sessionStartCommands(h).sort(), ["echo hello from me", "echo later"]);
    assert.deepEqual(readSettings(h).hooks!.PreToolUse, PERSONS_SETTINGS.hooks.PreToolUse);
  });

  it("changes nothing when no hook of sous's is there, exits 0 and says so", async () => {
    const h = newHome();
    const absent = await call(h, ["hook", "remove", "--json"]);
    assert.equal(absent.code, 0, absent.out);
    const first = replyOf(absent);
    assert.equal(first.removed, false, absent.out);
    assert.ok(first.notes.length > 0, `no note says nothing was there: ${absent.out}`);
    assert.ok(!existsSync(h.settings), "remove created a settings file");

    const before = plantSettings(h);
    const planted = await call(h, ["hook", "remove", "--json"]);
    assert.equal(planted.code, 0, planted.out);
    assert.equal(replyOf(planted).removed, false, planted.out);
    assert.equal(readFileSync(h.settings, "utf8"), before, "remove rewrote a file that had no hook of sous's");
  });
});

describe("sous help", () => {
  it("lists sous hook install|remove", async () => {
    const printed = await call(newHome(), ["help"]);
    assert.match(printed.out, /sous hook install\|remove/);
  });
});
