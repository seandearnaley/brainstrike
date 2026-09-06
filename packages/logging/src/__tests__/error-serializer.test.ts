import { runInNewContext } from 'node:vm';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import * as loggerModule from '../logger.js';
import {
  __loggerTesting,
  addLogListener,
  createLogger,
  type LogRecord,
  redactSensitiveLogValue,
} from '../logger.js';

/**
 * These tests exercise the production serializer map through a *real* pino
 * instance writing to a capture stream. A mock would not reproduce the bug
 * this pins: `Error.prototype.message` and `.stack` are non-enumerable, so the
 * loss only happens during genuine JSON serialization.
 */
type PinoSerializers = NonNullable<NonNullable<Parameters<typeof pino>[0]>['serializers']>;

function captureWith(
  serializers: PinoSerializers,
  bindings: Record<string, unknown>
): Record<string, unknown> {
  const lines: string[] = [];
  const logger = pino(
    {
      base: null,
      level: 'trace',
      serializers,
      timestamp: false,
    },
    {
      write(chunk: string) {
        lines.push(chunk);
      },
    }
  );

  logger.error(bindings, 'boom happened');

  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] as string) as Record<string, unknown>;
}

function captureLogRecord(bindings: Record<string, unknown>): Record<string, unknown> {
  return captureWith(__loggerTesting.serializers, bindings);
}

describe('the `error` binding key', () => {
  it('keeps the message and stack of a real Error', () => {
    const record = captureLogRecord({ error: new Error('relation "x" does not exist') });
    const serialized = record['error'] as Record<string, unknown>;

    expect(serialized['message']).toBe('relation "x" does not exist');
    expect(serialized['stack']).toEqual(
      expect.stringContaining('Error: relation "x" does not exist')
    );
    expect(serialized['type']).toBe('Error');
  });

  it('keeps own enumerable properties alongside the message and stack', () => {
    const sqlError = Object.assign(new Error('relation "x" does not exist'), { code: '42P01' });
    const serialized = captureLogRecord({ error: sqlError })['error'] as Record<string, unknown>;

    expect(serialized['code']).toBe('42P01');
    expect(serialized['message']).toBe('relation "x" does not exist');
  });

  it('serializes an Error under `error` the same way as under `err`', () => {
    const asError = captureLogRecord({ error: new Error('same shape') })['error'];
    const asErr = captureLogRecord({ err: new Error('same shape') })['err'];

    expect(Object.keys(asError as object).sort()).toEqual(Object.keys(asErr as object).sort());
  });

  it('walks an Error cause chain into the message', () => {
    const wrapped = new Error('outer', { cause: new Error('root cause') });
    const serialized = captureLogRecord({ error: wrapped })['error'] as Record<string, unknown>;

    expect(serialized['message']).toEqual(expect.stringContaining('root cause'));
  });
});

describe('the `error` binding key with non-Error values', () => {
  it('passes a string through unchanged', () => {
    expect(captureLogRecord({ error: 'some string' })['error']).toBe('some string');
  });

  it('passes a plain object through unchanged', () => {
    expect(captureLogRecord({ error: { code: 'X' } })['error']).toEqual({ code: 'X' });
  });

  it('does not decorate a JSON-RPC error object that happens to carry a message', () => {
    // pino's own `isErrorLike` is `typeof value.message === 'string'`, so the
    // bare std serializer would bolt `type`/`stack`/`raw` onto this shape.
    const jsonRpcError = { code: -32_000, message: 'MCP Apps request timed out' };
    const serialized = captureLogRecord({ error: jsonRpcError })['error'];

    expect(serialized).toEqual({ code: -32_000, message: 'MCP Apps request timed out' });
  });

  it('does not throw on a frozen error-like object', () => {
    // The std serializer tags its input with a symbol before walking it, which
    // throws on a non-extensible object. See mcp-app-host/src/frame-bridge.ts.
    const frozen = Object.freeze({ code: -32_000, message: 'MCP Apps request timed out' });

    expect(() => captureLogRecord({ error: frozen })).not.toThrow();
  });

  it('passes null and numbers through unchanged', () => {
    expect(captureLogRecord({ error: null })['error']).toBeNull();
    expect(captureLogRecord({ error: 42 })['error']).toBe(42);
  });
});

