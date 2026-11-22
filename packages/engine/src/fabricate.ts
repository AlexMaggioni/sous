// A made-up value that fits a JSON Schema, for a dry run's stand-in agents. Moved here from the
// workflows package, which orc no longer uses.

function defineDataProperty(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

/**
 * Make a value that fits a JSON Schema, in place of a real agent's structured output. The same
 * schema always gives the same value: the first enum or anyOf variant, `true` for booleans (so
 * loops on an ok flag end), and `mock-<field>` for strings.
 */
export function fabricateFromSchema(schema: unknown, hint = "value", depth = 0): unknown {
  if (depth > 16) return null;
  if (!schema || typeof schema !== "object") return `mock-${hint}`;
  const s = schema as Record<string, unknown>;
  if (s.const !== undefined) return s.const;
  if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum[0];
  if (s.default !== undefined) return s.default;
  const variants = s.anyOf ?? s.oneOf ?? s.allOf;
  if (Array.isArray(variants) && variants.length > 0) return fabricateFromSchema(variants[0], hint, depth + 1);

  let type = s.type;
  if (Array.isArray(type)) type = type[0];
  if (type === undefined) {
    if (s.properties) type = "object";
    else if (s.items) type = "array";
    else return `mock-${hint}`;
  }

  switch (type) {
    case "object": {
      const out: Record<string, unknown> = {};
      const props = (s.properties ?? {}) as Record<string, unknown>;
      for (const [name, sub] of Object.entries(props)) {
        defineDataProperty(out, name, fabricateFromSchema(sub, name, depth + 1));
      }
      for (const name of Array.isArray(s.required) ? (s.required as string[]) : []) {
        if (!Object.prototype.hasOwnProperty.call(out, name)) defineDataProperty(out, name, `mock-${name}`);
      }
      return out;
    }
    case "array": {
      const min = typeof s.minItems === "number" ? s.minItems : 1;
      const count = Math.min(Math.max(min, 1), 3);
      return Array.from({ length: count }, (_x, i) => fabricateFromSchema(s.items, `${hint}-${i + 1}`, depth + 1));
    }
    case "string": {
      if (s.format === "uri" || s.format === "url") return "https://example.invalid/mock";
      if (s.format === "date-time") return "2024-01-01T00:00:00Z";
      if (s.format === "date") return "2024-01-01";
      let value = `mock-${hint}`;
      if (typeof s.minLength === "number" && value.length < s.minLength) {
        value = value.padEnd(s.minLength, "x");
      }
      if (typeof s.maxLength === "number" && value.length > s.maxLength) {
        value = value.slice(0, s.maxLength);
      }
      return value;
    }
    case "integer":
    case "number": {
      if (typeof s.minimum === "number") return s.minimum;
      if (typeof s.maximum === "number" && (s.maximum as number) < 1) return s.maximum;
      return 1;
    }
    case "boolean":
      return true;
    case "null":
      return null;
    default:
      return `mock-${hint}`;
  }
}
