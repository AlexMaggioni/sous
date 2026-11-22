// A step's JSON Schema, cut down to what each program accepts on the wire.
// Both helpers work on a JSON copy, so the caller's schema never changes.

// Keywords Anthropic structured outputs refuses with a 400. The engine still checks the
// answer against the full schema, so a dropped keyword is checked there.
const ANTHROPIC_UNSUPPORTED_KEYWORDS = new Set<string>([
  "$schema",
  "$id",
  "title",
  "examples",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "maxItems",
  "uniqueItems",
  "contains",
  "minContains",
  "maxContains",
  "minProperties",
  "maxProperties",
  "contentEncoding",
  "contentMediaType",
  "patternProperties",
  "additionalItems",
  "unevaluatedProperties",
  "unevaluatedItems",
  "dependencies",
  "dependentRequired",
  "dependentSchemas",
  "propertyNames",
  "if",
  "then",
  "else",
  "not",
  "readOnly",
  "writeOnly",
  "deprecated",
]);

// The only `format` values Anthropic structured outputs accepts. Any other is a 400.
const ANTHROPIC_SUPPORTED_FORMATS = new Set<string>([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);

// Regex features Anthropic's `pattern` leaves out: backreferences, lookaround and word
// boundaries. A pattern with one is dropped from the copy.
const ANTHROPIC_UNSUPPORTED_REGEX = /\\[1-9]|\(\?<?[=!]|\\[bB]/;

/** Keys whose value maps names to subschemas. The names are data, so a property named "format" stays. */
const SCHEMA_MAP_KEYS = new Set<string>(["properties", "$defs", "definitions"]);

function normalizeSchemaMap(value: unknown, normalize: (node: unknown) => unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [name, sub] of Object.entries(value as Record<string, unknown>)) {
    out[name] = normalize(sub);
  }
  return out;
}

function normalizeAnthropicNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalizeAnthropicNode);
  if (node === null || typeof node !== "object") return node;

  const input = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (SCHEMA_MAP_KEYS.has(key)) {
      out[key] = normalizeSchemaMap(value, normalizeAnthropicNode);
      continue;
    }
    if (ANTHROPIC_UNSUPPORTED_KEYWORDS.has(key)) continue;
    if (key === "minItems") {
      // Only 0 and 1 are accepted.
      if (value === 0 || value === 1) out[key] = value;
      continue;
    }
    if (key === "format") {
      if (typeof value === "string" && ANTHROPIC_SUPPORTED_FORMATS.has(value)) out[key] = value;
      continue;
    }
    if (key === "pattern") {
      if (typeof value === "string" && !ANTHROPIC_UNSUPPORTED_REGEX.test(value)) out[key] = value;
      continue;
    }
    // Anthropic has no oneOf. anyOf accepts more, and the engine's check narrows it again.
    const targetKey = key === "oneOf" ? "anyOf" : key;
    out[targetKey] = normalizeAnthropicNode(value);
  }

  // Anthropic needs additionalProperties:false on every object.
  // It allows optional properties, so `required` stays as written.
  const properties = out["properties"];
  const isObjectSchema =
    out["type"] === "object" || (out["type"] === undefined && properties !== undefined);
  if (isObjectSchema) out["additionalProperties"] = false;
  return out;
}

/**
 * A copy of the schema that Claude Code's outputFormat accepts. Every object gets
 * additionalProperties:false, refused keywords go, and oneOf becomes anyOf.
 */
export function toAnthropicJsonSchema(schema: object): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(schema)) as unknown;
  return normalizeAnthropicNode(clone) as Record<string, unknown>;
}

// Keywords OpenAI strict structured output refuses. Codex sends the output schema in strict mode.
const STRICT_UNSUPPORTED_KEYWORDS = new Set<string>([
  "$schema",
  "$id",
  "title",
  "default",
  "examples",
  "format",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minContains",
  "maxContains",
  "minProperties",
  "maxProperties",
  "contentEncoding",
  "contentMediaType",
  "patternProperties",
  "additionalItems",
  "unevaluatedProperties",
  "unevaluatedItems",
  "dependencies",
  "dependentRequired",
  "dependentSchemas",
  "propertyNames",
  "readOnly",
  "writeOnly",
  "deprecated",
]);

function normalizeStrictNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalizeStrictNode);
  if (node === null || typeof node !== "object") return node;

  // OpenAI strict refuses allOf. Merge the plain object case first, and throw on any other.
  let input = node as Record<string, unknown>;
  if (input["allOf"] !== undefined) {
    input = flattenAllOf(input);
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (SCHEMA_MAP_KEYS.has(key)) {
      out[key] = normalizeSchemaMap(value, normalizeStrictNode);
      continue;
    }
    if (STRICT_UNSUPPORTED_KEYWORDS.has(key)) continue;
    // OpenAI strict has no oneOf. anyOf accepts more, and the engine's check narrows it again.
    const targetKey = key === "oneOf" ? "anyOf" : key;
    out[targetKey] = normalizeStrictNode(value);
  }

  // OpenAI strict needs additionalProperties:false and every property in `required`.
  // A node with properties and no type counts as an object.
  const properties = out["properties"];
  const isObjectSchema =
    out["type"] === "object" || (out["type"] === undefined && properties !== undefined);
  if (isObjectSchema && properties !== null && typeof properties === "object") {
    const propObj = properties as Record<string, unknown>;
    const keys = Object.keys(propObj);
    // An optional property may be null instead, since strict makes it required.
    const originallyRequired = new Set(toStringArray(input["required"]));
    for (const key of keys) {
      if (!originallyRequired.has(key)) propObj[key] = makeNullable(propObj[key]);
    }
    out["additionalProperties"] = false;
    out["required"] = keys;
  }
  return out;
}

/** The strings in a `required` array. */
function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** The property schema, also accepting null. */
function makeNullable(schema: unknown): unknown {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const node = schema as Record<string, unknown>;

  if (Array.isArray(node["anyOf"])) {
    const branches = node["anyOf"] as unknown[];
    if (!branches.some(isNullTypeSchema)) branches.push({ type: "null" });
    return node;
  }

  const type = node["type"];
  if (typeof type === "string") {
    if (type !== "null") node["type"] = [type, "null"];
    return node;
  }
  if (Array.isArray(type)) {
    if (!type.includes("null")) (type as unknown[]).push("null");
    return node;
  }

  // No type and no anyOf, such as a bare $ref.
  return { anyOf: [node, { type: "null" }] };
}

function isNullTypeSchema(node: unknown): boolean {
  return (
    node !== null && typeof node === "object" && (node as Record<string, unknown>)["type"] === "null"
  );
}

/** One object schema from an allOf of object schemas. Any other member throws. */
function flattenAllOf(node: Record<string, unknown>): Record<string, unknown> {
  const allOf = node["allOf"];
  if (!Array.isArray(allOf)) {
    throw new Error('OpenAI strict schema: "allOf" must be an array to be flattened.');
  }
  const { allOf: _drop, ...siblings } = node;
  const parts: unknown[] = [siblings, ...allOf];

  const mergedProps: Record<string, unknown> = {};
  const mergedRequired: string[] = [];
  const merged: Record<string, unknown> = {};
  let sawProperties = false;

  for (const part of parts) {
    if (part === null || typeof part !== "object" || Array.isArray(part)) {
      throw new Error('OpenAI strict schema: cannot flatten an "allOf" whose member is not an object schema.');
    }
    let p = part as Record<string, unknown>;
    if (p["allOf"] !== undefined) p = flattenAllOf(p);

    const props = p["properties"];
    const hasProps = props !== null && typeof props === "object" && !Array.isArray(props);
    const type = p["type"];
    const objectLike = hasProps || type === "object" || type === undefined;
    if (!objectLike) {
      throw new Error(
        `OpenAI strict schema: cannot flatten "allOf" containing a non-object subschema (type: ${JSON.stringify(
          type,
        )}); rewrite the schema without allOf for strict structured output.`,
      );
    }
    if (hasProps) {
      sawProperties = true;
      Object.assign(mergedProps, props as Record<string, unknown>);
    }
    mergedRequired.push(...toStringArray(p["required"]));
    for (const [key, value] of Object.entries(p)) {
      if (key === "properties" || key === "required" || key === "type") continue;
      merged[key] = value;
    }
  }
  if (!sawProperties) {
    throw new Error('OpenAI strict schema: "allOf" had no object subschemas to flatten.');
  }
  merged["type"] = "object";
  merged["properties"] = mergedProps;
  merged["required"] = [...new Set(mergedRequired)];
  return merged;
}

/**
 * A copy of the schema that Codex's strict output schema accepts. Every property is required,
 * every object gets additionalProperties:false, and refused keywords go.
 */
export function toStrictJsonSchema(schema: object): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(schema)) as unknown;
  return normalizeStrictNode(clone) as Record<string, unknown>;
}