describe('the `err` binding key', () => {
  it('still serializes a real Error', () => {
    const serialized = captureLogRecord({ err: new Error('boom') })['err'] as Record<
      string,
      unknown
    >;

    expect(serialized['message']).toBe('boom');
    expect(serialized['stack']).toEqual(expect.stringContaining('Error: boom'));
  });
});

/**
 * `logInternal` runs every argument through `redactSensitiveLogValue` *before*
 * handing it to pino, so an Error reaches the transport already flattened into
 * enumerable `message`/`name`/`stack`. These tests reproduce that exact two-step
 * pipeline. They pin the property that actually matters at the call sites: a
 * logged Error must never reach a transport stripped of its message and stack.
 *
 * This is the guard that would fail if the Error branch of
 * `redactSensitiveLogValue` were ever dropped — at which point the non-enumerable
 * `message`/`stack` would vanish and the loudest failures would log as the
 * quietest lines.
 */
function captureThroughProductionPipeline(
  bindings: Record<string, unknown>
): Record<string, unknown> {
  return captureLogRecord(redactSensitiveLogValue(bindings) as Record<string, unknown>);
}

describe('the redact-then-serialize pipeline used by every call site', () => {
  it('keeps the message and stack of an Error logged under `error`', () => {
    const sqlError = Object.assign(new Error('relation "x" does not exist'), { code: '42P01' });
    const serialized = captureThroughProductionPipeline({ error: sqlError })['error'] as Record<
      string,
      unknown
    >;

    expect(serialized['message']).toBe('relation "x" does not exist');
    expect(serialized['stack']).toEqual(
      expect.stringContaining('Error: relation "x" does not exist')
    );
    expect(serialized['code']).toBe('42P01');
  });

  it('keeps the message and stack of an Error logged under `err`', () => {
    const serialized = captureThroughProductionPipeline({ err: new Error('boom') })[
      'err'
    ] as Record<string, unknown>;

    expect(serialized['message']).toBe('boom');
    expect(serialized['stack']).toEqual(expect.stringContaining('Error: boom'));
  });

  it('leaves a JSON-RPC style failure untouched', () => {
    const serialized = captureThroughProductionPipeline({
      error: { code: -32_000, message: 'MCP Apps request timed out' },
    })['error'];

    expect(serialized).toEqual({ code: -32_000, message: 'MCP Apps request timed out' });
  });

  it('redacts a sensitive property hanging off a logged Error', () => {
    const authError = Object.assign(new Error('unauthorized'), { token: 'super-secret' });
    const serialized = captureThroughProductionPipeline({ error: authError })['error'] as Record<
      string,
      unknown
    >;

    expect(serialized['token']).toBe('[REDACTED]');
    expect(serialized['message']).toBe('unauthorized');
  });

  /**
   * Regression guard. `redactSensitiveLogValue` hands pino a *plain object*
   * carrying the Error's message and stack, so the serializer only reaches
   * pino's std error handling if its gate accepts that redacted shape. Gating
   * on `instanceof Error` alone silently skipped it, which dropped `type` and
   * — the real loss — flattened cause text out of `message`/`stack`.
   */
  it('keeps pino error shape and flattened cause text for `err`', () => {
    const wrapped = new Error('outer', { cause: new Error('root cause') });
    const serialized = captureThroughProductionPipeline({ err: wrapped })['err'] as Record<
      string,
      unknown
    >;

    expect(serialized['type']).toBe('Object');
    expect(serialized['message']).toBe('outer: root cause');
    expect(serialized['stack']).toEqual(expect.stringContaining('caused by:'));
  });

  it('keeps pino error shape and flattened cause text for `error`', () => {
    const wrapped = new Error('outer', { cause: new Error('root cause') });
    const serialized = captureThroughProductionPipeline({ error: wrapped })['error'] as Record<
      string,
      unknown
    >;

    expect(serialized['type']).toBe('Object');
    expect(serialized['message']).toBe('outer: root cause');
  });
});

