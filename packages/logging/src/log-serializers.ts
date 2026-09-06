import type { LoggerOptions } from 'pino';
import pino from 'pino';

/**
 * Is this a genuine Error *object* — one whose `message`/`stack` live in
 * non-enumerable slots and would be lost by an ordinary enumerable walk?
 *
 * Wider than `instanceof Error`, which is realm-bound: an Error from a
 * `node:vm` context, a worker, or a dual-loaded class hierarchy fails it. The
 * `[object Error]` tag is the only cross-realm brand check available in a
 * browser-safe package (`node:util`'s `isNativeError` is Node-only).
 *
 * Two properties of that tag are worth stating plainly, because both are easy
 * to get wrong:
 *
 * 1. **It is forgeable.** `{ [Symbol.toStringTag]: 'Error' }` also reports
 *    `[object Error]`. The cost of a forgery is only that empty
 *    `message`/`name`/`stack` keys appear on the redacted object — no data is
 *    lost and nothing sensitive is exposed — so it is an acceptable price for
 *    cross-realm support.
 * 2. **Reading it runs user code.** `Object.prototype.toString` performs
 *    `Get(O, @@toStringTag)`, so a throwing getter (or a Proxy that rejects the
 *    read) would throw from here. That is intolerable: this predicate runs
 *    inside `redactSensitiveLogValue`, on every logged argument, *outside* the
 *    try/catch in `logInternal` — so an exception would escape the logging call
 *    and mask the failure being reported. Hence the guard below.
 *
 * Shared with `redactSensitiveLogValue`, which sits *earlier* in the pipeline
 * and must answer this same question identically. If the redactor declines a
 * value the serializer would have accepted, the diagnostics are already gone
 * by the time the serializer runs and cannot be recovered (BST-1662).
 */
export function isErrorObject(value: unknown): value is Error {
  if (value instanceof Error) {
    return true;
  }
  try {
    return Object.prototype.toString.call(value) === '[object Error]';
  } catch {
    // A value that sabotages its own introspection is not an Error we can read
    // anything from. Treating it as a plain object costs nothing — the ordinary
    // enumerable walk still redacts and logs it — whereas rethrowing here would
    // take down the log call that was reporting the real problem.
    return false;
  }
}

/**
 * Does this value carry an Error's diagnostic payload?
 *
 * The serializer's gate is deliberately wider than `isErrorObject`, because it
 * runs *after* `redactSensitiveLogValue` has flattened Errors: `logInternal`
 * hands pino a plain object carrying the Error's `message`/`stack` copied out
 * of their non-enumerable slots. That flattened object is what actually arrives
 * here from every call site, so gating on the Error-object test alone would
 * skip pino's std handling and drop `type` plus the flattened cause text.
 *
 * The redactor must NOT use this wider test. It runs before flattening, where a
 * plain object's `message`/`stack` are already enumerable and copied by the
 * ordinary walk; accepting them there would only bolt on a spurious `name`.
 *
 * Still narrower than pino's own `isErrorLike` (`typeof value.message === 'string'`):
 * requiring a string `stack` as well keeps structured failures that merely carry
 * a message — JSON-RPC rejections such as `{ code: -32000, message: '...' }`,
 * ordinary log payloads here — reaching the transport byte-identical rather than
 * wearing a synthetic empty `stack` and a self-referential `raw`.
 */
function carriesErrorDiagnostics(value: unknown): boolean {
  if (isErrorObject(value)) {
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
