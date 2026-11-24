// The two ways the engine reads a JSON file under the sous home.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
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
