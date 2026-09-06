/**
 * `toToolSchemaDisplay()` — the browser-safe inspector view of a native tool,
 * DERIVED from its registered Zod input schema (BST-1646 step c).
 *
 * The four hand-mirrored `tool-schemas-display-*.ts` tables this replaces
 * carried their own prose for all 39 tools and drifted from the wire schema
 * (`querySelf` gained an `explain` mode and an `analyze` field the mirror
 * never learned about). Here the wire schema IS the source: Zod 4's
 * `z.toJSONSchema` is run with the same `io: 'input'` options the provider
 * wrapper uses, so what the inspector shows is what the model is sent.
 *
 * Prose: a parameter's description is its `.describe()` text — the ONE prose
 * source. A definition's `display` map may add inspector-only prose for a
 * parameter whose wire description is absent or too terse for a human reader;
 * it never reaches the model, and a key that names no parameter throws at
 * derivation time.
 */
import { z } from 'zod';
import { InvalidNativeToolDefinitionError, type NativeToolDefinition } from './define.js';

/** Parameter type for display purposes. */
export type ParameterType = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'enum';

/** Single parameter definition for UI display. */
export interface ToolParameterDisplay {
  arrayItemType?: ParameterType;
  default?: unknown;
  description: string;
  enumValues?: string[];
  /** Inclusive numeric minimum, or minimum item count for arrays. */
  max?: number;
  maxLength?: number;
  /** Inclusive numeric maximum, or maximum item count for arrays. */
  min?: number;
  minLength?: number;
  name: string;
  required: boolean;
  type: ParameterType;
}

/** Complete schema display info for a tool. */
export interface ToolSchemaDisplay {
  description: string;
  parameters: ToolParameterDisplay[];
  returns: string;
  toolId: string;
}

type JsonSchema = Readonly<Record<string, unknown>>;

function asSchema(value: unknown): JsonSchema | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonSchema)
    : undefined;
}

/**
 * `anyOf`/`oneOf` branches, with JSON `null` branches (Zod `.nullable()`/
 * `.nullish()`) dropped.
 *
 * Returns `undefined` — not `[]` — when nothing survives the drop, because the
 * caller tests the result for truthiness. A union of nothing but `null` has no
 * displayable type, and an empty list here would take it down the branch path
 * and silently resolve it as `object`. `undefined` falls through to the switch,
 * which throws. Same rule in `typeArrayBranches`, so both spellings of "null and
 * nothing else" fail identically.
 */
function unionBranches(schema: JsonSchema): readonly JsonSchema[] | undefined {
  const raw = schema['oneOf'] ?? schema['anyOf'];
  if (!Array.isArray(raw)) {
    return;
  }
  const branches = raw.flatMap((branch) => {
    const candidate = asSchema(branch);
    return candidate && candidate['type'] !== 'null' ? [candidate] : [];
  });
  return branches.length > 0 ? branches : undefined;
}

/**
 * The same nullability, spelled the other way. Zod 4.4 emitted `.nullable()` /
 * `.nullish()` as an `anyOf` carrying a `{ type: 'null' }` branch, which
 * `unionBranches` drops; Zod 4.5.0 (colinhacks/zod#6412 and the surrounding
 * JSON Schema work) emits a type ARRAY instead — `type: ['string', 'null']`.
 * Rewriting the array into the branch list `unionBranches` would have produced
 * keeps one resolution path for both spellings, so a heterogeneous array and a
 * heterogeneous union stay indistinguishable rather than acquiring two
 * different answers. Sibling keywords ride along on each branch, which is what
 * keeps `type: ['array', 'null']` resolving its `items`.
 */
function typeArrayBranches(schema: JsonSchema): readonly JsonSchema[] | undefined {
  const raw = schema['type'];
  if (!Array.isArray(raw)) {
    return;
  }
  const branches = raw.flatMap((entry) => (entry === 'null' ? [] : [{ ...schema, type: entry }]));
  return branches.length > 0 ? branches : undefined;
}

interface ResolvedType {
  readonly arrayItemType?: ParameterType;
  readonly enumValues?: readonly string[];
  readonly type: ParameterType;
}

