import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { HomePaths } from "@sous-run/engine";
import { testHome } from "@sous-run/engine/testing";
import { callProblem } from "./helpers/calls.js";
import { sous } from "./sous.js";

// Piece 6, the skill. `sous skill install` links <skills>/sous to the skill folder for Claude Code
// and Codex, `sous skill path` prints the folder and `sous skill check` reports each place. Each
// test runs on a home of its own under the temporary folder: HOME and CLAUDE_CONFIG_DIR point
// there, in process.env and in the env main reads, so no test touches the real ~/.claude,
// ~/.codex or ~/.agents.

delete process.env.SOUS_RUN_ID;
delete process.env.CLAUDECODE;

const SKILL = resolve(dirname(fileURLToPath(import.meta.url)), "../skill/sous");
const REAL_HOME = userInfo().homedir;

interface Home {
  paths: HomePaths;
  home: string;
  /** Where each program's link goes. */
  claude: string;
  codex: string;
}

/** A new home. Claude Code's folder is moved by CLAUDE_CONFIG_DIR, so the test also shows that
 *  sous honors it. */
function newHome(): Home {
  const home = mkdtempSync(join(tmpdir(), "sous-skill-home-"));
  assert.ok(!home.startsWith(`${REAL_HOME}/.`), "the test home is inside a dot folder of the real home");
  return { paths: testHome().paths, home, claude: join(home, "claude-config", "skills", "sous"), codex: join(home, ".agents", "skills", "sous") };
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

/** Something is at the place, a link even when it is broken. */
const there = (place: string) => {
  try {
    lstatSync(place);
    return true;
  } catch {
    return false;
  }
};

/** The place is a link to sous's skill folder. */
function assertOurs(place: string): void {
  assert.ok(lstatSync(place).isSymbolicLink(), `${place} is not a link`);
  assert.equal(realpathSync(place), realpathSync(SKILL), `${place} does not lead to the skill folder`);
}

interface ProgramRow {
  program: string;
  place: string;
  [key: string]: unknown;
}

/** A JSON reply: its data, with notes and next arrays. */
function replyOf(out: string): Record<string, unknown> & { notes: string[]; next: Array<{ call: string; does: string }> } {
  const parsed = JSON.parse(out) as Record<string, unknown> & { notes: string[]; next: Array<{ call: string; does: string }> };
  assert.ok(Array.isArray(parsed.notes), `no notes array: ${out}`);
  assert.ok(Array.isArray(parsed.next), `no next array: ${out}`);
  assert.ok(!("error" in parsed), out);
  for (const next of parsed.next) {
    assert.equal(typeof next.does, "string", JSON.stringify(next));
    assert.equal(callProblem(next.call), undefined);
  }
  return parsed;
}

const rowOf = (rows: ProgramRow[], program: string): ProgramRow => {
  const row = rows.find((r) => r.program === program);
  assert.ok(row, `no row for ${program}: ${JSON.stringify(rows)}`);
  return row;
};

/** The not_ours refusal, with its change naming the place and a call that parses. */
function assertNotOurs(code: number, out: string, place: string): void {
  assert.equal(code, 66, out);
  const { error } = JSON.parse(out) as { error: { code: string; message: string; change: string; call: string | null } };
  assert.equal(error.code, "not_ours");
  assert.ok(error.message.length > 0, out);
  assert.ok(error.change.includes(place), `the change does not name ${place}: ${error.change}`);
  assert.equal(typeof error.call, "string", `the refusal gives no call: ${out}`);
  assert.equal(callProblem(error.call!), undefined);
}

describe("the skill folder", () => {
  it("holds SKILL.md, named sous, with a short description", () => {
    const file = join(SKILL, "SKILL.md");
    assert.ok(existsSync(file), "packages/cli/skill/sous/SKILL.md is missing");
    const text = readFileSync(file, "utf8");
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
    assert.ok(front, "SKILL.md has no front matter");
    assert.match(front[1]!, /^name: sous$/m);
    const description = /^description: (.+)$/m.exec(front[1]!)?.[1];
    assert.ok(description, "SKILL.md has no description");
    // The Agent Skills format caps a description at 1,024 characters.
    assert.ok(description.length <= 1024, `the description has ${description.length} characters`);
    assert.ok(text.includes("sous guide"), "SKILL.md does not send the agent to sous guide");
    assert.ok(!text.includes("—"), "SKILL.md has an em dash");
    assert.ok(!/\p{Extended_Pictographic}/u.test(text), "SKILL.md has an emoji");
  });

  it("keeps SKILL.md under 4,000 characters", () => {
    const text = readFileSync(join(SKILL, "SKILL.md"), "utf8");
    assert.ok(text.length < 4000, `SKILL.md has ${text.length} characters, over 4,000`);
  });
});

describe("sous skill path", () => {
  it("prints the skill folder, which holds SKILL.md", async () => {
    const h = newHome();
    const { code, out } = await call(h, ["skill", "path"]);
    assert.equal(code, 0, out);
    const folder = out.trim();
    assert.ok(isAbsolute(folder), `not an absolute path: ${out}`);
    assert.ok(existsSync(join(folder, "SKILL.md")), `${folder} holds no SKILL.md`);
    assert.equal(realpathSync(folder), realpathSync(SKILL));
  });

  it("gives the folder as path with --json", async () => {
    const h = newHome();
    const { code, out } = await call(h, ["skill", "path", "--json"]);
    assert.equal(code, 0, out);
    const { path } = replyOf(out) as unknown as { path: string };
    assert.equal(realpathSync(path), realpathSync(SKILL));
  });
});

describe("sous skill install", () => {
  it("creates both links, the parent folders with them", async () => {
    const h = newHome();
    const { code, out } = await call(h, ["skill", "install"]);
    assert.equal(code, 0, out);
    assertOurs(h.claude);
    assertOurs(h.codex);
    // The default Claude folder stays untouched, since CLAUDE_CONFIG_DIR moves it.
    assert.ok(!there(join(h.home, ".claude")), "sous wrote into ~/.claude although CLAUDE_CONFIG_DIR moves it");
    assert.ok(out.includes(h.claude) && out.includes(h.codex), `the text does not name both places:\n${out}`);
  });

  it("reports each program with --json, in the reply shape", async () => {
    const h = newHome();
    const { code, out } = await call(h, ["skill", "install", "--json"]);
    assert.equal(code, 0, out);
    const { programs } = replyOf(out) as unknown as { programs: ProgramRow[] };
    assert.equal(programs.length, 2, out);
    assert.deepEqual(rowOf(programs, "claude"), { program: "claude", place: h.claude, already: false });
    assert.deepEqual(rowOf(programs, "codex"), { program: "codex", place: h.codex, already: false });
  });

  it("reports both as already there on a second install", async () => {
    const h = newHome();
    assert.equal((await call(h, ["skill", "install"])).code, 0);
    const { code, out } = await call(h, ["skill", "install", "--json"]);
    assert.equal(code, 0, out);
    const { programs } = replyOf(out) as unknown as { programs: ProgramRow[] };
    assert.equal(rowOf(programs, "claude").already, true, out);
    assert.equal(rowOf(programs, "codex").already, true, out);
    assertOurs(h.claude);
    assertOurs(h.codex);
  });

  it("refuses a plain folder at the Claude place with not_ours, and writes nothing", async () => {
    const h = newHome();
    mkdirSync(h.claude, { recursive: true });
    writeFileSync(join(h.claude, "SKILL.md"), "the person's own skill\n");
    const { code, out } = await call(h, ["skill", "install", "--json"]);
    assertNotOurs(code, out, h.claude);
    assert.ok(lstatSync(h.claude).isDirectory() && !lstatSync(h.claude).isSymbolicLink(), "the folder was replaced");
    assert.deepEqual(readdirSync(h.claude), ["SKILL.md"]);
    assert.equal(readFileSync(join(h.claude, "SKILL.md"), "utf8"), "the person's own skill\n");
    assert.ok(!there(h.codex), "sous linked the Codex place although it refused");
  });

  it("prints the not_ours change and call on stderr without --json", async () => {
    const h = newHome();
    mkdirSync(h.claude, { recursive: true });
    const { code, out } = await call(h, ["skill", "install"]);
    assert.equal(code, 66, out);
    assert.match(out, /^ {2}change: /m);
    assert.match(out, /^ {2}try: sous /m);
  });

  // A link sous did not make is not ours, wherever it leads. A link to another folder may be the
  // person's own copy of the skill, so it is refused, and the change tells the person to move it.
  it("refuses a link to some other folder as not ours, and leaves it", async () => {
    const h = newHome();
    const other = join(h.home, "other-skill");
    mkdirSync(other);
    writeFileSync(join(other, "SKILL.md"), "---\nname: sous\ndescription: someone else's\n---\n");
    mkdirSync(dirname(h.claude), { recursive: true });
    symlinkSync(other, h.claude);
    const { code, out } = await call(h, ["skill", "install", "--json"]);
    assertNotOurs(code, out, h.claude);
    assert.equal(readlinkSync(h.claude), other);
    assert.ok(!there(h.codex), "sous linked the Codex place although it refused");
  });

  // The overseer's rule, after review: a broken link whose target ends in the skill folder's own
  // tail, cli/skill/sous, is one sous made from a checkout or worktree that is gone. The install
  // replaces it and names the old target in a note. A broken link to anything else is refused.
  it("replaces a broken link to a removed checkout's skill folder, and names the old target", async () => {
    const h = newHome();
    const gone = join(h.home, "removed-worktree", "packages", "cli", "skill", "sous");
    mkdirSync(dirname(h.codex), { recursive: true });
    symlinkSync(gone, h.codex);
    const { code, out } = await call(h, ["skill", "install", "--json"]);
    assert.equal(code, 0, out);
    const parsed = replyOf(out);
    const { programs } = parsed as unknown as { programs: ProgramRow[] };
    assert.deepEqual(rowOf(programs, "codex"), { program: "codex", place: h.codex, already: false });
    assertOurs(h.codex);
    assertOurs(h.claude);
    assert.ok(parsed.notes.some((note) => note.includes(h.codex) && note.includes(gone)), `no note names ${gone}: ${out}`);
  });

  it("refuses a broken link to some other folder as not ours, and leaves it", async () => {
    const h = newHome();
    const gone = join(h.home, "moved-away", "my-skill");
    mkdirSync(dirname(h.codex), { recursive: true });
    symlinkSync(gone, h.codex);
    const { code, out } = await call(h, ["skill", "install", "--json"]);
    assertNotOurs(code, out, h.codex);
    assert.ok(lstatSync(h.codex).isSymbolicLink());
    assert.equal(readlinkSync(h.codex), gone);
    assert.ok(!there(h.claude), "sous linked the Claude place although it refused");
  });
});

describe("sous skill check", () => {
  it("lists both programs as not installed in a new home", async () => {
    const h = newHome();
    const { code, out } = await call(h, ["skill", "check", "--json"]);
    assert.equal(code, 0, out);
    const { programs } = replyOf(out) as unknown as { programs: ProgramRow[] };
    assert.deepEqual(rowOf(programs, "claude"), { program: "claude", place: h.claude, installed: false, ours: false });
    assert.deepEqual(rowOf(programs, "codex"), { program: "codex", place: h.codex, installed: false, ours: false });
  });

  it("lists both programs as installed after an install", async () => {
    const h = newHome();
    assert.equal((await call(h, ["skill", "install"])).code, 0);
    const { code, out } = await call(h, ["skill", "check", "--json"]);
    assert.equal(code, 0, out);
    const { programs } = replyOf(out) as unknown as { programs: ProgramRow[] };
    assert.equal(programs.length, 2, out);
    assert.deepEqual(rowOf(programs, "claude"), { program: "claude", place: h.claude, installed: true, ours: true });
    assert.deepEqual(rowOf(programs, "codex"), { program: "codex", place: h.codex, installed: true, ours: true });
  });

  it("gives the install call as next only when an install can work", async () => {
    const h = newHome();
    const calls = async () => replyOf((await call(h, ["skill", "check", "--json"])).out);
    const install = "sous skill install --json";
    assert.deepEqual((await calls()).next.map((next) => next.call), [install], "a new home can install");
    assert.equal((await call(h, ["skill", "install"])).code, 0);
    assert.deepEqual((await calls()).next, [], "nothing to do once installed");
  });

  it("gives no install call while a place holds something else, and says to move it", async () => {
    const h = newHome();
    mkdirSync(h.claude, { recursive: true });
    const checked = replyOf((await call(h, ["skill", "check", "--json"])).out);
    assert.deepEqual(checked.next, [], JSON.stringify(checked));
    assert.ok(checked.notes.some((note) => note.includes(h.claude) && /did not put there/.test(note)), JSON.stringify(checked.notes));
    assert.ok(checked.notes.some((note) => note.includes(h.claude) && /Move/.test(note)), JSON.stringify(checked.notes));
    const { programs } = checked as unknown as { programs: ProgramRow[] };
    assert.deepEqual(rowOf(programs, "claude"), { program: "claude", place: h.claude, installed: true, ours: false });
  });

  it("gives the install call for a broken link to a removed checkout's skill folder", async () => {
    const h = newHome();
    const gone = join(h.home, "removed-worktree", "packages", "cli", "skill", "sous");
    mkdirSync(dirname(h.codex), { recursive: true });
    symlinkSync(gone, h.codex);
    const checked = replyOf((await call(h, ["skill", "check", "--json"])).out);
    assert.deepEqual(checked.next.map((next) => next.call), ["sous skill install --json"]);
    assert.ok(checked.notes.some((note) => note.includes(gone)), JSON.stringify(checked.notes));
  });

  it("says a link to another folder is not ours", async () => {
    const h = newHome();
    const other = join(h.home, "other-skill");
    mkdirSync(other);
    mkdirSync(dirname(h.claude), { recursive: true });
    symlinkSync(other, h.claude);
    const { code, out } = await call(h, ["skill", "check", "--json"]);
    assert.equal(code, 0, out);
    const { programs } = replyOf(out) as unknown as { programs: ProgramRow[] };
    assert.equal(rowOf(programs, "claude").ours, false, out);
  });
});
