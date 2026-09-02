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
