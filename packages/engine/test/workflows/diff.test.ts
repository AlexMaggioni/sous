// Piece 10, lineDiff. `sous workflows show <name> --diff` compares the text the person last
// approved with the file, line by line, so the person sees what changed before saying yes.
//
// Decisions taken here, where the design leaves a choice:
// - Each line starts with two characters: "- " for a line only before, "+ " for a line only after,
//   and two spaces for a line both keep. A changed line gives its "- " line, then its "+ " line.
// - lineDiff keeps every matching line. Cutting the context around a change is the cli's job.
// - A final newline makes no line of its own, so a file that ends with one diffs as its lines.
// - An empty `before` is a new file: every line is "+ ". An identical text gives no "- " and no
//   "+ " line.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { lineDiff } from "../../src/workflows/diff.js";

describe("piece 10: lineDiff", () => {
  it("one changed line gives one - and one +, and keeps the matching lines with two spaces", () => {
    assert.deepEqual(lineDiff("one\ntwo\nthree\n", "one\nTWO\nthree\n"), ["  one", "- two", "+ TWO", "  three"]);
  });

  it("a new file, with nothing before, gives each line with +", () => {
    assert.deepEqual(lineDiff("", "export const meta = {}\n\nreturn 1\n"), ["+ export const meta = {}", "+ ", "+ return 1"]);
  });

  it("an identical text gives no - and no + line", () => {
    const text = "a\nb\nc\n";
    const diff = lineDiff(text, text);
    assert.deepEqual(diff, ["  a", "  b", "  c"]);
  });

  it("an added line and a removed line, apart, each give one line and leave the rest matched", () => {
    assert.deepEqual(lineDiff("a\nb\nc\nd\n", "a\nc\nd\ne\n"), ["  a", "- b", "  c", "  d", "+ e"]);
  });
});
