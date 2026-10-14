type ParamsRecord = Readonly<Record<string, unknown>>;
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
