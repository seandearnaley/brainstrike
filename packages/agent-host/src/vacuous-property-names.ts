/**
 * Drop `propertyNames` wherever it cannot reject anything.
 *
 * JSON object keys are always strings, so `propertyNames: {type: 'string'}`
 * (what Zod 4 emits for every `z.record(z.string(), …)`, and therefore what many
 * MCP servers advertise), `{}` and `true` constrain nothing. OpenAI still strips
 * the keyword and reports a compatibility warning on every request that carries
 * one, which buries real warnings. Removing the no-op changes no accepted input.
 *
 * A `propertyNames` that does constrain keys (a pattern, an enum, a length) is
 * kept, so a provider that drops it still says so. Only the model-facing view
 * is rewritten; the authored validator keeps the original schema. The input is
 * never mutated, and an unchanged subtree is returned as the same object.
 */

type Json = unknown;

/** Keywords whose value is one subschema (or, for `items`, an array of them). */
const SUBSCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  'additionalItems',
  'additionalProperties',
  'contains',
  'contentSchema',
  'else',
  'if',
  'items',
  'not',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
  // Arrays of subschemas.
  'allOf',
  'anyOf',
  'oneOf',
  'prefixItems',
]);
/** Keywords whose value maps a name to a subschema. */
const SUBSCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set([
  '$defs',
  'definitions',
  'dependencies',
  'dependentSchemas',
  'patternProperties',
  'properties',
]);

function isObject(value: Json): value is Record<string, Json> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isVacuousPropertyNames(value: Json): boolean {
  if (value === true) {
    return true;
  }
  if (!isObject(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.length === 0 || (keys.length === 1 && value['type'] === 'string');
}

/** One subschema or an array of them. */
function subschemas(value: Json): Json {
  if (!Array.isArray(value)) {
    return withoutVacuousPropertyNames(value);
  }
  const mapped = value.map(withoutVacuousPropertyNames);
  return mapped.every((entry, index) => entry === value[index]) ? value : mapped;
}

/** A name-to-subschema map; `dependencies` may also hold property-name lists. */
function subschemaMap(value: Json): Json {
  if (!isObject(value)) {
    return value;
  }
  const entries = Object.entries(value);
  const mapped = entries.map(([key, entry]) => [
    key,
    Array.isArray(entry) ? entry : withoutVacuousPropertyNames(entry),
  ]);
  return mapped.every(([, entry], index) => entry === entries[index]?.[1])
    ? value
    : Object.fromEntries(mapped);
}

export function withoutVacuousPropertyNames<Schema extends Json>(schema: Schema): Schema {
  if (!isObject(schema)) {
    return schema;
  }
  let changed = false;
  const result: Record<string, Json> = {};
  for (const [keyword, value] of Object.entries(schema)) {
    if (keyword === 'propertyNames' && isVacuousPropertyNames(value)) {
      changed = true;
      continue;
    }
    const next = SUBSCHEMA_KEYWORDS.has(keyword)
      ? subschemas(value)
      : SUBSCHEMA_MAP_KEYWORDS.has(keyword)
        ? subschemaMap(value)
        : value;
    changed ||= next !== value;
    result[keyword] = next;
  }
  return (changed ? result : schema) as Schema;
}