describe('no regression against the transport schema `err` had before', () => {
  /**
   * `err` was previously bound to bare `pino.stdSerializers.err`. For anything
   * error-shaped the output must stay byte-identical, or the established
   * transport schema breaks for existing `{ err }` call sites. Non-error
   * payloads are where the two deliberately diverge, so they are excluded.
   */
  it.each([
    ['plain Error', new Error('boom')],
    ['Error with cause', new Error('outer', { cause: new Error('root cause') })],
    ['Error with own props', Object.assign(new Error('sql'), { code: '42P01' })],
  ])('matches bare pino.stdSerializers.err for %s', (_label, input) => {
    const redacted = redactSensitiveLogValue({ err: input }) as Record<string, unknown>;

    const baseline = captureWith({ err: pino.stdSerializers.err }, redacted)['err'];
    const current = captureLogRecord(redacted)['err'];

    expect(current).toEqual(baseline);
  });
});

describe('error values the `instanceof Error` gate alone would miss', () => {
  it('serializes a genuine cross-realm Error', () => {
    const crossRealm = runInNewContext('new Error("cross realm boom")') as Error;
    // Precondition: this is what makes the test meaningful.
    expect(crossRealm instanceof Error).toBe(false);

    const serialized = captureLogRecord({ error: crossRealm })['error'] as Record<string, unknown>;

    expect(serialized['message']).toBe('cross realm boom');
    expect(serialized['stack']).toEqual(expect.stringContaining('Error: cross realm boom'));
  });

  it('serializes a frozen Error without losing message, stack or own properties', () => {
    const frozen = Object.freeze(Object.assign(new Error('frozen boom'), { code: '42P01' }));
    const serialized = captureLogRecord({ error: frozen })['error'] as Record<string, unknown>;

    expect(serialized['message']).toBe('frozen boom');
    expect(serialized['stack']).toEqual(expect.stringContaining('Error: frozen boom'));
    expect(serialized['code']).toBe('42P01');
  });

  it('does not mutate the Error it serializes', () => {
    const frozen = Object.freeze(new Error('untouched'));
    captureLogRecord({ error: frozen });

    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.getOwnPropertySymbols(frozen)).toHaveLength(0);
  });

  it('preserves own non-enumerable data when copying a frozen Error', () => {
    // `AggregateError.errors` is own-non-enumerable and drives pino's
    // `aggregateErrors` output, so an enumerable-only copy would drop it.
    const aggregate = Object.freeze(
      new AggregateError([new Error('first'), new Error('second')], 'both failed')
    );
    const serialized = captureLogRecord({ error: aggregate })['error'] as Record<string, unknown>;

    expect(serialized['message']).toBe('both failed');
    expect(serialized['aggregateErrors']).toHaveLength(2);
  });
});

/**
 * BST-1662. The serializer and the redactor each decide "is this an Error?",
 * and `logInternal` runs the redactor *first*. The redactor is therefore the
 * gate that decides whether an Error's diagnostics survive at all: it copies
 * `message`/`name`/`stack` out of their non-enumerable slots onto a plain
 * object. If it declines, those fields are already gone by the time the
 * (wider) serializer gate sees the value, so the serializer cannot recover
 * them. The two gates must agree about what counts as an Error object.
 */
