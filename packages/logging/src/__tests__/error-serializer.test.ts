import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { __loggerTesting, redactSensitiveLogValue } from '../logger.js';

/**
 * These tests exercise the production serializer map through a *real* pino
 * instance writing to a capture stream. A mock would not reproduce the bug
 * this pins: `Error.prototype.message` and `.stack` are non-enumerable, so the
 * loss only happens during genuine JSON serialization.
 */
function captureLogRecord(bindings: Record<string, unknown>): Record<string, unknown> {
  const lines: string[] = [];
  const logger = pino(
    {
      base: null,
      level: 'trace',
      serializers: __loggerTesting.serializers,
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
});
