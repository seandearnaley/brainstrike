import { z } from 'zod';

export type ProviderCompatibleInputSchema<Schema extends z.ZodType = z.ZodType> =
  z.ZodPreprocess<Schema>;

type InputPath = readonly (number | string)[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasNullObjectProperty(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => item !== null && hasNullObjectProperty(item));
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).some(
    (propertyValue) => propertyValue === null || hasNullObjectProperty(propertyValue)
  );
}

function inputPath(path: readonly PropertyKey[]): InputPath | undefined {
  return path.every((segment) => typeof segment === 'string' || typeof segment === 'number')
    ? (path as InputPath)
    : undefined;
}

function valueAtPath(value: unknown, path: InputPath): unknown {
  let current = value;
  for (const segment of path) {
    if (typeof segment === 'number') {
      if (!Array.isArray(current)) {
        return;
      }
      current = current[segment];
      continue;
    }
    if (!isRecord(current)) {
      return;
    }
    current = current[segment];
  }
  return current;
}

function resolveLocalReference(schema: unknown, rootSchema: Record<string, unknown>): unknown {
  if (!(isRecord(schema) && typeof schema['$ref'] === 'string')) {
    return schema;
  }
  if (!schema['$ref'].startsWith('#/')) {
    return;
  }

  let resolved: unknown = rootSchema;
  for (const encodedSegment of schema['$ref'].slice(2).split('/')) {
    const segment = encodedSegment.replaceAll('~1', '/').replaceAll('~0', '~');
    if (!(isRecord(resolved) && segment in resolved)) {
      return;
    }
    resolved = resolved[segment];
  }
  return resolved;
}

function discriminatedBranch(
  branches: readonly unknown[],
  value: unknown,
  rootSchema: Record<string, unknown>
): unknown {
  if (!isRecord(value)) {
    return;
  }
  const matches = branches.filter((branch) => {
    const resolvedBranch = resolveLocalReference(branch, rootSchema);
    const properties = isRecord(resolvedBranch) ? resolvedBranch['properties'] : undefined;
    return (
      isRecord(properties) &&
      Object.entries(properties).some(
        ([key, propertySchema]) =>
          isRecord(propertySchema) &&
          'const' in propertySchema &&
          propertySchema['const'] === value[key]
      )
    );
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function isDeclaredOmittableProperty(
  schema: unknown,
  value: unknown,
  path: InputPath,
  rootSchema: Record<string, unknown>
): boolean {
  const resolvedSchema = resolveLocalReference(schema, rootSchema);
  if (!isRecord(resolvedSchema)) {
    return false;
  }

  const unionBranches = Array.isArray(resolvedSchema['oneOf'])
    ? resolvedSchema['oneOf']
    : resolvedSchema['anyOf'];
  if (Array.isArray(unionBranches)) {
    const branch = discriminatedBranch(unionBranches, value, rootSchema);
    return branch !== undefined && isDeclaredOmittableProperty(branch, value, path, rootSchema);
  }

  const [segment, ...remaining] = path;
  if (segment === undefined) {
    return false;
  }
  if (typeof segment === 'number') {
    return (
      Array.isArray(value) &&
      resolvedSchema['items'] !== undefined &&
      isDeclaredOmittableProperty(resolvedSchema['items'], value[segment], remaining, rootSchema)
    );
  }
  const properties = resolvedSchema['properties'];
  if (!(isRecord(value) && isRecord(properties) && Object.hasOwn(properties, segment))) {
    return false;
  }
  if (remaining.length > 0) {
    return isDeclaredOmittableProperty(properties[segment], value[segment], remaining, rootSchema);
  }
  const required = Array.isArray(resolvedSchema['required']) ? resolvedSchema['required'] : [];
  return !required.includes(segment);
}

function collectIssuePaths(
  issue: z.ZodIssue,
  rawInput: unknown,
  nullPaths: InputPath[],
  unknownPaths: Set<string>
): void {
  if (issue.code === 'invalid_union') {
    for (const branchIssues of issue.errors) {
      for (const branchIssue of branchIssues) {
        collectIssuePaths(branchIssue, rawInput, nullPaths, unknownPaths);
      }
    }
    return;
  }

  const path = inputPath(issue.path);
  if (!path) {
    return;
  }
  if (issue.code === 'unrecognized_keys') {
    for (const key of issue.keys) {
      unknownPaths.add(JSON.stringify([...path, key]));
    }
    return;
  }
  if (
    (issue.code === 'invalid_type' || issue.code === 'invalid_value') &&
    typeof path.at(-1) === 'string' &&
    valueAtPath(rawInput, path) === null
  ) {
    nullPaths.push(path);
  }
}

function deleteObjectProperty(value: unknown, path: InputPath): unknown {
  const [segment, ...remaining] = path;
  if (segment === undefined) {
    return value;
  }
  if (typeof segment === 'number') {
    if (!Array.isArray(value) || segment < 0 || segment >= value.length) {
      return value;
    }
    const copy = [...value];
    copy[segment] = deleteObjectProperty(copy[segment], remaining);
    return copy;
  }
  if (!(isRecord(value) && segment in value)) {
    return value;
  }
  const copy = { ...value };
  if (remaining.length === 0) {
    delete copy[segment];
    return copy;
  }
  copy[segment] = deleteObjectProperty(copy[segment], remaining);
  return copy;
}

function normalizeProviderNulls<Schema extends z.ZodType>(
  rawInput: unknown,
  schema: Schema,
  jsonSchema: Record<string, unknown>
): unknown {
  if (!hasNullObjectProperty(rawInput)) {
    return rawInput;
  }
  const initial = schema.safeParse(rawInput);
  if (initial.success) {
    return rawInput;
  }

  const nullPaths: InputPath[] = [];
  const unknownPaths = new Set<string>();
  for (const issue of initial.error.issues) {
    collectIssuePaths(issue, rawInput, nullPaths, unknownPaths);
  }
  return nullPaths
    .filter(
      (path) =>
        !unknownPaths.has(JSON.stringify(path)) &&
        isDeclaredOmittableProperty(jsonSchema, rawInput, path, jsonSchema)
    )
    .reduce((input, path) => deleteObjectProperty(input, path), rawInput);
}

/**
 * Treat provider-emitted `null` as omission at the complete-input boundary.
 * Only object properties rejected by the authored schema as the wrong type
 * are candidates; unknown properties remain visible to strict validation,
 * while required and dynamic-record properties remain unchanged and fail.
 */
export function providerCompatibleInputSchema<Schema extends z.ZodType>(
  schema: Schema
): ProviderCompatibleInputSchema<Schema> {
  const jsonSchema = z.toJSONSchema(schema, {
    cycles: 'throw',
    io: 'input',
    reused: 'inline',
  });
  return z.preprocess((rawInput) => normalizeProviderNulls(rawInput, schema, jsonSchema), schema);
}
