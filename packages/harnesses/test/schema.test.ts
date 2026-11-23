// The two wire copies of a step's schema. The engine hashes the original schema to resume a
// step, so a table of tests below checks that neither helper changes the original.
import test from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { toAnthropicJsonSchema, toStrictJsonSchema } from "../src/schema.js";

/** A structural view of a JSON-Schema node for reading runtime fields off either a plain
 *  output object or a typebox schema (which carries the same fields, just not in its static
 *  type). Going through `unknown` is the type-safe way to view these JSON values. */
interface JsonNode {
  type?: string;
  additionalProperties?: unknown;
  title?: unknown;
  required?: string[];
  properties?: Record<string, JsonNode>;
  items?: unknown;
  minLength?: number;
  format?: string;
  [k: string]: unknown;
}

const view = (value: unknown): JsonNode => value as JsonNode;

/** A schema that deliberately exercises every strict transformation:
 *  - top-level `additionalProperties: true` + `title` (an unsupported keyword)
 *  - a REQUIRED prop carrying unsupported validation keywords (minLength, format)
 *  - an OPTIONAL prop (NOT in typebox `required`) carrying `minimum`
 *  - a NESTED object that must itself get additionalProperties:false + full `required`
 *  - an array carrying `minItems` (unsupported) */
function buildSchema() {
  return Type.Object(
    {
      name: Type.String({ minLength: 1, format: "email", pattern: "^.+@.+$" }),
      age: Type.Optional(Type.Integer({ minimum: 0, maximum: 130 })),
      address: Type.Object({
        city: Type.String(),
        zip: Type.Optional(Type.String({ pattern: "\\d{5}" })),
      }),
      tags: Type.Array(Type.String(), { minItems: 1, uniqueItems: true }),
    },
    { additionalProperties: true, title: "Person", $id: "person.schema" },
  );
}

test("toStrictJsonSchema: every property required + additionalProperties:false (incl. nested)", () => {
  const schema = buildSchema();
  const strict = toStrictJsonSchema(schema);

  assert.equal(strict.additionalProperties, false);
  // Optional `age` is FORCED into required by the strict normalizer.
  assert.deepEqual(strict.required, ["name", "age", "address", "tags"]);

  const props = strict.properties as Record<string, Record<string, unknown>>;
  // Nested object also normalized: additionalProperties:false + all of its props required.
  assert.equal(props.address.additionalProperties, false);
  assert.deepEqual(props.address.required, ["city", "zip"]);
});

test("toStrictJsonSchema: unsupported validation keywords are stripped on the copy", () => {
  const schema = buildSchema();
  const strict = toStrictJsonSchema(schema);
  const props = strict.properties as Record<string, Record<string, unknown>>;
  const address = props.address.properties as Record<string, Record<string, unknown>>;

  // top-level non-structural keywords gone
  assert.equal("title" in strict, false);
  assert.equal("$id" in strict, false);
  // string validators gone, but structural `type` kept
  assert.equal(props.name.type, "string");
  assert.equal("minLength" in props.name, false);
  assert.equal("format" in props.name, false);
  assert.equal("pattern" in props.name, false);
  // numeric validators gone
  assert.equal("minimum" in props.age, false);
  assert.equal("maximum" in props.age, false);
  // array validators gone, items kept
  assert.equal("minItems" in props.tags, false);
  assert.equal("uniqueItems" in props.tags, false);
  assert.deepEqual(props.tags.items, { type: "string" });
  // nested string validator gone
  assert.equal("pattern" in address.zip, false);
});

// ---- (6) originally-OPTIONAL props become NULLABLE under all-required strict mode --------

