import { expect } from 'vitest';

const TEXT_OBJECT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  additionalProperties: false,
  properties: { text: { type: 'string' } },
  required: ['text'],
  type: 'object',
} as const;

const ECHO_TOOL = {
  description: 'Echo a string through the official MCP TypeScript SDK v2 server.',
  inputSchema: TEXT_OBJECT_SCHEMA,
  name: 'echo',
  outputSchema: TEXT_OBJECT_SCHEMA,
} as const;

const ELICIT_CONFIRM_TOOL = {
  description:
    'Ask the connected client to confirm a string through MCP form elicitation before echoing it.',
  inputSchema: TEXT_OBJECT_SCHEMA,
  name: 'elicit_confirm',
  outputSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    additionalProperties: false,
    properties: { confirmed: { type: 'boolean' }, text: { type: 'string' } },
    required: ['confirmed', 'text'],
    type: 'object',
  },
} as const;

/**
 * The HTTP echo fixture (`src/reference-server.ts`) also exposes `elicit_confirm`
 * (BST-1584); the spawned stdio fixture (`fixtures/stdio-reference-server.mjs`)
 * stays echo-only so its fault verifiers keep an exact single-tool contract.
 */
export function expectReferenceToolContract(
  tools: readonly unknown[],
  fixture: 'http' | 'stdio' = 'http'
): void {
  expect(tools).toEqual(fixture === 'stdio' ? [ECHO_TOOL] : [ECHO_TOOL, ELICIT_CONFIRM_TOOL]);
}