function mergeEnums(types: readonly ResolvedType[]): ResolvedType | undefined {
  if (types.length === 0 || !types.every((entry) => entry.type === 'enum')) {
    return;
  }
  return {
    enumValues: [...new Set(types.flatMap((entry) => entry.enumValues ?? []))],
    type: 'enum',
  };
}

function resolveType(schema: JsonSchema, path: string): ResolvedType {
  if (Array.isArray(schema['enum'])) {
    return { enumValues: schema['enum'].map(String), type: 'enum' };
  }
  if ('const' in schema) {
    return { enumValues: [String(schema['const'])], type: 'enum' };
  }
  // `anyOf`/`oneOf` wins when a schema carries BOTH it and a type array. Both
  // together are legal JSON Schema; the union keyword is the more specific
  // statement, and Zod emits exactly one of the two, so this only arbitrates
  // hand-authored input.
  const branches = unionBranches(schema) ?? typeArrayBranches(schema);
  if (branches) {
    const resolved = branches.map((branch) => resolveType(branch, path));
    const merged = mergeEnums(resolved);
    if (merged) {
      return merged;
    }
    const [first] = resolved;
    if (!first || resolved.some((entry) => entry.type !== first.type)) {
      // A genuinely heterogeneous union has no single inspector type; the
      // wire schema still carries every branch.
      return { type: 'object' };
    }
    return first;
  }
  switch (schema['type']) {
    case 'string':
      return { type: 'string' };
    case 'number':
    case 'integer':
      return { type: 'number' };
    case 'boolean':
      return { type: 'boolean' };
    case 'object':
      return { type: 'object' };
    case 'array': {
      const items = asSchema(schema['items']);
      return items
        ? { arrayItemType: resolveType(items, `${path}[]`).type, type: 'array' }
        : { type: 'array' };
    }
    default:
      throw new InvalidNativeToolDefinitionError(
        path,
        `parameter JSON schema has no displayable type: ${JSON.stringify(schema)}`
      );
  }
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/** Zod's `.int()` bounds are ±MAX_SAFE_INTEGER; they are not a declared range. */
function declaredBound(value: number | undefined): number | undefined {
  return value === undefined || Math.abs(value) === Number.MAX_SAFE_INTEGER ? undefined : value;
}

/** `{ [key]: value }` when the bound is declared, `{}` otherwise (exactOptionalPropertyTypes-safe). */
function defined<Key extends string>(key: Key, value: number | undefined): { [P in Key]?: number } {
  return value === undefined ? {} : ({ [key]: value } as { [P in Key]: number });
}

function numericBounds(
  schema: JsonSchema,
  type: ParameterType
): Pick<ToolParameterDisplay, 'max' | 'maxLength' | 'min' | 'minLength'> {
  if (type === 'array') {
    return {
      ...defined('max', asNumber(schema['maxItems'])),
      ...defined('min', asNumber(schema['minItems'])),
    };
  }
  if (type === 'string' || type === 'enum') {
    return {
      ...defined('maxLength', asNumber(schema['maxLength'])),
      ...defined('minLength', asNumber(schema['minLength'])),
    };
  }
  if (type !== 'number') {
    return {};
  }
  const integer = schema['type'] === 'integer';
  const exclusiveMin = asNumber(schema['exclusiveMinimum']);
  const exclusiveMax = asNumber(schema['exclusiveMaximum']);
  // An exclusive bound on an integer is one past the inclusive one
  // (`.positive()` ⇒ exclusiveMinimum 0 ⇒ min 1); on a float it is left
  // undeclared rather than misreported as inclusive.
  const min = declaredBound(
    asNumber(schema['minimum']) ??
      (integer && exclusiveMin !== undefined ? exclusiveMin + 1 : undefined)
  );
  const max = declaredBound(
    asNumber(schema['maximum']) ??
      (integer && exclusiveMax !== undefined ? exclusiveMax - 1 : undefined)
  );
  return { ...defined('max', max), ...defined('min', min) };
}

/** The nullable-stripped schema a parameter's facets are read from. */
function facetSchema(schema: JsonSchema): JsonSchema {
  const branches = unionBranches(schema);
  return branches && branches.length === 1 && branches[0] ? { ...branches[0], ...schema } : schema;
}

interface ParameterSource {
  readonly required: boolean;
  readonly schema: JsonSchema;
}

/** The strict object(s) a tool's parameters are read from: the root, or every branch of a root union. */
function rootObjects(root: JsonSchema, toolId: string): readonly JsonSchema[] {
  const objects = root['type'] === 'object' ? [root] : (unionBranches(root) ?? []);
  if (objects.length === 0 || objects.some((object) => object['type'] !== 'object')) {
    throw new InvalidNativeToolDefinitionError(
      toolId,
      'input schema must be an object or a union of objects to be displayable'
    );
  }
  return objects;
}

function propertiesOf(object: JsonSchema): JsonSchema {
  return asSchema(object['properties']) ?? {};
}

/**
 * Top-level parameters. A strict object contributes its properties; a
 * discriminated union of objects contributes the union of every branch's
 * properties, required only when present and required in EVERY branch.
 */
function collectParameters(root: JsonSchema, toolId: string): ReadonlyMap<string, ParameterSource> {
  const objects = rootObjects(root, toolId);
  const parameters = new Map<string, ParameterSource>();
  for (const object of objects) {
    const required = new Set(Array.isArray(object['required']) ? object['required'] : []);
    for (const [name, property] of Object.entries(propertiesOf(object))) {
      const schema = asSchema(property);
      if (!schema) {
        throw new InvalidNativeToolDefinitionError(toolId, `parameter ${name} is not a schema`);
      }
      const previous = parameters.get(name);
      parameters.set(name, {
        required: (previous?.required ?? true) && required.has(name),
        schema: previous ? mergeVariant(previous.schema, schema) : schema,
      });
    }
  }
  for (const [name, source] of parameters) {
    if (objects.some((object) => !(name in propertiesOf(object)))) {
      parameters.set(name, { ...source, required: false });
    }
  }
  return parameters;
}

/** Merge a parameter that appears in several union branches into one displayable schema. */
function mergeVariant(left: JsonSchema, right: JsonSchema): JsonSchema {
  return {
    anyOf: [left, right],
    ...(typeof left['description'] === 'string' ? { description: left['description'] } : {}),
  };
}

const JSON_SCHEMA_OPTIONS = {
  cycles: 'throw',
  io: 'input',
  reused: 'inline',
  unrepresentable: 'any',
} as const;

/**
 * Derive the inspector display for one definition from its registered input
 * schema. Throws {@link InvalidNativeToolDefinitionError} for an input schema
 * that is not an object (or union of objects), a parameter with no
 * displayable type, or a `display` key that names no parameter.
 */
export function toToolSchemaDisplay(definition: NativeToolDefinition): ToolSchemaDisplay {
  const root = z.toJSONSchema(definition.inputSchema, JSON_SCHEMA_OPTIONS) as JsonSchema;
  const sources = collectParameters(root, definition.id);
  const display = definition.display ?? {};
  for (const key of Object.keys(display)) {
    if (!sources.has(key)) {
      throw new InvalidNativeToolDefinitionError(
        definition.id,
        `display prose names "${key}", which is not an input parameter`
      );
    }
  }
  const parameters = [...sources].map(([name, source]): ToolParameterDisplay => {
    const path = `${definition.id}.${name}`;
    const resolved = resolveType(source.schema, path);
    const facets = facetSchema(source.schema);
    const wireDescription = typeof facets['description'] === 'string' ? facets['description'] : '';
    return {
      ...(resolved.arrayItemType ? { arrayItemType: resolved.arrayItemType } : {}),
      ...('default' in facets ? { default: facets['default'] } : {}),
      description: display[name] ?? wireDescription,
      ...(resolved.enumValues ? { enumValues: [...resolved.enumValues] } : {}),
      ...numericBounds(facets, resolved.type),
      name,
      required: source.required,
      type: resolved.type,
    };
  });
  return {
    description: definition.description,
    parameters,
    returns: definition.returns,
    toolId: definition.id,
  };
}