test("toStrictJsonSchema: optional prop -> required AND nullable (type unioned with null)", () => {
  const schema = buildSchema();
  const strict = toStrictJsonSchema(schema);
  const props = strict.properties as Record<string, JsonNode>;

  // `age` was optional; strict forces it into `required`, so it must also accept null.
  assert.deepEqual(props.age.type, ["integer", "null"]);
  assert.ok((strict.required as string[]).includes("age"));

  // The nested optional `zip` is likewise required + nullable.
  const address = props.address.properties as Record<string, JsonNode>;
  assert.deepEqual(address.zip.type, ["string", "null"]);
  assert.deepEqual(props.address.required, ["city", "zip"]);

  // A REQUIRED prop is NOT made nullable (its type stays a bare string).
  assert.equal(props.name.type, "string");
  // A required array prop also stays non-nullable.
  assert.equal(props.tags.type, "array");
});

test("toStrictJsonSchema: optional nested OBJECT prop becomes nullable via its object type", () => {
  const schema = Type.Object({
    inner: Type.Optional(Type.Object({ c: Type.String() })),
    keep: Type.String(),
  });
  const strict = toStrictJsonSchema(schema);
  const props = strict.properties as Record<string, JsonNode>;
  // optional object -> required + type widened to ["object","null"]
  assert.deepEqual(props.inner.type, ["object", "null"]);
  assert.deepEqual(strict.required, ["inner", "keep"]);
  // the (now-nullable) nested object still got strict treatment internally
  assert.equal(props.inner.additionalProperties, false);
  assert.deepEqual(props.inner.required, ["c"]);
});

test("toStrictJsonSchema: optional $ref prop (no inline type) is wrapped in a nullable anyOf", () => {
  const schema = Type.Object(
    { a: Type.Optional(Type.Ref("Foo")), b: Type.String() },
    { $defs: { Foo: Type.Object({ z: Type.String() }) } },
  );
  const strict = toStrictJsonSchema(schema);
  const props = strict.properties as Record<string, JsonNode>;
  // No inline `type` to widen -> wrap the $ref in anyOf:[ {$ref}, {type:null} ].
  const anyOf = props.a.anyOf as JsonNode[];
  assert.ok(Array.isArray(anyOf));
  assert.equal(anyOf.length, 2);
  assert.equal((anyOf[0] as { $ref?: string }).$ref, "Foo");
  assert.deepEqual(anyOf[1], { type: "null" });
  assert.deepEqual(strict.required, ["a", "b"]);
});

// ---- (6) strict-UNSUPPORTED composition: allOf flattened or rejected; oneOf -> anyOf -----

test("toStrictJsonSchema: trivial allOf (Intersect of objects) is flattened into one object", () => {
  // Type.Intersect renders `{ allOf: [ {obj}, {obj} ] }` with no top-level type.
  const schema = Type.Intersect([
    Type.Object({ a: Type.String() }), // `a` required in its part
    Type.Object({ b: Type.Optional(Type.Number()) }), // `b` optional in its part
  ]);
  const strict = toStrictJsonSchema(schema);

  assert.equal("allOf" in strict, false, "allOf must be gone (OpenAI strict rejects it)");
  assert.equal(strict.type, "object");
  assert.equal(strict.additionalProperties, false);
  const props = strict.properties as Record<string, JsonNode>;
  // merged props; both forced required; the originally-optional `b` becomes nullable.
  assert.deepEqual(Object.keys(props), ["a", "b"]);
  assert.deepEqual(strict.required, ["a", "b"]);
  assert.equal(props.a.type, "string");
  assert.deepEqual(props.b.type, ["number", "null"]);
});

test("toStrictJsonSchema: a NON-object allOf member throws a clear schema error", () => {
  // allOf combining scalar constraints cannot be trivially flattened to one object schema.
  const schema = Type.Object({
    x: Type.Unsafe({ allOf: [{ type: "string" }, { type: "number" }] }),
  });
  assert.throws(() => toStrictJsonSchema(schema), /allOf/i);
});

test("toStrictJsonSchema: oneOf is rewritten to anyOf (OpenAI strict accepts anyOf only)", () => {
  const schema = Type.Object({
    choice: Type.Unsafe({ oneOf: [{ type: "string" }, { type: "number" }] }),
  });
  const strict = toStrictJsonSchema(schema);
  const props = strict.properties as Record<string, JsonNode>;
  assert.equal("oneOf" in props.choice, false);
  assert.deepEqual(props.choice.anyOf, [{ type: "string" }, { type: "number" }]);
});

