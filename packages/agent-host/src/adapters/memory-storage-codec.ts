import type { MemoryJson, MemoryJsonObject } from '../../../state-store/dist/memory-types.js';

/** Runtime models/hooks remain capabilities. Persist only their data configuration. */
export function memoryConfiguration(value: Record<string, unknown>): MemoryJsonObject {
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'hooks') {
      continue;
    }
    if (key === 'model' && entry && typeof entry === 'object' && 'modelId' in entry) {
      const provider = 'provider' in entry ? entry.provider : undefined;
      result[key] = {
        modelId: entry.modelId,
        ...(typeof provider === 'string' ? { provider } : {}),
      };
    } else if (
      (key === 'observation' || key === 'reflection') &&
      entry &&
      typeof entry === 'object'
    ) {
      result[key] = memoryConfiguration(entry as Record<string, unknown>);
    } else {
      result[key] = entry;
    }
  }
  const encoded = encodeMemory(result);
  if (!(encoded && typeof encoded === 'object' && !Array.isArray(encoded))) {
    throw new TypeError('Invalid native memory configuration');
  }
  return encoded as MemoryJsonObject;
}

export function encodeMemory(value: unknown): MemoryJson {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((entry) => (entry === undefined ? null : encodeMemory(entry)));
  }
  if (
    value &&
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  ) {
    const result: Record<string, MemoryJson> = Object.create(null);
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) {
        result[key] = encodeMemory(entry);
      }
    }
    return result;
  }
  throw new TypeError('Native memory persistence requires data-only values');
}

const dates = new Set([
  'createdAt',
  'updatedAt',
  'lastObservedAt',
  'lastBufferedAtTime',
  'from',
  'to',
  'start',
  'end',
]);
/** Date revival is limited to native DTO fields; user metadata/content stays data. */
export function decodeMemory(value: MemoryJson): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => decodeMemory(entry));
  }
  if (!(value && typeof value === 'object')) {
    return value;
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, entry] of Object.entries(value)) {
    if (dates.has(key) && typeof entry === 'string') {
      const date = new Date(entry);
      if (!Number.isFinite(date.getTime())) {
        throw new Error('Invalid persisted native memory date');
      }
      result[key] = date;
    } else if (['config', 'metadata', 'content'].includes(key)) {
      result[key] = structuredClone(entry);
    } else {
      result[key] = decodeMemory(entry);
    }
  }
  return result;
}
