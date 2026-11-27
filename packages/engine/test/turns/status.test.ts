// A turn's status: the schema a turn answers with, and reading its value.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { readStatus, statusSchema } from "../../src/turns/status.js";

type Node = Record<string, unknown>;

const FIELDS = ["status", "result", "message"];

function properties(schema: Node): Record<string, Node> {
  return schema["properties"] as Record<string, Node>;
}

/** The branches of a field other than null, after checking that the field allows null. */
function nonNull(field: Node): Node[] {
  const branches = field["anyOf"];
  assert.ok(Array.isArray(branches), `a nullable field is an anyOf: ${JSON.stringify(field)}`);
  assert.ok(
    branches.some((branch: Node) => branch["type"] === "null"),
    `the field allows null: ${JSON.stringify(field)}`,
  );
  return branches.filter((branch: Node) => branch["type"] !== "null");
}

function statusValues(schema: Node): unknown {
  const [branch] = nonNull(properties(schema)["status"]!);
  return branch!["enum"];
}

/**
 * Keywords that both harness copies keep as written: toAnthropicJsonSchema and toStrictJsonSchema
 * in packages/harnesses/src/schema.ts. Those functions are not exported, so this test checks the
 * shape that makes them leave the schema unchanged.
 */
const KEPT = new Set(["type", "properties", "required", "additionalProperties", "anyOf", "enum", "description"]);

/** Every keyword of the status schema outside the step's own schema, by path. */
function keywords(node: unknown, path: string, skip: unknown, out: string[]): string[] {
  if (node === skip || node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    node.forEach((item, i) => keywords(item, `${path}[${i}]`, skip, out));
    return out;
  }
  for (const [key, value] of Object.entries(node)) {
    if (path.endsWith(".properties")) {
      keywords(value, `${path}.${key}`, skip, out);
      continue;
    }
    out.push(`${path}.${key}`);
    if (key !== "enum" && key !== "required") keywords(value, `${path}.${key}`, skip, out);
  }
  return out;
}

describe("statusSchema", () => {
  it("with no step schema is one flat object of three required, nullable, described fields", () => {
    const schema = statusSchema({});
    assert.equal(schema["type"], "object");
    assert.deepEqual(Object.keys(properties(schema)).sort(), [...FIELDS].sort());
    assert.deepEqual([...(schema["required"] as string[])].sort(), [...FIELDS].sort());
    assert.equal(schema["additionalProperties"], false);
    for (const name of FIELDS) {
      const field = properties(schema)[name]!;
      nonNull(field);
      assert.equal(typeof field["description"], "string", `${name} has a description`);
      assert.ok((field["description"] as string).trim().length > 0, `${name} has a description`);
    }
    assert.deepEqual(nonNull(properties(schema)["result"]!), [{ type: "string" }]);
    assert.deepEqual(statusValues(schema), ["done", "working", "question"]);
  });

  it("with a step schema makes result that schema or null", () => {
    const step = Type.Object({ verdict: Type.String(), notes: Type.Optional(Type.String()) });
    const schema = statusSchema({ schema: step });
    assert.deepEqual(nonNull(properties(schema)["result"]!), [step]);
  });

  it("leaves question out of the status with ask: false", () => {
    assert.deepEqual(statusValues(statusSchema({ ask: false })), ["done", "working"]);
    assert.deepEqual(statusValues(statusSchema({ ask: true })), ["done", "working", "question"]);
    assert.doesNotMatch(String(properties(statusSchema({ ask: false }))["status"]!["description"]), /question/);
  });

  it("says in the status description that asking whether to go on is working", () => {
    const description = String(properties(statusSchema({}))["status"]!["description"]);
    assert.match(description, /asking whether to go on[^.]*is "working"/i);
    assert.match(description, /"question"[^.]*only for what you cannot decide or do without the person/i);
  });

  it("says in the status description that done is the whole task, and a turn that ends with parts left is working", () => {
    const description = String(properties(statusSchema({}))["status"]!["description"]);
    assert.match(description, /"done": every part of the task is finished, parts it leaves for a later turn included/i);
    assert.match(description, /end this turn with any part left[^.]*"working"/i);
  });

  it("uses only what both harness schema copies keep as written", () => {
    const step = Type.Object({ verdict: Type.String() });
    for (const options of [{}, { ask: false }, { schema: step }]) {
      const schema = statusSchema(options);
      const result = properties(schema)["result"]!;
      const stepNode = "schema" in options ? nonNull(result)[0] : undefined;
      const used = keywords(schema, "", stepNode, []);
      const refused = used.filter((path) => !KEPT.has(path.slice(path.lastIndexOf(".") + 1)));
      assert.deepEqual(refused, [], "every keyword is one both copies keep");
      // Codex's copy makes a field that is not required nullable again, so every field is required.
      assert.deepEqual([...(schema["required"] as string[])].sort(), Object.keys(properties(schema)).sort());
      assert.equal(schema["additionalProperties"], false);
      for (const name of FIELDS) assert.ok(String(properties(schema)[name]!["description"]).length > 0);
      // A JSON copy, as each harness makes, keeps every field and description.
      const copy = JSON.parse(JSON.stringify(schema)) as Node;
      for (const name of FIELDS) {
        assert.equal(properties(copy)[name]!["description"], properties(schema)[name]!["description"]);
      }
    }
  });
});

describe("readStatus", () => {
  it("reads each status", () => {
    assert.deepEqual(readStatus({ status: "done", result: "the answer", message: null }), {
      status: "done",
      result: "the answer",
      message: null,
    });
    assert.deepEqual(readStatus({ status: "done", result: { verdict: "pass" }, message: null }), {
      status: "done",
      result: { verdict: "pass" },
      message: null,
    });
    assert.deepEqual(readStatus({ status: "working", result: null, message: "Parts 4 and 5 are left." }), {
      status: "working",
      result: null,
      message: "Parts 4 and 5 are left.",
    });
    assert.deepEqual(readStatus({ status: "question", result: null, message: "Return 404 or an empty list?" }), {
      status: "question",
      result: null,
      message: "Return 404 or an empty list?",
    });
  });

  it("gives undefined for a value that is not a status", () => {
    assert.equal(readStatus({ status: "done", result: "x" }), undefined, "missing message");
    assert.equal(readStatus({ result: "x", message: null }), undefined, "missing status");
    assert.equal(readStatus({ status: "done", message: null }), undefined, "missing result");
    assert.equal(readStatus({ status: "finished", result: "x", message: null }), undefined, "unknown status");
    assert.equal(readStatus({ status: null, result: null, message: null }), undefined, "null status");
    assert.equal(readStatus({ status: "working", result: null, message: 4 }), undefined, "message not a string");
    assert.equal(readStatus(JSON.stringify({ status: "done", result: "x", message: null })), undefined, "a string");
    assert.equal(readStatus("done"), undefined, "a string");
    assert.equal(readStatus(null), undefined);
    assert.equal(readStatus([{ status: "done", result: "x", message: null }]), undefined);
  });
});