describe('the redactor and the serializer agree about what an Error is', () => {
  function logThroughPublicApi(bindings: Record<string, unknown>): Record<string, unknown> {
    const records: LogRecord[] = [];
    const unsubscribe = addLogListener((record) => {
      records.push(record);
    });
    try {
      createLogger('Bst1662').error('failed', bindings);
    } finally {
      unsubscribe();
    }
    expect(records).toHaveLength(1);
    // `addLogListener` receives exactly the redacted arguments `logInternal`
    // hands to pino, so this is the real public path, not a reconstruction.
    return records[0]?.args.at(-1) as Record<string, unknown>;
  }

  it('keeps a cross-realm Error intact through redaction', () => {
    const crossRealm = runInNewContext('new Error("cross realm boom")') as Error;
    expect(crossRealm instanceof Error).toBe(false);

    const redacted = redactSensitiveLogValue(crossRealm) as Record<string, unknown>;

    expect(redacted['message']).toBe('cross realm boom');
    expect(redacted['stack']).toEqual(expect.stringContaining('Error: cross realm boom'));
  });

  it('keeps a cross-realm Error intact through the full public logging path', () => {
    const crossRealm = runInNewContext('new Error("cross realm via api")') as Error;

    const logged = logThroughPublicApi({ error: crossRealm })['error'] as Record<string, unknown>;

    expect(logged['message']).toBe('cross realm via api');
    expect(logged['stack']).toEqual(expect.stringContaining('Error: cross realm via api'));
  });

  it('still redacts sensitive properties on a cross-realm Error', () => {
    const crossRealm = runInNewContext(
      'Object.assign(new Error("cross realm auth"), { token: "super-secret" })'
    ) as Error;

    const redacted = redactSensitiveLogValue(crossRealm) as Record<string, unknown>;

    expect(redacted['token']).toBe('[REDACTED]');
    expect(redacted['message']).toBe('cross realm auth');
  });

  it('walks the cause chain of a cross-realm Error', () => {
    const crossRealm = runInNewContext(
      'new Error("outer", { cause: new Error("root cause") })'
    ) as Error;

    const redacted = redactSensitiveLogValue(crossRealm) as Record<string, unknown>;
    const cause = redacted['cause'] as Record<string, unknown>;

    expect(cause['message']).toBe('root cause');
  });

  it('does not decorate a plain object that merely looks error-shaped', () => {
    // The redactor sits *before* flattening, so it must stay narrower than the
    // serializer: a plain object's message/stack are already enumerable and the
    // ordinary walk copies them. Widening here would bolt on a `name` key.
    const shaped = { message: 'looks like one', stack: 'not really' };

    const redacted = redactSensitiveLogValue(shaped) as Record<string, unknown>;

    expect(redacted).toEqual(shaped);
    expect(Object.hasOwn(redacted, 'name')).toBe(false);
  });
});

/**
 * BST-1663. `pino.stdSerializers.err` hoists an error's own enumerable
 * properties into the record, but the `token`/`secret`/`password`/`apiKey`
 * serializers are keyed at the **top level** only — a sensitive property
 * hanging off an Error lands at `error.token`, which they never match.
 *
 * The only thing that redacts it is `redactSensitiveLogValue`, which
 * `logInternal` runs on every argument. So the boundary is: **`logInternal` is
 * the only redaction-safe entry point.** These tests make that boundary
 * explicit and enforced rather than merely documented — the ruling on BST-1663
 * is to keep one redaction implementation plus a guarded seam, not to add a
 * second redaction pass inside the serializer that could drift from the first.
 */
describe('the redaction boundary around direct pino access', () => {
  function looksLikePinoLogger(value: unknown): boolean {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const candidate = value as Record<string, unknown>;
    return typeof candidate['child'] === 'function' && candidate['levels'] !== undefined;
  }

  it('detects a real pino logger, so an empty leak list means something', () => {
    // Without this, `leaked === []` below could just mean the detector is broken.
    expect(looksLikePinoLogger(pino())).toBe(true);
    expect(looksLikePinoLogger({ error: () => undefined })).toBe(false);
  });

  it('exposes no raw pino logger anywhere on the public surface', () => {
    const leaked = Object.entries(loggerModule)
      .filter(([, exported]) => looksLikePinoLogger(exported))
      .map(([name]) => name);

    expect(leaked).toEqual([]);
  });

  it('hands callers a wrapper that routes through logInternal, not a pino logger', () => {
    const scoped = createLogger('Bst1663');

    expect(Object.keys(scoped).sort()).toEqual([
      'debug',
      'error',
      'fatal',
      'info',
      'trace',
      'warn',
    ]);
    expect(looksLikePinoLogger(scoped)).toBe(false);
  });

  it('redacts a sensitive error property through the supported entry point', () => {
    const authError = Object.assign(new Error('unauthorized'), { token: 'super-secret' });
    const serialized = captureThroughProductionPipeline({ error: authError })['error'] as Record<
      string,
      unknown
    >;

    expect(serialized['token']).toBe('[REDACTED]');
  });

  it('does NOT redact when the serializer is driven without logInternal', () => {
    // Characterization of the documented hazard, not an endorsement: this is
    // why `logInternal` is the only supported entry point. If a future change
    // makes direct-to-pino logging redaction-safe, this test should flip and
    // the contract note should be updated with it.
    const authError = Object.assign(new Error('unauthorized'), { token: 'super-secret' });
    const serialized = captureLogRecord({ error: authError })['error'] as Record<string, unknown>;

    expect(serialized['token']).toBe('super-secret');
  });
});
