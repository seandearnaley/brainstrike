/** Pure structural helpers shared by preload-safe desktop IPC contracts. */
export type ParamsRecord = Readonly<Record<string, unknown>>;

export function assertArgCount(raw: readonly unknown[], expected: number, subject: string): void {
  if (raw.length !== expected) {
    throw new Error(`${subject} requires exactly ${expected} argument${expected === 1 ? '' : 's'}`);
  }
}

export function parseRecord(value: unknown, subject: string): ParamsRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${subject} requires an object`);
  }
  return value as ParamsRecord;
}

export function assertSupportedKeys(
  record: ParamsRecord,
  supported: readonly string[],
  subject: string
): void {
  const supportedKeys = new Set(supported);
  const unsupported = Object.keys(record).filter((key) => !supportedKeys.has(key));
  if (unsupported.length > 0) {
    throw new Error(`${subject} received unsupported fields: ${unsupported.join(', ')}`);
  }
}

export function requireStringType(record: ParamsRecord, key: string, subject: string): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new Error(`${subject} ${key} must be a string`);
  }
  return value;
}

export function optionalStringType(
  record: ParamsRecord,
  key: string,
  subject: string
): string | undefined {
  const value = record[key];
  if (value !== undefined && typeof value !== 'string') {
    throw new Error(`${subject} ${key} must be a string when present`);
  }
  return value;
}

export function optionalBoolean(
  record: ParamsRecord,
  key: string,
  subject: string
): boolean | undefined {
  const value = record[key];
  if (value !== undefined && typeof value !== 'boolean') {
    throw new Error(`${subject} ${key} must be a boolean when present`);
  }
  return value;
}

export function hasOwn(record: ParamsRecord, key: string): boolean {
  return Object.hasOwn(record, key);
}
