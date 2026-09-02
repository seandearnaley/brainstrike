/**
 * Client-side mirror of the MCP form-elicitation validation performed by
 * `validateMcpElicitationResult` in `packages/agent/src/mcp/client-capabilities.ts`
 * (BST-1584). This never REPLACES the host validation — desktop main and the
 * SDK re-validate every accepted settlement — it only gives the consent dialog
 * field-level feedback before the settlement crosses the bridge.
 */
import type {
  McpElicitationContentValue,
  McpElicitationPrimitiveSchemaWire,
  McpElicitationRequestedSchemaWire,
} from '@brainstrike/assistant-contract';

/** Raw dialog field state before coercion (numbers stay text until submit). */
export type McpElicitationFieldValue = boolean | string | readonly string[];
export type McpElicitationFieldValues = Readonly<Record<string, McpElicitationFieldValue>>;

export type McpElicitationFieldKind =
  | 'boolean'
  | 'multi-select'
  | 'number'
  | 'single-select'
  | 'string';

export interface McpElicitationFieldOption {
  readonly label: string;
  readonly value: string;
}

export type McpElicitationFormOutcome =
  | { readonly content: Record<string, McpElicitationContentValue>; readonly ok: true }
  | { readonly errors: Readonly<Record<string, string>>; readonly ok: false };

export function describeMcpElicitationField(
  schema: McpElicitationPrimitiveSchemaWire
): McpElicitationFieldKind {
  if (schema.type === 'boolean') {
    return 'boolean';
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    return 'number';
  }
  if (schema.type === 'array') {
    return 'multi-select';
  }
  return 'enum' in schema || 'oneOf' in schema ? 'single-select' : 'string';
}

export function readMcpElicitationFieldOptions(
  schema: McpElicitationPrimitiveSchemaWire
): readonly McpElicitationFieldOption[] {
  if (schema.type === 'array') {
    return 'anyOf' in schema.items
      ? schema.items.anyOf.map(({ const: value, title }) => ({ label: title, value }))
      : schema.items.enum.map((value) => ({ label: value, value }));
  }
  if (schema.type !== 'string') {
    return [];
  }
  if ('oneOf' in schema) {
    return schema.oneOf.map(({ const: value, title }) => ({ label: title, value }));
  }
  if ('enum' in schema) {
    return schema.enum.map((value, index) => ({
      label: schema.enumNames?.[index] ?? value,
      value,
    }));
  }
  return [];
}

export function initialMcpElicitationFieldValues(
  requestedSchema: McpElicitationRequestedSchemaWire
): McpElicitationFieldValues {
  const values: Record<string, McpElicitationFieldValue> = {};
  for (const [name, schema] of Object.entries(requestedSchema.properties)) {
    switch (describeMcpElicitationField(schema)) {
      case 'boolean':
        // Only a declared default seeds a value: an untouched optional boolean
        // stays absent so the server can tell "not answered" from "false".
        if (schema.type === 'boolean' && typeof schema.default === 'boolean') {
          values[name] = schema.default;
        }
        break;
      case 'multi-select':
        values[name] = schema.type === 'array' && schema.default ? [...schema.default] : [];
        break;
      default:
        values[name] = typeof schema.default === 'string' ? schema.default : '';
        if (typeof schema.default === 'number') {
          values[name] = String(schema.default);
        }
    }
  }
  return values;
}

function isEmail(value: string): boolean {
  if (value.length > 254) {
    return false;
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x20 || codePoint === 0x7f)) {
      return false;
    }
  }
  const match =
    /^([A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*)@([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)$/u.exec(
      value
    );
  const local = match?.[1];
  const domain = match?.[2];
  return Boolean(local && domain && local.length <= 64 && domain.length <= 253);
}

function isAbsoluteUri(value: string): boolean {
  try {
    return new URL(value).protocol.length > 1;
  } catch {
    return false;
  }
}

function isFullDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function isDateTime(value: string): boolean {
  return (
    isFullDate(value.slice(0, 10)) &&
    /^[Tt](?:[01]\d|2[0-3]):[0-5]\d:(?:[0-5]\d|60)(?:\.\d+)?(?:[Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u.test(
      value.slice(10)
    )
  );
}

function validateString(
  schema: Extract<McpElicitationPrimitiveSchemaWire, { type: 'string' }>,
  value: string
): string | undefined {
  if ('enum' in schema || 'oneOf' in schema) {
    const allowed = readMcpElicitationFieldOptions(schema).map((option) => option.value);
    return allowed.includes(value) ? undefined : 'Choose one of the offered values.';
  }
  if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
    return `Enter at least ${schema.minLength} characters.`;
  }
  if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
    return `Enter at most ${schema.maxLength} characters.`;
  }
  switch (schema.format) {
    case undefined:
      return undefined;
    case 'email':
      return isEmail(value) ? undefined : 'Enter a valid email address.';
    case 'uri':
      return isAbsoluteUri(value) ? undefined : 'Enter an absolute URI.';
    case 'date':
      return isFullDate(value) ? undefined : 'Enter a date as YYYY-MM-DD.';
    case 'date-time':
      return isDateTime(value)
        ? undefined
        : 'Enter a date-time as YYYY-MM-DDTHH:MM:SSZ (or with a UTC offset).';
    default:
      return 'This field uses an unsupported string format.';
  }
}

function validateNumber(
  schema: Extract<McpElicitationPrimitiveSchemaWire, { type: 'integer' | 'number' }>,
  raw: string
): { readonly error: string } | { readonly value: number } {
  const value = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(value)) {
    return { error: 'Enter a number.' };
  }
  if (schema.type === 'integer' && !Number.isInteger(value)) {
    return { error: 'Enter a whole number.' };
  }
  if (typeof schema.minimum === 'number' && value < schema.minimum) {
    return { error: `Enter a value of at least ${schema.minimum}.` };
  }
  if (typeof schema.maximum === 'number' && value > schema.maximum) {
    return { error: `Enter a value of at most ${schema.maximum}.` };
  }
  return { value };
}

