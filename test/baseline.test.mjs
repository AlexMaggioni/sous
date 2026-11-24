// The baseline: today's sous, driven by the fake claude and codex, must print what
// test/baseline/golden/ holds. No credentials, no network, no real Claude Code or Codex.
//
//   node --test test/baseline.test.mjs                     compare with golden
//   BASELINE_UPDATE=1 node --test test/baseline.test.mjs   rewrite golden from today's sous

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { capture } from "./baseline/capture.mjs";

const golden = join(dirname(fileURLToPath(import.meta.url)), "baseline", "golden");

/** A unified diff of two files, or a short note when the diff tool is missing. */
function diffOf(expected, actual) {
  const result = spawnSync("diff", ["-u", expected, actual], { encoding: "utf8" });
  if (result.error) return `${expected} and ${actual} differ`;
  return result.stdout;
}

test("sous behaves as the golden files say", { timeout: 300_000 }, async () => {
  const out = mkdtempSync(join(tmpdir(), "sous-baseline-out-"));
  try {
    await capture(out);
    if (process.env.BASELINE_UPDATE === "1") {
      rmSync(golden, { recursive: true, force: true });
      mkdirSync(dirname(golden), { recursive: true });
      cpSync(out, golden, { recursive: true });
      return;
    }
    assert.ok(existsSync(golden), `${golden} is missing. BASELINE_UPDATE=1 writes it.`);
    const want = readdirSync(golden).sort();
    const got = readdirSync(out).sort();
    const problems = [];
    for (const file of want.filter((name) => !got.includes(name))) problems.push(`missing: ${file}`);
    for (const file of got.filter((name) => !want.includes(name))) problems.push(`new: ${file}`);
    for (const file of want.filter((name) => got.includes(name))) {
      const expected = join(golden, file);
      const actual = join(out, file);
      if (readFileSync(expected, "utf8") !== readFileSync(actual, "utf8")) problems.push(diffOf(expected, actual));
    }
    assert.equal(problems.length, 0, `sous changed from the baseline:\n\n${problems.join("\n")}`);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
