import { Schema } from 'effect';
import { expect, test } from 'vitest';
import { omitUndefinedOptional, strictWireSchema } from '../schema-boundary.js';

test('nested strict wire data stays strict within a stripping projection', () => {
  const schema = Schema.Struct({
    prompts: strictWireSchema(Schema.Struct({ query: Schema.String })),
  });
  expect(Schema.decodeUnknownSync(schema)({ extra: true, prompts: { query: 'find' } })).toEqual({
    prompts: { query: 'find' },
  });
  expect(() =>
    Schema.decodeUnknownSync(schema)({ prompts: { extra: true, query: 'find' } })
  ).toThrow();
});

test('only explicitly normalized optionals omit an own undefined value', () => {
  const schema = Schema.Struct({
    normalized: omitUndefinedOptional(Schema.String),
    ordinary: Schema.optional(Schema.String),
  });
  expect(Schema.decodeUnknownSync(schema)({ normalized: undefined, ordinary: undefined })).toEqual({
    ordinary: undefined,
  });
  expect(Schema.decodeUnknownSync(schema)({})).toEqual({});
  expect(() => Schema.decodeUnknownSync(schema)({ normalized: null })).toThrow();
});
