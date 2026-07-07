import type { StreamChunk } from '../types';

/**
 * Serializes arbitrary values into JSON-safe structures while preserving helpful metadata.
 */
export function toJsonSafe(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null) {
    return value;
  }

  const primitive = serializePrimitive(value);
  if (primitive.handled) {
    return primitive.value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (
    typeof Buffer !== 'undefined' &&
    typeof Buffer.isBuffer === 'function' &&
    Buffer.isBuffer(value)
  ) {
    return serializeBuffer(value as Buffer);
  }

  if (ArrayBuffer.isView(value)) {
    return serializeTypedArray(value);
  }

  if (value instanceof Map) {
    return serializeMap(value, seen);
  }

  if (value instanceof Set) {
    return serializeSet(value, seen);
  }

  if (value instanceof Error) {
    return serializeError(value, seen);
  }

  if (typeof value === 'object') {
    return serializeObject(value as Record<PropertyKey, unknown>, seen);
  }

  return value;
}

type PrimitiveResult = { handled: true; value: unknown } | { handled: false };

function serializePrimitive(value: unknown): PrimitiveResult {
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'undefined':
      return { handled: true, value };
    case 'bigint':
      return { handled: true, value: value.toString() };
    case 'symbol':
      return {
        handled: true,
        value: value.description ? `Symbol(${value.description})` : 'Symbol()',
      };
    case 'function': {
      const fn = value as { name?: string };
      return {
        handled: true,
        value: `[Function ${fn.name || 'anonymous'}]`,
      };
    }
    default:
      return { handled: false };
  }
}

function serializeBuffer(buffer: Buffer): JsonBufferLike {
  return {
    __type: 'Buffer',
    data: buffer.toString('base64'),
    encoding: 'base64',
    size: buffer.length,
  } satisfies JsonBufferLike;
}

function serializeTypedArray(view: ArrayBufferView): JsonTypedArrayLike {
  const begin = view.byteOffset;
  const end = view.byteOffset + view.byteLength;
  const bufferSlice = view.buffer.slice(begin, end);
  const uint8 = new Uint8Array(bufferSlice);

  if (typeof Buffer !== 'undefined') {
    return {
      __type: view.constructor?.name ?? 'TypedArray',
      byteLength: view.byteLength,
      byteOffset: view.byteOffset,
      data: Buffer.from(uint8).toString('base64'),
      encoding: 'base64',
    } satisfies JsonTypedArrayLike;
  }

  return {
    __type: view.constructor?.name ?? 'TypedArray',
    byteLength: view.byteLength,
    byteOffset: view.byteOffset,
    data: Array.from(uint8),
    encoding: 'array',
  } satisfies JsonTypedArrayLike;
}

function serializeMap(mapValue: Map<unknown, unknown>, seen: WeakSet<object>): JsonMapLike {
  const entries: Record<string, unknown> = {};
  for (const [key, entryValue] of mapValue.entries()) {
    entries[String(key)] = toJsonSafe(entryValue, seen);
  }
  return { __type: 'Map', entries } satisfies JsonMapLike;
}

function serializeSet(setValue: Set<unknown>, seen: WeakSet<object>): JsonSetLike {
  const values = Array.from(setValue.values()).map((entry) => toJsonSafe(entry, seen));
  return { __type: 'Set', values } satisfies JsonSetLike;
}

function serializeError(errorValue: Error, seen: WeakSet<object>): Record<string, unknown> {
  const base: Record<string, unknown> = {
    message: errorValue.message,
    name: errorValue.name,
    stack: errorValue.stack,
  };

  const errorRecord = errorValue as Error & Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(errorRecord)) {
    if (!(key in base)) {
      base[key] = toJsonSafe(errorRecord[key], seen);
    }
  }

  return base;
}

function serializeObject(obj: Record<PropertyKey, unknown>, seen: WeakSet<object>): unknown {
  if (seen.has(obj)) {
    return '[Circular]';
  }
  seen.add(obj);

  const toJSON = (obj as { toJSON?: () => unknown })['toJSON'];
  if (typeof toJSON === 'function') {
    try {
      const result = toJsonSafe(toJSON.call(obj), seen);
      seen.delete(obj);
      return result;
    } catch {
      // fall through to manual serialization
    }
  }

  if (Array.isArray(obj)) {
    const arrayResult = obj.map((item) => (item === undefined ? null : toJsonSafe(item, seen)));
    seen.delete(obj);
    return arrayResult;
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(obj)) {
    if (entry === undefined) {
      continue;
    }
    result[key] = toJsonSafe(entry, seen);
  }

  seen.delete(obj);
  return result;
}

export function cloneJsonSafe<T>(value: T): T {
  return toJsonSafe(value) as T;
}

export function sanitizeStreamChunk<T extends StreamChunk>(chunk: T): T {
  const copy: Record<string, unknown> = { ...chunk };
  if ('payload' in copy) {
    copy['payload'] = toJsonSafe(copy['payload']);
  }
  if ('usage' in copy) {
    copy['usage'] = toJsonSafe(copy['usage']);
  }
  if ('value' in copy && typeof copy['value'] !== 'string') {
    copy['value'] = String(copy['value'] ?? '');
  }
  if ('path' in copy && Array.isArray(copy['path'])) {
    copy['path'] = (copy['path'] as unknown[]).slice();
  }
  return copy as T;
}

interface JsonBufferLike {
  __type: 'Buffer';
  data: string;
  encoding: 'base64';
  size: number;
}

interface JsonTypedArrayLike {
  __type: string;
  byteLength: number;
  byteOffset: number;
  data: string | number[];
  encoding: 'base64' | 'array';
}

interface JsonMapLike {
  __type: 'Map';
  entries: Record<string, unknown>;
}

interface JsonSetLike {
  __type: 'Set';
  values: unknown[];
}