// ---- toAnthropicJsonSchema (Claude native outputFormat) ----------------------------------

test("toAnthropicJsonSchema: additionalProperties:false forced on EVERY object, required preserved", () => {
  const schema = buildSchema();
  const out = toAnthropicJsonSchema(schema);

  // Anthropic REQUIRES additionalProperties:false (authored `true` is a 400 as-is).
  assert.equal(out.additionalProperties, false);
  const props = out.properties as Record<string, JsonNode>;
  assert.equal(props.address.additionalProperties, false);
  // UNLIKE OpenAI strict: authored required survives — optional `age`/`zip` stay optional...
  assert.deepEqual(out.required, ["name", "address", "tags"]);
  assert.deepEqual(props.address.required, ["city"]);
  // ...and are NOT null-widened.
  assert.equal(props.age.type, "integer");
});

test("toAnthropicJsonSchema: unsupported keywords stripped; supported subset kept", () => {
  const schema = Type.Object({
    name: Type.String({ minLength: 1, format: "email", description: "the name" }),
    age: Type.Integer({ minimum: 0, maximum: 130, default: 30 }),
    tags: Type.Array(Type.String(), { minItems: 1, maxItems: 5, uniqueItems: true }),
    empties: Type.Array(Type.String(), { minItems: 0 }),
    pair: Type.Array(Type.String(), { minItems: 2 }),
    slug: Type.String({ format: "custom-slug" }),
    id: Type.String({ format: "uuid" }),
    status: Type.Unsafe({ type: "string", enum: ["a", "b"] }),
  }, { title: "Person", $id: "person" });
  const out = toAnthropicJsonSchema(schema);
  const props = out.properties as Record<string, JsonNode>;

  assert.equal("title" in out, false);
  assert.equal("$id" in out, false);
  // numeric/string constraints gone; description/default/enum kept
  assert.equal("minLength" in props.name, false);
  assert.equal(props.name.description, "the name");
  assert.equal("minimum" in props.age, false);
  assert.equal("maximum" in props.age, false);
  assert.equal(props.age.default, 30);
  assert.deepEqual(props.status.enum, ["a", "b"]);
  // format: kept when it is in Anthropic's supported set, stripped otherwise
  assert.equal(props.name.format, "email");
  assert.equal(props.id.format, "uuid");
  assert.equal("format" in props.slug, false);
  // array constraints: minItems kept ONLY for 0/1; maxItems/uniqueItems always stripped
  assert.equal(props.tags.minItems, 1);
  assert.equal("maxItems" in props.tags, false);
  assert.equal("uniqueItems" in props.tags, false);
  assert.equal(props.empties.minItems, 0);
  assert.equal("minItems" in props.pair, false);
});

test("toAnthropicJsonSchema: patterns with unsupported regex features stripped, simple kept", () => {
  const schema = Type.Object({
    simple: Type.String({ pattern: "^[a-z0-9-]+$" }),
    lookahead: Type.String({ pattern: "^(?=.*[A-Z]).+$" }),
    backref: Type.String({ pattern: "^(a)\\1$" }),
    boundary: Type.String({ pattern: "\\bword\\b" }),
  });
  const out = toAnthropicJsonSchema(schema);
  const props = out.properties as Record<string, JsonNode>;
  assert.equal(props.simple.pattern, "^[a-z0-9-]+$");
  assert.equal("pattern" in props.lookahead, false);
  assert.equal("pattern" in props.backref, false);
  assert.equal("pattern" in props.boundary, false);
});

