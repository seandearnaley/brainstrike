import type { LoggerOptions } from 'pino';
import pino from 'pino';

/**
 * Does this value carry an Error's diagnostic payload?
 *
 * Deliberately wider than `instanceof Error` in two directions, each covering a
 * shape that reaches this serializer in practice:
 *
 * 1. **Cross-realm Errors.** `instanceof` is realm-bound, so an Error from a
 *    `node:vm` context, a worker, or a dual-loaded class hierarchy fails it.
 *    `[object Error]` reads the `[[ErrorData]]` internal slot, which plain
 *    objects never have.
 * 2. **The redacted representation.** `logInternal` runs every argument through
 *    `redactSensitiveLogValue` before pino sees it, which copies an Error's
 *    non-enumerable `message`/`stack` onto a *plain object*. That object is what
 *    actually arrives here from every call site, so an `instanceof` gate would
 *    skip pino's std handling entirely and drop `type` plus the flattened cause
 *    text from `message`/`stack`.
 *
 * Still narrower than pino's own `isErrorLike` (`typeof value.message === 'string'`):
 * requiring a string `stack` as well keeps structured failures that merely carry
 * a message — JSON-RPC rejections such as `{ code: -32000, message: '...' }`,
 * ordinary log payloads here — reaching the transport byte-identical rather than
 * wearing a synthetic empty `stack` and a self-referential `raw`.
 */
function carriesErrorDiagnostics(value: unknown): boolean {
  if (value instanceof Error || Object.prototype.toString.call(value) === '[object Error]') {
    return true;
  }
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { message?: unknown; stack?: unknown };
  return typeof candidate.message === 'string' && typeof candidate.stack === 'string';
}

/**
 * Rebuild a non-extensible value as an extensible, descriptor-faithful copy.
 *
 * `pino.stdSerializers.err` tags its input with a `Symbol(circular-ref-tag)`
 * before walking it, which throws a `TypeError` on a frozen input. Copying every
 * own property *descriptor* (rather than assigning enumerable values) preserves
 * non-enumerable own data such as `AggregateError.errors`, which drives pino's
 * `aggregateErrors` output, and keeps `message`/`stack`/`cause` in their original
 * enumerability so the copy serializes identically to the original.
 *
 * `Object.create` always yields an extensible object, regardless of the source.
 * Note that pino sets its non-enumerable `raw` to this copy rather than to the
 * caller's object; `raw` is not JSON-serialized, so this only affects transports
 * that read it directly (for example `pino-pretty`'s `errorProps`).
 */
function toExtensibleCopy<T extends object>(value: T): T {
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
    PropertyKey,
    PropertyDescriptor
  >;

  // V8 exposes `stack` as an own *accessor* whose getter formats internal state
  // the copy does not carry, so copying that descriptor verbatim reads back as
  // empty. Replace the diagnostic trio with plain data read through the original,
  // preserving each property's original enumerability. This must happen in the
  // descriptor map rather than after the fact: a frozen source yields
  // `configurable: false`, which would make a later `defineProperty` throw.
  for (const key of ['message', 'stack', 'cause']) {
    const read = (value as Record<string, unknown>)[key];
    if (read === undefined) {
      continue;
    }
    descriptors[key] = {
      configurable: true,
      enumerable: descriptors[key]?.enumerable ?? false,
      value: read,
      writable: true,
    };
  }

  return Object.defineProperties(
    Object.create(Object.getPrototypeOf(value) as object | null),
    descriptors
  ) as T;
}

/**
 * Serializer for the `err` and `error` binding keys.
 *
 * `Error.prototype.message` and `.stack` are non-enumerable, so an Error that
 * reaches JSON serialization unserialized collapses to its own enumerable
 * properties alone — the loudest failures log as the quietest lines.
 */
function serializeErrorBinding(value: unknown): unknown {
  if (!carriesErrorDiagnostics(value)) {
    return value;
  }
  const target = value as object;
  return pino.stdSerializers.err(
    (Object.isExtensible(target) ? target : toExtensibleCopy(target)) as Error
  );
}

export const logSerializers: NonNullable<LoggerOptions['serializers']> = {
  // Redact sensitive fields
  apiKey: () => '[REDACTED]',
  authorization: () => '[REDACTED]',
  cookie: () => '[REDACTED]',
  err: serializeErrorBinding,
  error: serializeErrorBinding,
  password: () => '[REDACTED]',
  req: pino.stdSerializers.req,
  res: pino.stdSerializers.res,
  secret: () => '[REDACTED]',
  token: () => '[REDACTED]',
};
