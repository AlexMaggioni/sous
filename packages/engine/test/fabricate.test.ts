import test from "node:test";
import assert from "node:assert/strict";

import { fabricateFromSchema } from "../src/fabricate.js";

test("fabricateFromSchema covers the portable-schema subset", () => {
  assert.equal(fabricateFromSchema({ type: "string", enum: ["a", "b"] }), "a");
  assert.equal(fabricateFromSchema({ const: 42 }), 42);
  assert.equal(fabricateFromSchema({ type: "boolean" }), true);
  assert.equal(fabricateFromSchema({ type: "number", minimum: 5 }), 5);
  assert.equal(fabricateFromSchema({ anyOf: [{ type: "integer" }, { type: "string" }] }), 1);
  const obj = fabricateFromSchema({
    type: "object",
    required: ["files", "extra"],
    properties: { files: { type: "array", items: { type: "string" }, minItems: 2 } },
  }) as { files: string[]; extra: string };
  assert.equal(obj.files.length, 2);
  assert.match(obj.files[0], /^mock-/);
  assert.equal(typeof obj.extra, "string"); // required-but-undeclared property still present
  // No infinite recursion on self-referential shapes.
  const cyclic: Record<string, unknown> = { type: "object" };
  cyclic.properties = { self: cyclic };
  assert.ok(fabricateFromSchema(cyclic) !== undefined);
});
