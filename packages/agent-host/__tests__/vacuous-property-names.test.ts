import { toStandardSchema } from '@mastra/core/schema';
import { asSchema, generateText, type JSONSchema7 } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { expect, test } from 'vitest';
import type { HostTool } from '../src/ports.js';
import { createHostSdkTools } from '../src/sdk-tools.js';

// What an MCP server built on Zod 4 advertises for `z.record(z.string(), …)`:
// a `propertyNames` that every JSON object key already satisfies. OpenAI strips
// it and reports a compatibility warning on every request that carries it.
const advertised: JSONSchema7 = {
  $defs: {
    headers: { additionalProperties: { type: 'string' }, propertyNames: {}, type: 'object' },
  },
  properties: {
    env: {
      additionalProperties: { type: 'string' },
      propertyNames: { type: 'string' },
      type: 'object',
    },
    labels: {
      anyOf: [
        { additionalProperties: true, propertyNames: true, type: 'object' },
        { type: 'null' },
      ],
    },
    // A constraint the provider cannot enforce stays, so its warning stays honest.
    limits: {
      additionalProperties: { type: 'number' },
      propertyNames: { pattern: '^[a-z]+$', type: 'string' },
      type: 'object',
    },
    // A property that happens to be named after the keyword is data, not the keyword.
    propertyNames: { type: 'string' },
    request: { $ref: '#/$defs/headers' },
  },
  required: ['env'],
  type: 'object',
};

const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};

async function providerToolSchema(tool: HostTool): Promise<unknown> {
  let sent: unknown;
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      sent = options.tools?.[0];
      return {
        content: [{ text: 'ok', type: 'text' }],
        finishReason: { raw: 'stop', unified: 'stop' },
        usage,
        warnings: [],
      };
    },
  });
  await generateText({
    model,
    prompt: 'hi',
    tools: createHostSdkTools({
      admittedInput: () => undefined,
      execute: () => Promise.reject(new Error('This proof runs no tool')),
      modelOutput: () => ({ type: 'text', value: '' }),
      tools: { mcp_tool: tool },
    }),
  });
  return sent;
}

function mcpTool(): HostTool {
  return {
    description: 'An MCP tool',
    execute: () => Promise.reject(new Error('This proof runs no tool')),
    identity: 'mcp-tool',
    inputSchema: toStandardSchema(structuredClone(advertised)),
    risk: 'read',
    strict: false,
  };
}

test('the provider receives no propertyNames that cannot reject a key, and keeps every other constraint', async () => {
  const sent = await providerToolSchema(mcpTool());
  const { $defs, properties } = advertised;

  expect(sent).toMatchObject({
    inputSchema: {
      $defs: { headers: { additionalProperties: { type: 'string' }, type: 'object' } },
      properties: {
        env: { additionalProperties: { type: 'string' }, type: 'object' },
        labels: { anyOf: [{ additionalProperties: true, type: 'object' }, { type: 'null' }] },
        limits: properties?.['limits'],
        propertyNames: properties?.['propertyNames'],
        request: properties?.['request'],
      },
      required: ['env'],
      type: 'object',
    },
    name: 'mcp_tool',
    type: 'function',
  });
  // toMatchObject ignores extra keys, so prove the vacuous ones are really gone.
  const sentSchema = (sent as { inputSchema: JSONSchema7 }).inputSchema;
  expect(sentSchema.$defs?.['headers']).not.toHaveProperty('propertyNames');
  expect(sentSchema.properties?.['env']).not.toHaveProperty('propertyNames');
  expect(sentSchema.properties?.['labels']).toEqual({
    anyOf: [{ additionalProperties: true, type: 'object' }, { type: 'null' }],
  });
  expect($defs?.['headers']).toHaveProperty('propertyNames', {});
});

test('the tool still validates input against the server’s own schema', async () => {
  const tools = createHostSdkTools({
    admittedInput: () => undefined,
    execute: () => Promise.reject(new Error('This proof runs no tool')),
    modelOutput: () => ({ type: 'text', value: '' }),
    tools: { mcp_tool: mcpTool() },
  });
  const schema = asSchema(tools['mcp_tool']?.inputSchema);

  expect(await schema.validate?.({ env: { HOME: '/tmp' } })).toMatchObject({ success: true });
  expect(await schema.validate?.({ env: { HOME: 1 } })).toMatchObject({ success: false });
  // The provider never sees this key constraint, but the host still enforces it.
  expect(await schema.validate?.({ env: {}, limits: { Upper: 1 } })).toMatchObject({
    success: false,
  });
});
