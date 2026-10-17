import { Result, Schema } from 'effect';
import { expect, test } from 'vitest';
import { opaqueWireSchema, wireDecoder, wireResultDecoder } from '../schema-boundary.js';

test('schema refusals remain typed failures with receiving strictness', () => {
  const schema = Schema.Struct({ value: Schema.String });
  const decode = wireResultDecoder(schema, { onExcessProperty: 'error' });
  const parsed = decode({ extra: true, value: 'ok' });
  expect(Result.isFailure(parsed)).toBe(true);
  if (Result.isFailure(parsed)) {
    expect(parsed.failure).toBeInstanceOf(Schema.SchemaError);
  }
  expect(() => wireDecoder(schema)({ value: 0 })).toThrow(Schema.SchemaError);
  expect(decode({ extra: true, value: 'ok' }, { onExcessProperty: 'ignore' })).toEqual(
    Result.succeed({ value: 'ok' })
  );
});

test('an owned decoder returns its actual normalized value', () => {
  const normalized = Object.freeze({ normalized: 'owned' });
  const schema = Schema.Struct({ value: opaqueWireSchema(() => normalized) });
  expect(wireDecoder(schema)({ value: 'raw' }).value).toBe(normalized);
  const result = wireResultDecoder(schema)({ value: 'raw' });
  expect(Result.isSuccess(result)).toBe(true);
  if (Result.isSuccess(result)) {
    expect(result.success.value).toBe(normalized);
  }
});

test('domain failure identity and code survive both receiving adapters', () => {
  const failure = Object.assign(new Error('owned refusal'), { code: 'owned.refused' });
  const schema = Schema.Struct({
    value: opaqueWireSchema(() => {
      throw failure;
    }),
  });
  for (const decode of [wireDecoder(schema), wireResultDecoder(schema)]) {
    expect(() => decode({ value: 'raw' })).toThrow(failure);
    try {
      decode({ value: 'raw' });
    } catch (actual) {
      expect(actual).toBe(failure);
    }
  }
});

test('a schema error thrown by an owned decoder remains a defect, not a typed refusal', () => {
  const refused = Schema.decodeUnknownResult(Schema.String)(0);
  expect(Result.isFailure(refused)).toBe(true);
  if (!Result.isFailure(refused)) {
    throw new Error('Fixture must produce a schema error');
  }
  const schema = opaqueWireSchema(() => {
    throw refused.failure;
  });
  for (const decode of [wireDecoder(schema), wireResultDecoder(schema)]) {
    try {
      decode('raw');
      throw new Error('The owned failure must escape');
    } catch (actual) {
      expect(actual).toBe(refused.failure);
    }
  }
});
