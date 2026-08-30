import { z } from 'zod';

export type ProviderCompatibleInputSchema<Schema extends z.ZodType = z.ZodType> =
  z.ZodPreprocess<Schema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

    let hasConst = false;
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (!(isRecord(propertySchema) && 'const' in propertySchema)) {
        continue;
      }
      hasConst = true;
      if (propertySchema['const'] !== value[key]) {
        return false;
      }
    }
    return hasConst;
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

function normalizeProviderNulls(value: unknown, schema: unknown): unknown {
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
 * Treat provider-emitted `null` as omission at the complete-input boundary.
 * A single immutable JSON Schema traversal removes null only from declared
 * optional/defaulted object properties. Required, unknown, dynamic-record, and
 * ambiguous-union values remain untouched for the authored schema to validate.
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