test("toAnthropicJsonSchema: oneOf rewritten to anyOf; anyOf preserved", () => {
  const schema = Type.Object({
    choice: Type.Unsafe({ oneOf: [{ type: "string" }, { type: "number" }] }),
    nullable: Type.Unsafe({ anyOf: [{ type: "string" }, { type: "null" }] }),
  });
  const out = toAnthropicJsonSchema(schema);
  const props = out.properties as Record<string, JsonNode>;
  assert.equal("oneOf" in props.choice, false);
  assert.deepEqual(props.choice.anyOf, [{ type: "string" }, { type: "number" }]);
  assert.deepEqual(props.nullable.anyOf, [{ type: "string" }, { type: "null" }]);
});

// ---- the original stays as it was (the engine hashes it to resume a step) ----------------

/** What an in-place normalizer would have clobbered on the person schema. */
function personIntact(original: JsonNode) {
  assert.equal(original.additionalProperties, true);
  assert.equal(original.title, "Person");
  assert.deepEqual(original.required, ["name", "address", "tags"]); // optional `age` still absent
  assert.equal(original.properties?.name?.minLength, 1);
  assert.equal(original.properties?.name?.format, "email");
}

const NO_MUTATION: Array<{ title: string; helper: (schema: object) => unknown; schema: () => object; intact: (original: JsonNode) => void }> = [
  { title: "toStrictJsonSchema: does NOT mutate the original hash-feeding schema", helper: toStrictJsonSchema, schema: buildSchema, intact: personIntact },
  {
    title: "toStrictJsonSchema: allOf/oneOf normalization does NOT mutate the hash-feeding original",
    helper: toStrictJsonSchema,
    schema: () => Type.Intersect([Type.Object({ a: Type.String() }), Type.Object({ b: Type.Optional(Type.Number()) })]),
    intact: (original) => assert.ok(Array.isArray(original.allOf), "original still carries its allOf"),
  },
  { title: "toAnthropicJsonSchema: does NOT mutate the hash-feeding original", helper: toAnthropicJsonSchema, schema: buildSchema, intact: personIntact },
];

for (const { title, helper, schema: build, intact } of NO_MUTATION) {
  test(title, () => {
    const schema = build();
    const before = JSON.stringify(schema);
    helper(schema);
    assert.equal(JSON.stringify(schema), before, "the exact bytes the resume hash consumes are unchanged");
    intact(view(schema));
  });
}

// ---- map keys are data, not keywords (both normalizers) ----------------------------------

test("properties literally named after keywords survive BOTH normalizers", () => {
  // A review schema might genuinely have properties named "format", "title", or "pattern";
  // keyword-stripping must not delete them from the properties map.
  const schema = Type.Object({
    format: Type.String(),
    title: Type.String(),
    pattern: Type.Optional(Type.String()),
  });

  const anthropic = toAnthropicJsonSchema(schema);
  assert.deepEqual(Object.keys(anthropic.properties as object), ["format", "title", "pattern"]);
  assert.deepEqual(anthropic.required, ["format", "title"]);

  const strict = toStrictJsonSchema(schema);
  assert.deepEqual(Object.keys(strict.properties as object), ["format", "title", "pattern"]);
  // strict still applies its all-required + nullable-optional rules to the surviving props
  assert.deepEqual(strict.required, ["format", "title", "pattern"]);
  const strictProps = strict.properties as Record<string, JsonNode>;
  assert.deepEqual(strictProps.pattern.type, ["string", "null"]);
});

test("$defs subschemas are normalized but their NAMES survive keyword filtering", () => {
  const schema = Type.Object(
    { a: Type.Ref("minLength") },
    { $defs: { minLength: Type.Object({ z: Type.String({ minLength: 3 }) }) } },
  );
  const out = toAnthropicJsonSchema(schema);
  const defs = out.$defs as Record<string, JsonNode>;
  assert.ok(defs.minLength, "a $def named after a keyword survives");
  assert.equal(defs.minLength.additionalProperties, false, "…and its subschema IS normalized");
  const z = (defs.minLength.properties as Record<string, JsonNode>).z;
  assert.equal("minLength" in z, false);
});
