import { NATIVE_TOOLS } from '@brainstrike/assistant-contract';
import { toToolInputJsonSchema } from '@brainstrike/assistant-contract/native-tool-schemas';
import { toStandardSchema } from '@mastra/core/schema';
import { asSchema, type JSONSchema7, jsonSchema } from 'ai';
import { expect, test } from 'vitest';
import { approvalRuntimeSchema } from '../src/approval-input.js';
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

test.each(['draft-07', 'draft-2020-12'] as const)(
  '%s tool projection and the executable decoder independently reject nested excess input',
  async (target) => {
    const tool = NATIVE_TOOLS.find((entry) => entry.id === 'brainstrike.manageTaskList');
    if (!tool) {
      throw new Error('The task-list production definition is missing');
    }
    const input = { tasks: [{ activeForm: 'Checking', content: 'Check', status: 'pending' }] };
    const invalid = { tasks: [{ ...input.tasks[0], unexpected: 'must refuse' }] };
    const executable = asSchema(executableInputSchema(tool.inputSchema));
    const advertised = toToolInputJsonSchema(tool.inputSchema, target);
    // The existing MCP/Ajv adapter is an independent implementation of the
    // advertised JSON Schema, rather than another call to the Effect decoder.
    const wire = asSchema(toStandardSchema(advertised));
    expect(await executable.validate?.(input)).toMatchObject({ success: true });
    expect(await wire.validate?.(input)).toMatchObject({ success: true });
    expect(await executable.validate?.(invalid)).toMatchObject({ success: false });
    expect(await wire.validate?.(invalid)).toMatchObject({ success: false });

    // A meaningful negative control: weakening only the wire's nested object
    // must allow this exact malformed input. The normal oracle above catches it.
    const weakened = structuredClone(advertised) as JSONSchema7;
    const tasks = weakened.properties?.['tasks'];
    if (
      !tasks ||
      typeof tasks === 'boolean' ||
      !tasks.items ||
      Array.isArray(tasks.items) ||
      typeof tasks.items === 'boolean'
    ) {
      throw new Error('The task-list wire grammar no longer has its object item');
    }
    tasks.items.additionalProperties = true;
    const mutant = asSchema(toStandardSchema(weakened));
    expect(await mutant.validate?.(invalid)).toMatchObject({ success: true });
  }
);

test('ordinary and resumed SDK schemas refuse a missing executable validator', () => {
  expect(() => approvalRuntimeSchema(jsonSchema({ type: 'object' }), () => undefined)).toThrow(
    'Executable tool has no input validator'
  );
});
