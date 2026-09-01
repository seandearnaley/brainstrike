import { expect } from 'vitest';

export function expectReferenceToolContract(tools: readonly unknown[]): void {
  expect(tools).toEqual([
    {
      description: 'Echo a string through the official MCP TypeScript SDK v2 server.',
      inputSchema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        additionalProperties: false,
        properties: { text: { type: 'string' } },
        required: ['text'],
        type: 'object',
      },
      name: 'echo',
      outputSchema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        additionalProperties: false,
        properties: { text: { type: 'string' } },
        required: ['text'],
        type: 'object',
      },
    },
  ]);
}
