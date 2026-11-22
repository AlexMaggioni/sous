import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseArgs, parseSets } from "../src/cli.js";

describe("command line", () => {
  it("keeps orc's flags apart from the workflow's inputs", () => {
    const parsed = parseArgs(["ticket", "--place", "none", "--ticket", "add a flag", "--wait", "--set", "reviewer.model=claude/opus", "--", "--place", "x"]);
    assert.deepEqual(parsed.positionals, ["ticket"]);
    assert.deepEqual(parsed.flags, { place: "none", wait: true });
    assert.deepEqual(parsed.inputs, { ticket: "add a flag", place: "x" });
    assert.deepEqual(parseSets(parsed.sets), { reviewer: { model: "claude/opus" } });
    assert.deepEqual(parseSets(["a.b.retries=2", "x.schema={\"type\":\"object\"}"]), { "a.b": { retries: 2 }, x: { schema: { type: "object" } } });
    assert.throws(() => parseSets(["nokey=1"]), /label\.key=value/);
  });
});
