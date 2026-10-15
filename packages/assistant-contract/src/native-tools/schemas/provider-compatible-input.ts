import { z } from 'zod';

export type ProviderCompatibleInputSchema<Schema extends z.ZodType = z.ZodType> =
  z.ZodPreprocess<Schema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The single literal a property schema pins, however its dialect spells it.
 *
 * zod emits a discriminant as `const`; Effect emits it as a one-element
 * `enum`. Both are draft-07, and this normalizer serves both tool-schema
 * producers, so it has to read both — the same reason it reads `oneOf` and
 * `anyOf`. A multi-value `enum` is a constrained field, NOT a discriminant,
 * and must not select a branch.
 */
function discriminantValue(propertySchema: unknown): { readonly value: unknown } | undefined {
  if (!isRecord(propertySchema)) {
    return;
  }
  if ('const' in propertySchema) {
    return { value: propertySchema['const'] };
  }
  const enumValues = propertySchema['enum'];
  return Array.isArray(enumValues) && enumValues.length === 1
    ? { value: enumValues[0] }
    : undefined;
}

function constMatchedBranch(branches: readonly unknown[], value: unknown): unknown {
  if (!isRecord(value)) {
    return;
  }

  const matches = branches.filter((branch) => {
    if (!isRecord(branch)) {
      return false;
    }
    const properties = branch['properties'];
    if (!isRecord(properties)) {
      return false;
    }

    let hasDiscriminant = false;
    for (const [key, propertySchema] of Object.entries(properties)) {
      const discriminant = discriminantValue(propertySchema);
      if (!discriminant) {
        continue;
      }
      hasDiscriminant = true;
      if (discriminant.value !== value[key]) {
        return false;
      }
    }
    return hasDiscriminant;
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function uniqueStructuredBranch(branches: readonly unknown[], value: unknown): unknown {
  const expectedType = Array.isArray(value) ? 'array' : isRecord(value) ? 'object' : undefined;
  if (expectedType === undefined) {
    return;
  }

  const matches = branches.filter((branch) => {
    if (!isRecord(branch)) {
      return false;
    }
    if (branch['type'] === expectedType) {
      return true;
    }
    return expectedType === 'object'
      ? isRecord(branch['properties'])
      : branch['items'] !== undefined || Array.isArray(branch['prefixItems']);
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function normalizeArrayItems(value: unknown[], schema: Record<string, unknown>): unknown {
  const prefixItems = Array.isArray(schema['prefixItems']) ? schema['prefixItems'] : undefined;
  const itemSchema = schema['items'];
  if (prefixItems === undefined && itemSchema === undefined) {
    return value;
  }

  let changed = false;
  const normalizedItems = value.map((item, index) => {
    const indexedSchema = prefixItems?.[index] ?? itemSchema;
    if (indexedSchema === undefined) {
      return item;
    }
    const normalizedItem = normalizeProviderNulls(item, indexedSchema);
    changed ||= normalizedItem !== item;
    return normalizedItem;
  });
  return changed ? normalizedItems : value;
}

function normalizeDeclaredProperties(
  value: Record<string, unknown>,
  schema: Record<string, unknown>
): unknown {
  const properties = schema['properties'];
  if (!isRecord(properties)) {
    return value;
  }

  const required = new Set(
    Array.isArray(schema['required'])
      ? schema['required'].filter((key): key is string => typeof key === 'string')
      : []
  );
  let normalized: Record<string, unknown> | undefined;
  for (const [key, propertyValue] of Object.entries(value)) {
    if (!Object.hasOwn(properties, key)) {
      continue;
    }
    if (propertyValue === null && !required.has(key)) {
      normalized ??= { ...value };
      delete normalized[key];
      continue;
    }

    const normalizedProperty = normalizeProviderNulls(propertyValue, properties[key]);
    if (normalizedProperty !== propertyValue) {
      normalized ??= { ...value };
      normalized[key] = normalizedProperty;
    }
  }
  return normalized ?? value;
}

/**
 * Treat provider-emitted `null` as omission, deciding only from the authored
 * JSON Schema: a `null` is removed only where it sits on a declared
 * optional/defaulted object property. Required, unknown, dynamic-record and
 * ambiguous-union values are left for the authored schema to validate.
 *
 * This is the ONE normalizer for both tool-schema producers — the zod
 * {@link providerCompatibleInputSchema} below and the Effect
 * `effectToolInputSchema`. It reads a JSON Schema and a value, so it is not
 * specific to either library; do not write a second one.
 */
export function normalizeProviderNulls(value: unknown, schema: unknown): unknown {
  if (!isRecord(schema)) {
    return value;
  }

  const unionBranches = Array.isArray(schema['oneOf']) ? schema['oneOf'] : schema['anyOf'];
  if (Array.isArray(unionBranches)) {
    const branch =
      constMatchedBranch(unionBranches, value) ?? uniqueStructuredBranch(unionBranches, value);
    return branch === undefined ? value : normalizeProviderNulls(value, branch);
  }
  if (Array.isArray(value)) {
    return normalizeArrayItems(value, schema);
  }
  return isRecord(value) ? normalizeDeclaredProperties(value, schema) : value;
}

/**
 * Admit a zod schema as a native tool's input schema, normalizing provider
 * `null` to omission on the way in. Retained for the tool schemas not yet
 * moved to Effect Schema (ADR-0004, amended 2026-10-15); new tools use
 * `effectToolInputSchema`.
 */
export function providerCompatibleInputSchema<Schema extends z.ZodType>(
  schema: Schema
): ProviderCompatibleInputSchema<Schema> {
  let jsonSchema: unknown;
  return z.preprocess((rawInput) => {
    jsonSchema ??= z.toJSONSchema(schema, {
      cycles: 'throw',
      io: 'input',
      reused: 'inline',
    });
    return normalizeProviderNulls(rawInput, jsonSchema);
  }, schema);
}
