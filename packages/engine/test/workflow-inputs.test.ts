import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkInputs, workflowExtras } from "../src/workflows/meta.js";

describe("inputs", () => {
  it("fill defaults, convert types and list every problem at once", () => {
    const extras = workflowExtras({
      description: "d",
      inputs: { ticket: "What to build", tries: { type: "number", default: 3 }, dry: { type: "boolean", required: false } },
      place: "folder",
    });
    assert.equal(extras.place, "folder");
    assert.deepEqual(checkInputs(extras, { ticket: "add --json", tries: "5", dry: "yes" }), {
      args: { ticket: "add --json", tries: 5, dry: true },
      problems: [],
    });
    const bad = checkInputs(extras, { tries: "many", nope: 1 });
    assert.equal(bad.problems.length, 3);
    assert.match(bad.problems.join("\n"), /unknown input --nope/);
    assert.match(bad.problems.join("\n"), /--tries must be a number/);
    assert.match(bad.problems.join("\n"), /missing input --ticket \(What to build\)/);
  });

  it("take anything when the workflow declares none", () => {
    assert.deepEqual(checkInputs(workflowExtras({}), { a: "1" }), { args: { a: "1" }, problems: [] });
  });
});
