export type UnknownRecord = Record<string, unknown>;

export const MCP_APP_MAX_MESSAGE_BYTES = 256 * 1024;
export const MCP_APP_MAX_METADATA_BYTES = 64 * 1024;

const ENCODER = new TextEncoder();

export function expectEncodedSize(value: unknown, maximumBytes: number, label: string): void {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError(`${label} is not JSON-serializable`);
  }
  // Every UTF-16 code unit encodes to at most three UTF-8 bytes, so a short
  // string cannot exceed the bound and the encode pass is skipped.
  if (encoded.length * 3 <= maximumBytes) {
    return;
  }
  if (ENCODER.encode(encoded).byteLength > maximumBytes) {
    throw new TypeError(`${label} exceeds the maximum encoded size of ${maximumBytes} bytes`);
  }
}

export function expectRecord(value: unknown, label: string): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }

  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }

  return value as UnknownRecord;
}

export function expectExactKeys(
  value: UnknownRecord,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
  label: string
): void {
  const allowed = new Set(allowedKeys);
  const extraKey = Object.keys(value).find((key) => !allowed.has(key));
  if (extraKey !== undefined) {
    throw new TypeError(`${label} contains unsupported field "${extraKey}"`);
  }

  const missingKey = requiredKeys.find((key) => !Object.hasOwn(value, key));
  if (missingKey !== undefined) {
    throw new TypeError(`${label} is missing required field "${missingKey}"`);
  }
}

/** The part of a pinned SDK (zod) schema the host uses. */
export interface CanonicalSchema<Data = unknown> {
  safeParse(value: unknown):
    | { readonly data: Data; readonly success: true }
    | {
        readonly error: {
          readonly issues: readonly {
            readonly message: string;
            readonly path: readonly PropertyKey[];
          }[];
        };
        readonly success: false;
      };
}

/** Names a schema's first issue below `label`, dropping `envelopeDepth` leading path segments. */
export function describeSchemaIssue(
  issues: readonly { readonly message: string; readonly path: readonly PropertyKey[] }[],
  label: string,
  envelopeDepth = 0
): string {
  const [issue] = issues;
  const path =
    issue?.path
      .slice(envelopeDepth)
      .map((key) => `.${String(key)}`)
      .join('') ?? '';
  const detail = issue === undefined ? '' : `: ${issue.message}`;
  return `${label}${path} does not match its canonical schema${detail}`;
}

/**
 * The pinned schemas strip a field they don't define. The host refuses it
 * instead, so a peer cannot send what the stable contract leaves out.
 */
export function expectNoStrippedFields(input: unknown, output: unknown, label: string): void {
  if (input === output || typeof input !== 'object' || input === null) {
    return;
  }
  if (typeof output !== 'object' || output === null) {
    throw new TypeError(`${label} does not match its canonical schema`);
  }
  if (Array.isArray(input)) {
    input.forEach((entry: unknown, index) => {
      expectNoStrippedFields(entry, Reflect.get(output, index), `${label}[${index}]`);
    });
    return;
  }
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(output, key)) {
      throw new TypeError(`${label} contains unsupported field "${key}"`);
    }
    expectNoStrippedFields(Reflect.get(input, key), Reflect.get(output, key), `${label}.${key}`);
  }
}

/** A plain object that matches `schema` with nothing stripped; returns the schema's output. */
export function parseCanonicalRecord<Data>(
  schema: CanonicalSchema<Data>,
  value: unknown,
  label: string
): Data {
  const record = expectRecord(value, label);
  const result = schema.safeParse(record);
  if (!result.success) {
    throw new TypeError(describeSchemaIssue(result.error.issues, label));
  }
  expectNoStrippedFields(record, result.data, label);
  return result.data;
}
