/** Small helpers shared by the JSON-RPC correlator, frame session, and bridge. */

export function correlationKey(id: number | string): string {
  return `${typeof id}:${id}`;
}

export function parsePositiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

export function toError(value: unknown, message: string): Error {
  return value instanceof Error ? value : new Error(message, { cause: value });
}
