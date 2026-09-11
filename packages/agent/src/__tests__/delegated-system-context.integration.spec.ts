import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import { InMemoryStore } from '@mastra/core/storage';
import { createTool } from '@mastra/core/tools';
import { Memory } from '@mastra/memory';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  hasToolResult,
  scriptedAgentModel,
  textParts,
  toolCallParts,
} from '../test-fixtures/scripted-agent-model';
import type { AgentMessage, StreamChunk } from '../types';

const { modelHolder } = vi.hoisted(() => ({
  modelHolder: { current: undefined as ReturnType<typeof scriptedAgentModel>['model'] | undefined },
}));
vi.mock('../providers/provider-factory', async (original) => ({
  ...(await original<typeof import('../providers/provider-factory')>()),
  createProvider: () => {
    if (!modelHolder.current) {
      throw new Error('Missing scripted model');
    }
    return modelHolder.current;
  },
}));
const { streamMastraAgent } = await import('../mastra/agent-streaming');
const persona: AssistantPersonaDefinition = {
  allowedToolIds: ['brainstrike.grepSearch'],
  description: 'Inspect files.',
  id: 'explore',
  instructions: 'Inspect the delegated request.',
  label: 'Explorer',
  maxSteps: 3,
};
const user: AgentMessage = {
  id: 'user',
  parts: [{ text: 'Inspect the workspace.', type: 'text' }],
  role: 'user',
};
async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}
function runtime(id: string) {
  const storage = new InMemoryStore({ id });
  return {
    memory: new Memory({ options: { generateTitle: false }, storage }),
    runtime: {
      apiKey: 'test-key',
      memory: { resourceId: id, threadId: `${id}-root` },
      provider: 'openai',
    },
    storage,
  };
}
it('rejects oversized trusted child context before child inference while the parent receives its failure', async () => {
  const trustedText = '界'.repeat(23_000);
  expect(Buffer.byteLength(trustedText, 'utf8')).toBeGreaterThan(64 * 1024);
  const execute = vi.fn(async () => ({ matches: [] }));
  let childCalls = 0;
  const receivedErrors: unknown[] = [];
  modelHolder.current = scriptedAgentModel((options) => {
    if (!options.tools?.some((tool) => tool.name === 'agent-explore')) {
      childCalls += 1;
      return toolCallParts('brainstrike_grepSearch', 'unexpected-child-tool', {});
    }
    if (hasToolResult(options, 'agent-explore')) {
      receivedErrors.push(options.prompt.filter((message) => message.role === 'tool'));
      return textParts('PARENT_REPORTS_CONTEXT_REFUSAL');
    }
    return toolCallParts('agent-explore', 'oversized-child', { prompt: 'Inspect files.' });
  }).model;
  const chunks = await collect(
    await streamMastraAgent(
      [
        { id: 'workspace-context', parts: [{ text: trustedText, type: 'text' }], role: 'system' },
        user,
      ],
      {
        ...runtime('oversized-context'),
        personas: [persona],
        tools: {
          'brainstrike.grepSearch': createTool({
            description: 'Inspect files.',
            execute,
            id: 'grep',
            inputSchema: z.object({}),
          }),
        },
      }
    )
  );
  expect(childCalls).toBe(0);
  expect(execute).not.toHaveBeenCalled();
  expect(receivedErrors).toHaveLength(1);
  expect(receivedErrors[0]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        content: expect.arrayContaining([
          expect.objectContaining({
            output: {
              type: 'error-text',
              value: expect.stringContaining('Failed agent tool execution'),
            },
            toolName: 'agent-explore',
          }),
        ]),
        role: 'tool',
      }),
    ])
  );
  expect(JSON.stringify(chunks)).toContain('PARENT_REPORTS_CONTEXT_REFUSAL');
});
it('accepts valid root system text with ignored tool metadata when delegation is disabled', async () => {
  const model = scriptedAgentModel((options) => {
    expect(options.tools?.some((tool) => tool.name.startsWith('agent-')) ?? false).toBe(false);
    expect(JSON.stringify(options.prompt)).toContain('ROOT_SYSTEM_TEXT');
    return textParts('ROOT_WITHOUT_DELEGATION_SUCCEEDED');
  });
  modelHolder.current = model.model;
  const chunks = await collect(
    await streamMastraAgent(
      [
        {
          id: 'root-system',
          parts: [
            { text: 'ROOT_SYSTEM_TEXT', type: 'text' },
            {
              output: { source: 'workspace' },
              state: 'output-available',
              type: 'tool-contextMetadata',
            },
          ],
          role: 'system',
        },
        user,
      ],
      { ...runtime('disabled-delegation'), personas: [] }
    )
  );
  expect(model.prompts).toHaveLength(1);
  expect(JSON.stringify(chunks)).toContain('ROOT_WITHOUT_DELEGATION_SUCCEEDED');
});
