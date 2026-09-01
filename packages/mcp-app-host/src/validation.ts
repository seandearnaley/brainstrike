export type UnknownRecord = Record<string, unknown>;

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