function validateMultiSelect(
  schema: Extract<McpElicitationPrimitiveSchemaWire, { type: 'array' }>,
  value: readonly string[]
): string | undefined {
  const allowed = new Set(readMcpElicitationFieldOptions(schema).map((option) => option.value));
  if (!value.every((entry) => allowed.has(entry))) {
    return 'Choose only offered values.';
  }
  if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
    return `Choose at least ${schema.minItems}.`;
  }
  if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
    return `Choose at most ${schema.maxItems}.`;
  }
  return undefined;
}

type FieldOutcome =
  | { readonly error: string }
  | { readonly skip: true }
  | { readonly value: McpElicitationContentValue };

function coerceMultiSelect(
  schema: McpElicitationPrimitiveSchemaWire,
  value: McpElicitationFieldValue | undefined,
  isRequired: boolean
): FieldOutcome {
  const entries = Array.isArray(value) ? [...value] : [];
  if (entries.length === 0 && !isRequired) {
    return { skip: true };
  }
  const error = schema.type === 'array' ? validateMultiSelect(schema, entries) : undefined;
  return error ? { error } : { value: entries };
}

function coerceNumber(
  schema: McpElicitationPrimitiveSchemaWire,
  value: McpElicitationFieldValue | undefined,
  isRequired: boolean
): FieldOutcome {
  const raw = typeof value === 'string' ? value : '';
  if (raw.trim() === '' && !isRequired) {
    return { skip: true };
  }
  if (schema.type !== 'number' && schema.type !== 'integer') {
    return { skip: true };
  }
  return validateNumber(schema, raw);
}

function coerceString(
  schema: McpElicitationPrimitiveSchemaWire,
  value: McpElicitationFieldValue | undefined,
  isRequired: boolean
): FieldOutcome {
  const raw = typeof value === 'string' ? value : '';
  if (raw === '') {
    return isRequired ? { error: 'This field is required.' } : { skip: true };
  }
  const error = schema.type === 'string' ? validateString(schema, raw) : undefined;
  return error ? { error } : { value: raw };
}

function coerceField(
  schema: McpElicitationPrimitiveSchemaWire,
  value: McpElicitationFieldValue | undefined,
  isRequired: boolean
): FieldOutcome {
  switch (describeMcpElicitationField(schema)) {
    case 'boolean':
      if (value === undefined) {
        return isRequired ? { value: false } : { skip: true };
      }
      return { value: value === true };
    case 'multi-select':
      return coerceMultiSelect(schema, value, isRequired);
    case 'number':
      return coerceNumber(schema, value, isRequired);
    default:
      return coerceString(schema, value, isRequired);
  }
}

/**
 * Coerce dialog field state into accepted elicitation content. Optional
 * fields left blank are omitted (so a blank optional string never trips a
 * `minLength`, and an untouched optional boolean without a default is not
 * reported as `false`), required fields must be present, and every constraint the host
 * validator enforces is checked here first.
 */
export function buildMcpElicitationContent(
  requestedSchema: McpElicitationRequestedSchemaWire,
  values: McpElicitationFieldValues
): McpElicitationFormOutcome {
  const content: Record<string, McpElicitationContentValue> = {};
  const errors: Record<string, string> = {};
  const required = new Set(requestedSchema.required ?? []);
  for (const [name, schema] of Object.entries(requestedSchema.properties)) {
    const outcome = coerceField(schema, values[name], required.has(name));
    if ('error' in outcome) {
      errors[name] = outcome.error;
    } else if ('value' in outcome) {
      content[name] = outcome.value;
    }
  }
  return Object.keys(errors).length > 0 ? { errors, ok: false } : { content, ok: true };
}
