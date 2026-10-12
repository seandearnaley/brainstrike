import { toStandardSchema } from '@mastra/core/schema';
import { asSchema, type JSONSchema7 } from 'ai';
import { expect, test } from 'vitest';
import { executableInputSchema } from '../src/executable-input-schema.js';

// Recorded tools/list shape from the shipped MCP runtime-client fixture.
const advertised: JSONSchema7 = {
  $defs: { identifier: { minLength: 1, type: 'string' } },
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  if: { properties: { mode: { const: 'text' } } },
  properties: {
    id: { $ref: '#/$defs/identifier' },
    mode: { oneOf: [{ const: 'text' }, { const: 'number' }] },
    value: {},
  },
  required: ['id', 'mode'],
  // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditionals use the canonical keyword.
  then: { required: ['value'] },
  type: 'object',
};

test('canonical MCP Standard Schema keeps composition and optional properties unchanged at the SDK boundary', async () => {
  const schema = asSchema(executableInputSchema(toStandardSchema(advertised)));
  expect(await schema.jsonSchema).toEqual(advertised);
  expect(await schema.validate?.({ id: 'x', mode: 'text', value: 'a' })).toEqual({
    success: true,
    value: { id: 'x', mode: 'text', value: 'a' },
  });
  expect(await schema.validate?.({ id: 'x', mode: 'text' })).toMatchObject({ success: false });
  expect(await schema.validate?.({ id: '', mode: 'number' })).toMatchObject({ success: false });
  expect(await schema.validate?.({ id: 'x', mode: 'invalid' })).toMatchObject({ success: false });
});
