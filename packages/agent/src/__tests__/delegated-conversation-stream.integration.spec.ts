import { DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS } from '@brainstrike/assistant-contract/memory-settings';
import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import { InMemoryStore } from '@mastra/core/storage';
import { createTool } from '@mastra/core/tools';
import { Memory } from '@mastra/memory';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createDelegatedConversationBinding,
  type DelegatedConversationIdentity,
} from '../mastra/delegated-conversation-binding';
import type { DelegatedRunIdentity } from '../mastra/delegated-run-publication';
import {
  hasToolResult,
  scriptedAgentModel,
  textParts,
  toolCallParts,
} from '../test-fixtures/scripted-agent-model';
import type { StreamChunk } from '../types';

const { modelHolder } = vi.hoisted(() => ({
  modelHolder: { current: undefined as ReturnType<typeof scriptedAgentModel>['model'] | undefined },
}));
vi.mock('../providers/provider-factory', async (original) => ({
  ...(await original<typeof import('../providers/provider-factory')>()),
  createProvider: () => {
    if (!modelHolder.current) {
      throw new Error('Scripted model is not configured');
    }
    return modelHolder.current;
  },
}));
const { streamMastraAgent } = await import('../mastra/agent-streaming');
const DELEGATION_TOOL = 'agent-explore';
const CHILD_TOOL = 'brainstrike_grepSearch';
const OM_DISABLED_MEMORY_SETTINGS = {
  ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  observationalMemory: {
    ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.observationalMemory,
    enabled: false,
  },
};
const testPersona: AssistantPersonaDefinition = {
  allowedToolIds: ['brainstrike.grepSearch'],
  description: 'Read evidence',
  id: 'explore',
  instructions: 'Read evidence',
  label: 'Explorer',
  maxSteps: 8,
};
function makeChildTool(execute: () => Promise<{ matches: string[] }>) {
  return createTool({
    description: 'Search',
    execute,
    id: 'brainstrike.grepSearch',
    inputSchema: z.object({ pattern: z.string() }),
  });
}

function makeBinding() {
  const identities: DelegatedConversationIdentity[] = [];
  const bindRun = vi.fn(async (run: DelegatedRunIdentity) => {
    const identity = identities.find(
      (entry) =>
        entry.parentRuntimeRunId === run.parentRuntimeRunId &&
        entry.parentToolCallId === run.parentToolCallId
    );
    if (!identity) {
      throw new Error('Missing observed child scope');
    }
    return { threadId: identity.childThreadId };
  });
  return {
    ...createDelegatedConversationBinding(async (identity) => {
      identities.push(identity);
    }),
    bindRun,
  };
}

