import fc from 'fast-check';

/**
 * Inputs a model may send, generated from the JSON Schema it is shown.
 *
 * Covers the keywords tool schemas use. Any other keyword throws, so a schema
 * that starts using one fails here instead of being generated around.
 */

type JsonSchema = Readonly<Record<string, unknown>>;

/**
 * How an optional property the value leaves out is written: omitted, or sent
 * as `null` the way OpenAI strict mode requires (every key listed, unused ones null).
 */
export type AbsentOptional = 'omit' | 'null';

const ANNOTATIONS = new Set([
  '$schema',
  'default',
  'description',
  'examples',
  'title',
  'x-optional',
]);
const KEYWORDS = new Set([
  '$defs',
  '$ref',
  'additionalProperties',
  'anyOf',
  'const',
  'definitions',
  'enum',
  'exclusiveMaximum',
  'exclusiveMinimum',
  'items',
  'maximum',
  'maxItems',
  'maxLength',
  'minimum',
  'minItems',
  'minLength',
  'nullable',
  'pattern',
  'properties',
  'required',
  'type',
]);

function isSchema(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberKeyword(schema: JsonSchema, key: string): number | undefined {
  const value = schema[key];
  if (value === undefined) {
    return;
  }
  if (typeof value !== 'number') {
    throw new TypeError(`JSON Schema ${key} must be a number, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** A string's length as JSON Schema counts it: in code points. */
function codePointLength(value: string): number {
  return [...value].length;
}

export function jsonSchemaArbitrary(
  root: JsonSchema,
  absentOptional: AbsentOptional = 'omit'
): fc.Arbitrary<unknown> {
  const definitions = {
    ...(root['definitions'] as object),
    ...(root['$defs'] as object),
  } as Record<string, unknown>;

  const resolve = (ref: unknown): unknown => {
    const match = typeof ref === 'string' ? /^#\/(?:\$defs|definitions)\/(.+)$/u.exec(ref) : null;
    const name = match?.[1];
    if (name === undefined || !(name in definitions)) {
      throw new TypeError(`Unresolvable JSON Schema $ref ${String(ref)}`);
    }
    return definitions[name];
  };

  const ofType = (schema: JsonSchema, type: unknown): fc.Arbitrary<unknown> => {
    switch (type) {
      case 'null':
        return fc.constant(null);
      case 'boolean':
        return fc.boolean();
      case 'integer':
      case 'number': {
        const exclusiveMin = numberKeyword(schema, 'exclusiveMinimum');
        const exclusiveMax = numberKeyword(schema, 'exclusiveMaximum');
        const min = numberKeyword(schema, 'minimum') ?? exclusiveMin;
        const max = numberKeyword(schema, 'maximum') ?? exclusiveMax;
        if (type === 'integer') {
          return fc.integer({
            max:
              max === undefined
                ? Number.MAX_SAFE_INTEGER
                : Math.floor(max) - (max === exclusiveMax ? 1 : 0),
            min:
              min === undefined
                ? Number.MIN_SAFE_INTEGER
                : Math.ceil(min) + (min === exclusiveMin ? 1 : 0),
          });
        }
        return fc.double({
          noDefaultInfinity: true,
          noNaN: true,
          ...(max === undefined ? {} : { max, maxExcluded: max === exclusiveMax }),
          ...(min === undefined ? {} : { min, minExcluded: min === exclusiveMin }),
        });
      }
      case 'string': {
        const minLength = numberKeyword(schema, 'minLength') ?? 0;
        const maxLength = numberKeyword(schema, 'maxLength');
        const pattern = schema['pattern'];
        if (pattern === undefined) {
          return fc.string({ minLength, ...(maxLength === undefined ? {} : { maxLength }) });
        }
        if (typeof pattern !== 'string') {
          throw new TypeError('JSON Schema pattern must be a string');
        }
        return fc
          .stringMatching(new RegExp(pattern, 'u'))
          .filter(
            (value) =>
              codePointLength(value) >= minLength &&
              (maxLength === undefined || codePointLength(value) <= maxLength)
          );
      }
      case 'array': {
        const items = schema['items'];
        if (!isSchema(items)) {
          throw new TypeError('Only single-schema array items are supported');
        }
        const maxLength = numberKeyword(schema, 'maxItems');
        return fc.array(build(items), {
          minLength: numberKeyword(schema, 'minItems') ?? 0,
          ...(maxLength === undefined ? {} : { maxLength }),
        });
      }
      case 'object': {
        const properties = isSchema(schema['properties']) ? schema['properties'] : {};
        const required = new Set(
          Array.isArray(schema['required']) ? (schema['required'] as string[]) : []
        );
        const entries = Object.entries(properties).map(([key, property]) => {
          const value = build(property);
          return [
            key,
            absentOptional === 'null' && !required.has(key)
              ? fc.option(value, { nil: null })
              : value,
          ] as const;
        });
        const requiredKeys =
          absentOptional === 'null'
            ? entries.map(([key]) => key)
            : entries.map(([key]) => key).filter((key) => required.has(key));
        return fc.record(Object.fromEntries(entries), { requiredKeys });
      }
      default:
        throw new TypeError(`Unsupported JSON Schema type ${JSON.stringify(type)}`);
    }
  };

  function build(schema: unknown): fc.Arbitrary<unknown> {
    if (!isSchema(schema)) {
      throw new TypeError(`Unsupported JSON Schema ${JSON.stringify(schema)}`);
    }
    for (const key of Object.keys(schema)) {
      if (!(KEYWORDS.has(key) || ANNOTATIONS.has(key))) {
        throw new TypeError(`Unsupported JSON Schema keyword ${key}`);
      }
    }
    if (schema['$ref'] !== undefined) {
      return build(resolve(schema['$ref']));
    }
    let arbitrary: fc.Arbitrary<unknown>;
    if (Array.isArray(schema['anyOf'])) {
      arbitrary = fc.oneof(...(schema['anyOf'] as unknown[]).map(build));
    } else if (Array.isArray(schema['enum'])) {
      arbitrary = fc.constantFrom(...(schema['enum'] as unknown[]));
    } else if ('const' in schema) {
      arbitrary = fc.constant(schema['const']);
    } else if (Array.isArray(schema['type'])) {
      arbitrary = fc.oneof(...(schema['type'] as unknown[]).map((type) => ofType(schema, type)));
    } else {
      arbitrary = ofType(schema, schema['type']);
    }
    // OpenAPI's `nullable`, which the Google layer emits in place of a null branch.
    return schema['nullable'] === true ? fc.option(arbitrary, { nil: null }) : arbitrary;
  }

  return build(root);
}
