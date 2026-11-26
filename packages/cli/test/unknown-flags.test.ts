// A command that takes no workflow inputs leaves out a flag it does not take, and says so in a
// note that names the flag. The reply is otherwise the one the command gives without the flag.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { testHome } from "@sous-run/engine/testing";
import { sous } from "./sous.js";

interface Replied {
  notes: string[];
  next: unknown[];
  [key: string]: unknown;
}

const ENV: NodeJS.ProcessEnv = {};

async function json(argv: string[]): Promise<{ code: number; reply: Replied }> {
  const { paths } = testHome({});
  const called = await sous(paths, argv, { env: ENV });
  return { code: called.code, reply: JSON.parse(called.out) as Replied };
}

/** The notes that name this flag. */
const naming = (reply: Replied, flag: string) => reply.notes.filter((note) => note.includes(flag));

describe("a flag a command does not take", () => {
  it("sous list names an unknown flag in a note and lists the runs as without it", async () => {
    const plain = await json(["list", "--json"]);
    const { code, reply } = await json(["list", "--bogus", "--json"]);
    assert.equal(code, 0);
    assert.equal(naming(reply, "--bogus").length, 1, `one note names --bogus: ${JSON.stringify(reply.notes)}`);
    assert.deepEqual(reply.runs, plain.reply.runs);
  });

  it("sous list names a sous flag it does not take, with its value left out too", async () => {
    const { code, reply } = await json(["list", "--since", "3d", "--json"]);
    assert.equal(code, 0);
    assert.equal(naming(reply, "--since").length, 1, JSON.stringify(reply.notes));
  });

  it("sous list names a flag given as --name=value by its name", async () => {
    const { reply } = await json(["list", "--bogus=1", "--json"]);
    assert.equal(naming(reply, "--bogus").length, 1, JSON.stringify(reply.notes));
    assert.equal(naming(reply, "--bogus=1").length, 0, "the note names the flag, not its value");
  });

  it("sous list gives no such note for the flags it takes", async () => {
    const { reply } = await json(["list", "--all", "--json"]);
    assert.deepEqual(reply.notes.filter((note) => /does not take/.test(note)), []);
  });

  it("the other commands that take no inputs say the same", async () => {
    for (const argv of [["status", "--bogus", "--json"], ["inbox", "--bogus", "--json"], ["workflows", "--bogus", "--json"]]) {
      const { code, reply } = await json(argv);
      assert.equal(code, 0, argv.join(" "));
      assert.equal(naming(reply, "--bogus").length, 1, `${argv.join(" ")}: ${JSON.stringify(reply.notes)}`);
    }
  });

  it("the text form prints the note", async () => {
    const { paths } = testHome({});
    const called = await sous(paths, ["list", "--bogus"], { env: ENV });
    assert.equal(called.code, 0);
    assert.match(called.out, /^note: .*--bogus/m);
  });
});