describe('delegated conversation stream (real Mastra)', () => {
  it('keeps an empty child response failure scoped to the child instead of retrying the root', async () => {
    let childCalls = 0;
    modelHolder.current = scriptedAgentModel((options) => {
      if (options.tools?.some((tool) => tool.name === DELEGATION_TOOL)) {
        return hasToolResult(options, DELEGATION_TOOL)
          ? textParts('Parent handled the missing child answer.')
          : toolCallParts(DELEGATION_TOOL, 'empty-child', { prompt: 'Read evidence' });
      }
      childCalls += 1;
      return textParts('');
    }).model;
    const stream = await streamMastraAgent(
      [{ id: 'user', parts: [{ text: 'Read evidence', type: 'text' }], role: 'user' }],
      {
        conversationBinding: makeBinding(),
        memory: new Memory({ storage: new InMemoryStore({ id: 'empty-child' }) }),
        personas: [testPersona],
        runtime: {
          apiKey: 'test-key',
          memory: {
            memorySettings: OM_DISABLED_MEMORY_SETTINGS,
            resourceId: 'owner',
            threadId: 'root',
          },
          provider: 'openai',
        },
        tools: { 'brainstrike.grepSearch': makeChildTool(async () => ({ matches: [] })) },
      }
    );
    const chunks: StreamChunk[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    expect(childCalls).toBe(1);
    expect(
      chunks
        .filter((chunk) => chunk.type === 'text-delta')
        .map((chunk) => chunk.value)
        .join('')
    ).toBe('Parent handled the missing child answer.');
    expect(
      chunks.filter((chunk) => chunk.type === 'run-event' && chunk.event.kind === 'run.failed')
    ).toEqual([]);
    expect(
      chunks.filter(
        (chunk) =>
          chunk.type === 'delegated-conversation-chunk' &&
          chunk.chunk.type === 'run-event' &&
          chunk.chunk.event.kind === 'run.failed'
      )
    ).toHaveLength(1);
  });

  it('settles the partial child when the root is cancelled during its tool', async () => {
    const abort = new AbortController();
    modelHolder.current = scriptedAgentModel((options) => {
      if (options.tools?.some((tool) => tool.name === DELEGATION_TOOL)) {
        return toolCallParts(DELEGATION_TOOL, 'delegation', { prompt: 'Read evidence' });
      }
      return [
        { type: 'stream-start', warnings: [] },
        { id: 'partial', type: 'text-start' },
        { delta: 'Partial child answer', id: 'partial', type: 'text-delta' },
        { id: 'partial', type: 'text-end' },
        ...toolCallParts(CHILD_TOOL, 'waiting-tool', { pattern: 'flag' }).slice(1),
      ];
    }).model;
    const memory = new Memory({ storage: new InMemoryStore({ id: 'cancelled-child' }) });
    const stream = await streamMastraAgent(
      [{ id: 'user', parts: [{ text: 'Read evidence', type: 'text' }], role: 'user' }],
      {
        conversationBinding: makeBinding(),
        memory,
        personas: [testPersona],
        runtime: {
          apiKey: 'test-key',
          memory: {
            memorySettings: OM_DISABLED_MEMORY_SETTINGS,
            resourceId: 'owner',
            threadId: 'root',
          },
          provider: 'openai',
          signal: abort.signal,
        },
        tools: {
          'brainstrike.grepSearch': makeChildTool(
            () =>
              new Promise((resolve) => {
                if (abort.signal.aborted) {
                  resolve({ matches: [] });
                  return;
                }
                abort.signal.addEventListener('abort', () => resolve({ matches: [] }), {
                  once: true,
                });
              })
          ),
        },
      }
    );
    const chunks: StreamChunk[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
      if (
        chunk.type === 'delegated-conversation-chunk' &&
        chunk.chunk.type === 'tool-event' &&
        chunk.chunk.status === 'start'
      ) {
        abort.abort();
      }
    }
    expect(abort.signal.aborted).toBe(true);
    const child = chunks.filter((chunk) => chunk.type === 'delegated-conversation-chunk');
    expect(
      child.some(
        ({ chunk }) => chunk.type === 'text-delta' && chunk.value === 'Partial child answer'
      )
    ).toBe(true);
    expect(
      child.filter(
        ({ chunk }) => chunk.type === 'run-event' && chunk.event.kind === 'run.cancelled'
      )
    ).toHaveLength(1);
    expect(child.filter(({ chunk }) => chunk.type === 'message-finish')).toHaveLength(1);
    expect(
      child.filter(
        ({ chunk }) =>
          chunk.type === 'run-event' &&
          chunk.event.kind === 'tool.failed' &&
          chunk.event.status === 'cancelled'
      )
    ).toHaveLength(1);
    expect(
      child.filter(({ chunk }) => chunk.type === 'tool-event' && chunk.status === 'error')
    ).toMatchObject([{ chunk: { payload: { toolCallId: 'waiting-tool' } } }]);
    expect(new Set(child.map(({ messageId }) => messageId)).size).toBe(1);
  });

  it('keeps concurrent same-persona content, reasoning and tool calls in distinct native conversations', async () => {
    const model = scriptedAgentModel((options) => {
      const isParent = options.tools?.some((tool) => tool.name === DELEGATION_TOOL);
      if (hasToolResult(options, isParent ? DELEGATION_TOOL : CHILD_TOOL)) {
        return textParts(
          isParent
            ? 'PARENT_ANSWER: the flag is FLAG-42.'
            : 'CHILD_ANSWER: found FLAG-42 in the workspace.'
        );
      }
      if (isParent) {
        return [
          ...toolCallParts(DELEGATION_TOOL, 'first-delegation', { prompt: 'First task' }).slice(
            0,
            2
          ),
          ...toolCallParts(DELEGATION_TOOL, 'second-delegation', { prompt: 'Second task' }).slice(
            1
          ),
        ];
      }
      return [
        { type: 'stream-start', warnings: [] },
        { id: 'child-intro', type: 'text-start' },
        { delta: 'Checking evidence.', id: 'child-intro', type: 'text-delta' },
        { id: 'child-intro', type: 'text-end' },
        { id: 'child-reasoning', type: 'reasoning-start' },
        { delta: 'Compare the matches.', id: 'child-reasoning', type: 'reasoning-delta' },
        { id: 'child-reasoning', type: 'reasoning-end' },
        ...toolCallParts(CHILD_TOOL, 'shared-child-tool-id', { pattern: 'flag' }).slice(1),
      ];
    });
    modelHolder.current = model.model;
    const memory = new Memory({ options: { generateTitle: false }, storage: new InMemoryStore() });
    const identities: DelegatedConversationIdentity[] = [];
    const bindRun = vi.fn(async (run: DelegatedRunIdentity) => {
      const identity = identities.find(
        (entry) =>
          entry.parentRuntimeRunId === run.parentRuntimeRunId &&
          entry.parentToolCallId === run.parentToolCallId
      );
      if (!identity) {
        throw new Error('Missing observed child scope');
      }
      return { threadId: identity.childThreadId };
    });
    const iterator = await streamMastraAgent(
      [{ id: 'concurrent-user', parts: [{ text: 'Run both tasks', type: 'text' }], role: 'user' }],
      {
        conversationBinding: {
          ...createDelegatedConversationBinding(async (identity) => {
            identities.push(identity);
          }),
          bindRun,
        },
        memory,
        personas: [testPersona],
        runtime: {
          apiKey: 'test-key',
          memory: {
            memorySettings: OM_DISABLED_MEMORY_SETTINGS,
            resourceId: 'owner',
            threadId: 'root',
          },
          provider: 'openai',
        },
        tools: {
          'brainstrike.grepSearch': makeChildTool(vi.fn(async () => ({ matches: ['flag'] }))),
        },
      }
    );
    const chunks: StreamChunk[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }
    const children = chunks.filter((chunk) => chunk.type === 'delegated-conversation-chunk');
    expect(identities).toHaveLength(2);
    expect(new Set(identities.map((identity) => identity.childThreadId)).size).toBe(2);
    expect(bindRun).toHaveBeenCalledTimes(2);
    expect(new Set(children.map((chunk) => chunk.identity.childRuntimeRunId)).size).toBe(2);
    expect(new Set(children.map((chunk) => chunk.messageId)).size).toBe(2);
    for (const parentToolCallId of ['first-delegation', 'second-delegation']) {
      const content = children
        .filter((chunk) => chunk.identity.parentToolCallId === parentToolCallId)
        .map((chunk) => chunk.chunk);
      const visible = content.filter(
        (chunk) =>
          chunk.type === 'text-delta' ||
          chunk.type === 'reasoning-delta' ||
          chunk.type === 'tool-event'
      );
      expect(content).toContainEqual(
        expect.objectContaining({
          event: expect.objectContaining({
            durationMs: expect.any(Number),
            kind: 'tool.completed',
            metadata: expect.objectContaining({ toolCallId: 'shared-child-tool-id' }),
          }),
          type: 'run-event',
        })
      );
      expect(visible.map((chunk) => chunk.type)).toEqual([
        'text-delta',
        'reasoning-delta',
        'tool-event',
        'tool-event',
        'text-delta',
      ]);
      expect(visible[0]).toEqual({ type: 'text-delta', value: 'Checking evidence.' });
      expect(visible[1]).toEqual({ type: 'reasoning-delta', value: 'Compare the matches.' });
      expect(visible[2]).toMatchObject({
        payload: { toolCallId: 'shared-child-tool-id' },
        status: 'start',
        type: 'tool-event',
      });
      expect(visible[3]).toMatchObject({
        payload: { toolCallId: 'shared-child-tool-id' },
        status: 'success',
        type: 'tool-event',
      });
      expect(visible[4]).toEqual({
        type: 'text-delta',
        value: 'CHILD_ANSWER: found FLAG-42 in the workspace.',
      });
    }
    expect(
      chunks
        .filter((chunk) => chunk.type === 'text-delta')
        .map((chunk) => chunk.value)
        .join('')
    ).toBe('PARENT_ANSWER: the flag is FLAG-42.');
  });
});
