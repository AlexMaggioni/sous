// The two ways the engine reads a JSON file under the sous home.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readJsonFile, readStrictJsonFile, writeJsonFile } from "../src/json-file.js";
import { ensureHome, homePaths, loadConfig } from "../src/runs/home.js";

const folder = () => mkdtempSync(join(tmpdir(), "engine-json-file-"));

describe("JSON files", () => {
  it("read back what was written", () => {
    const file = join(folder(), "value.json");
    writeJsonFile(file, { a: 1 });
    assert.deepEqual(readJsonFile(file), { a: 1 });
    assert.deepEqual(readStrictJsonFile(file, {}), { a: 1 });
  });

  it("count a missing file as missing in both readers", () => {
    const file = join(folder(), "missing.json");
    assert.equal(readJsonFile(file), undefined);
    assert.deepEqual(readStrictJsonFile(file, { none: true }), { none: true });
  });

  it("count a file that does not parse as missing, unless a person may have edited it", () => {
    const file = join(folder(), "broken.json");
    writeFileSync(file, "{ not json");
    assert.equal(readJsonFile(file), undefined);
    assert.throws(() => readStrictJsonFile(file, {}), new RegExp(`^Error: ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is not valid JSON: `));
  });

  it("stop sous on a config with a mistake in it", () => {
    const paths = ensureHome(homePaths(join(folder(), "home")));
    writeFileSync(paths.config, '{ "notify": false, }');
    assert.throws(() => loadConfig(paths), /config\.json is not valid JSON/);
  });
});

// Piece 5. The activity file is JSON lines. A dynamic import keeps the tests above running
// while appendJsonLine and readJsonLines do not exist yet.
interface JsonLines {
  appendJsonLine(file: string, value: unknown): void;
  readJsonLines<T>(file: string): T[];
}
const jsonLines = async () => (await import("../src/json-file.js")) as unknown as JsonLines;

describe("JSON lines", () => {
  it("read back two appends as two lines, in order", async () => {
    const { appendJsonLine, readJsonLines } = await jsonLines();
    const file = join(folder(), "two.jsonl");
    appendJsonLine(file, { seq: 1, text: "first" });
    appendJsonLine(file, { seq: 2, text: "second" });
    assert.deepEqual(readJsonLines(file), [
      { seq: 1, text: "first" },
      { seq: 2, text: "second" },
    ]);
    assert.equal(readFileSync(file, "utf8"), '{"seq":1,"text":"first"}\n{"seq":2,"text":"second"}\n');
  });

  it("skip a torn last line, as a crash in the middle of a write leaves it", async () => {
    const { readJsonLines } = await jsonLines();
    const file = join(folder(), "torn.jsonl");
    writeFileSync(file, '{"seq":1}\n{"seq":2}\n{"seq":3,"te');
    assert.deepEqual(readJsonLines(file), [{ seq: 1 }, { seq: 2 }]);
  });

  it("read a missing file as no lines", async () => {
    const { readJsonLines } = await jsonLines();
    assert.deepEqual(readJsonLines(join(folder(), "missing.jsonl")), []);
  });
});
