import { DEFAULT_RUNTIME_ASSISTANT_WORKING_MEMORY } from '@brainstrike/assistant-contract/memory-settings';
import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import { parseMemoryRequestContext } from '@mastra/core/memory';
import { InMemoryStore } from '@mastra/core/storage';
import { createTool, type ToolExecuteContext } from '@mastra/core/tools';
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
it('read-only specialists retain their task and tools without inherited memory-write instructions', async () => {
  const setup = runtime('readonly-memory');
  setup.memory = new Memory({
    options: { generateTitle: false, workingMemory: DEFAULT_RUNTIME_ASSISTANT_WORKING_MEMORY },
    storage: setup.storage,
  });
  const childPrompts: unknown[] = [];
  const childTools: string[][] = [];
  const rootTools: string[][] = [];
  let observedChild: { threadId: string; resourceId: string } | undefined;
  const execute = vi.fn(async (_input: unknown, context?: ToolExecuteContext<unknown>) => {
    const scope = parseMemoryRequestContext(context?.requestContext);
    if (!(scope?.thread && scope.resourceId)) {
      throw new Error('Missing native child memory');
    }
    observedChild = { resourceId: scope.resourceId, threadId: scope.thread.id };
    return { matches: ['EVIDENCE'] };
  });
  modelHolder.current = scriptedAgentModel((options) => {
    const names = options.tools?.map((tool) => tool.name) ?? [];
    if (names.includes('agent-explore')) {
      rootTools.push(names);
      return hasToolResult(options, 'agent-explore')
        ? textParts('ROOT_REPORT')
        : toolCallParts('agent-explore', 'specialist', { prompt: 'Survey architecture only.' });
    }
    childPrompts.push(options.prompt);
    childTools.push(names);
    return hasToolResult(options, 'brainstrike_grepSearch')
      ? textParts('ARCHITECTURE_REPORT: EVIDENCE')
      : toolCallParts('brainstrike_grepSearch', 'inspect', {});
  }).model;
  const chunks = await collect(
    await streamMastraAgent([user], {
      ...setup,
      personas: [persona],
      tools: {
        'brainstrike.grepSearch': createTool({
          description: 'Inspect files.',
          execute,
          id: 'grep',
          inputSchema: z.object({}),
        }),
      },
    })
  );
  expect(execute, JSON.stringify(chunks)).toHaveBeenCalledTimes(1);
  expect(childPrompts).toHaveLength(2);
  expect(JSON.stringify(childPrompts)).toContain('Survey architecture only.');
  expect(JSON.stringify(childPrompts)).not.toContain('WORKING_MEMORY_SYSTEM_INSTRUCTION');
  expect(childTools.flat()).not.toContain('updateWorkingMemory');
  expect(rootTools.flat()).toContain('updateWorkingMemory');
  expect(JSON.stringify(chunks)).toContain('ARCHITECTURE_REPORT: EVIDENCE');
  expect(JSON.stringify(chunks)).toContain('ROOT_REPORT');
  expect(observedChild?.threadId).not.toBe(setup.runtime.memory.threadId);
  expect(observedChild?.resourceId).not.toBe(setup.runtime.memory.resourceId);
  const store = await setup.storage.getStore('memory');
  if (!(store && observedChild)) {
    throw new Error('Missing child storage');
  }
  expect(await store.getThreadById({ threadId: observedChild.threadId })).toMatchObject({
    id: observedChild.threadId,
    resourceId: observedChild.resourceId,
  });
  const saved = await store.listMessages({ perPage: false, threadId: observedChild.threadId });
  expect(JSON.stringify(saved.messages)).toContain('ARCHITECTURE_REPORT: EVIDENCE');
  expect(JSON.stringify(saved.messages)).not.toContain('ROOT_REPORT');
});
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
