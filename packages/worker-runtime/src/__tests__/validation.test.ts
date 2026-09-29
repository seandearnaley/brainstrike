import { describe, expect, it } from 'vitest';
import {
  assertRuntimeObjectPayloadEnvelope,
  assertRuntimeRequestPayloadBase,
} from '../validation.js';

function expectPlainError(run: () => unknown, message: string): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(Object.getPrototypeOf(caught)).toBe(Error.prototype);
  expect((caught as Error).message).toBe(message);
}

describe('runtime envelope validation compatibility', () => {
  const context = 'Runtime envelope';
  const valid = {
    channel: 'channel',
    extra: true,
    payload: { detail: 1 },
    requestId: ' request ',
    runtimeId: ' runtime ',
    type: 'request',
  };

  it.each(['cancel', 'error', 'progress', 'request', 'result', 'status'] as const)(
    'accepts the %s envelope type',
    (type) => {
      const candidate = { ...valid, type };
      const result = assertRuntimeObjectPayloadEnvelope(candidate, context);
      expect(result.candidate).toBe(candidate);
      expect(result.payload).toBe(candidate.payload);
      expect(result.envelopeBase).toEqual({
        channel: 'channel',
        requestId: ' request ',
        runtimeId: ' runtime ',
        type,
      });
    }
  );

  it('accepts an array root with valid own fields and returns the same object', () => {
    const candidate = Object.assign([], valid);
    const result = assertRuntimeObjectPayloadEnvelope(candidate, context);
    expect(result.candidate).toBe(candidate);
    expect(result.payload).toBe(valid.payload);
  });

  it.each([
    [null, 'must be an object.'],
    [0, 'must be an object.'],
    ['request', 'must be an object.'],
    [{ ...valid, requestId: '', type: 'other' }, 'must include a valid runtime envelope type.'],
    [{ ...valid, requestId: 1 }, 'must include a non-empty requestId.'],
    [{ ...valid, requestId: '', runtimeId: '' }, 'must include a non-empty requestId.'],
    [{ ...valid, runtimeId: null }, 'must include a non-empty runtimeId.'],
    [{ ...valid, channel: '', runtimeId: ' \t ' }, 'must include a non-empty runtimeId.'],
    [{ ...valid, channel: undefined }, 'must include a non-empty channel.'],
    [{ ...valid, channel: '', payload: [] }, 'must include a non-empty channel.'],
    [{ ...valid, payload: [] }, 'must include a payload object.'],
    [{ ...valid, payload: null }, 'must include a payload object.'],
    [{ ...valid, payload: 'text' }, 'must include a payload object.'],
    [{ ...valid, payload: new Date(0) }, null],
  ] as const)('preserves the error and check order for %#', (candidate, suffix) => {
    if (suffix === null) {
      expect(assertRuntimeObjectPayloadEnvelope(candidate, context).payload).toBe(
        candidate.payload
      );
      return;
    }
    expectPlainError(
      () => assertRuntimeObjectPayloadEnvelope(candidate, context),
      `${context} ${suffix}`
    );
  });

  it.each(['\u00a0', '\ufeff'])('rejects a JS-trim whitespace-only requestId %#', (requestId) => {
    expectPlainError(
      () => assertRuntimeObjectPayloadEnvelope({ ...valid, requestId }, context),
      `${context} must include a non-empty requestId.`
    );
  });

  it('preserves array-root failure precedence', () => {
    expect(() => assertRuntimeObjectPayloadEnvelope([], context)).toThrow(
      `${context} must include a valid runtime envelope type.`
    );
  });
});

describe('runtime request base validation compatibility', () => {
  const context = 'Chunk request';
  const expectedKind = 'chunk-file';
  const valid = { extra: { content: 'x' }, kind: expectedKind, requestId: ' request ' };

  it('preserves the original candidate, fields, and whitespace', () => {
    const result = assertRuntimeRequestPayloadBase(valid, context, expectedKind);
    expect(result.candidate).toBe(valid);
    expect(result.requestBase).toEqual({ kind: expectedKind, requestId: ' request ' });
  });

  it('accepts an array root with valid own fields', () => {
    const candidate = Object.assign([], valid);
    expect(assertRuntimeRequestPayloadBase(candidate, context, expectedKind).candidate).toBe(
      candidate
    );
  });

  it.each([
    [null, 'must be an object.'],
    [false, 'must be an object.'],
    [{ kind: 'other', requestId: '' }, 'must declare kind="chunk-file".'],
    [{ kind: expectedKind, requestId: 1 }, 'must include a non-empty requestId.'],
    [{ kind: expectedKind, requestId: ' \t ' }, 'must include a non-empty requestId.'],
  ] as const)('preserves the error and check order for %#', (candidate, suffix) => {
    expectPlainError(
      () => assertRuntimeRequestPayloadBase(candidate, context, expectedKind),
      `${context} ${suffix}`
    );
  });

  it('checks dynamic kinds exactly', () => {
    expect(
      assertRuntimeRequestPayloadBase({ kind: 'custom', requestId: 'id' }, context, 'custom')
        .requestBase.kind
    ).toBe('custom');
    expect(() => assertRuntimeRequestPayloadBase(valid, context, 'other')).toThrow(
      `${context} must declare kind="other".`
    );
  });
});
