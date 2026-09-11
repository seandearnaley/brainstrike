import { buildNativeToolRiskMap, getToolActionTarget } from '@brainstrike/assistant-contract';
import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import { wasmLoader } from '@brainstrike/db';
import type { PGlite } from '@electric-sql/pglite';
import { createTool } from '@mastra/core/tools';
import { expect, it, onTestFinished, vi } from 'vitest';
import { z } from 'zod';
import {
  createDelegatedConversationBinding,
  type DelegatedConversationIdentity,
} from '../mastra/delegated-conversation-binding';
import type { DelegatedRunIdentity } from '../mastra/delegated-run-publication';
import type { PgliteDatabase } from '../pglite-mastra-memory';
import { createPgliteMastraMemory } from '../pglite-mastra-memory';
import {
  hasToolResult,
  scriptedAgentModel,
  textParts,
  toolCallParts,
} from '../test-fixtures/scripted-agent-model';
import { createAskUserTool } from '../tools/ask-user-tool';
import type { StreamChunk } from '../types';

const { modelHolder } = vi.hoisted(() => ({
  modelHolder: {
    current: undefined as ReturnType<typeof scriptedAgentModel>['model'] | undefined,
  },
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
const { streamMastraAgent, streamMastraToolApprovalAction, streamMastraToolResumeAction } =
  await import('../mastra/agent-streaming');
async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}
function memoryDatabase(database: Pick<PGlite, 'exec' | 'query'>): PgliteDatabase {
  return {
    exec: (sql) => database.exec(sql),
    query: (sql, values) => database.query(sql, values ? [...values] : undefined),
  };
}

const worker: AssistantPersonaDefinition = {
  allowedToolIds: ['brainstrike.grepSearch'],
  description: 'Complete the delegated inspection.',
  id: 'context-worker',
  instructions: 'Inspect the requested workspace evidence.',
  label: 'Context worker',
  maxSteps: 4,
  mode: 'worker',
};
it.each(['approval', 'question'] as const)(
  'retains original trusted context for a NEW worker after parent %s resume',
  async (pause) => {
    const marker = `ORIGINAL_HOST_SYSTEM_BEFORE_PARENT_${pause}`;
    const task = 'NEW_WORKER_TASK_AS_USER_DETAIL';
    const identities: DelegatedConversationIdentity[] = [];
    const binding = {
      ...createDelegatedConversationBinding(async (identity) => {
        identities.push(identity);
      }),
      bindRun: async (identity: DelegatedRunIdentity) => {
        const child = identities.find(
          (entry) => entry.parentToolCallId === identity.parentToolCallId
        );
        if (!child) {
          throw new Error('Missing native child identity');
        }
        return { threadId: child.childThreadId };
      },
      claimToolAction: async () => undefined,
      finishToolActions: async () => undefined,
      prepareToolAction: async () => undefined,
      releaseUnexecutedToolAction: async () => undefined,
      resolveToolAction: async () => [],
    };
    const workerEffect = vi.fn(async () => ({ evidence: 'WORKER_EFFECT_DONE' }));
    const parentEffect = vi.fn(async () => ({ prepared: true }));
    const childPrompts: unknown[] = [];
    const pauseTool =
      pause === 'question' ? 'brainstrike_askUser' : 'brainstrike_writeWorkspaceFile';
    modelHolder.current = scriptedAgentModel((options) => {
      if (options.tools?.some((tool) => tool.name === 'agent-context-worker')) {
        if (hasToolResult(options, 'agent-context-worker')) {
          return textParts('PARENT_RECEIVED_NEW_WORKER');
        }
        if (!hasToolResult(options, pauseTool)) {
          return toolCallParts(
            pauseTool,
            'parent-pause',
            pause === 'question' ? { question: 'Continue to delegated work?' } : {}
          );
        }
        return toolCallParts('agent-context-worker', 'new-worker-after-resume', {
          instructions: task,
          prompt: 'Inspect evidence.',
        });
      }
      childPrompts.push(options.prompt);
      if (hasToolResult(options, 'brainstrike_grepSearch')) {
        return textParts('WORKER_RESULT');
      }
      if (!options.tools?.some((tool) => tool.name === 'brainstrike_grepSearch')) {
        return toolCallParts('load_tool', 'load-worker-evidence', {
          toolName: 'brainstrike_grepSearch',
        });
      }
      return toolCallParts('brainstrike_grepSearch', 'worker-evidence', {});
    }).model;
    const database = await wasmLoader.createPGlite('memory://');
    onTestFinished(() => database.close());
    const { memory, storage } = await createPgliteMastraMemory({
      database: {
        ...memoryDatabase(database),
        transaction: (operation) => database.transaction((tx) => operation(memoryDatabase(tx))),
      },
      memoryOptions: { generateTitle: false },
    });
    const options = {
      conversationBinding: binding,
      memory,
      model: 'gpt-5.4',
      personas: [worker],
      runtime: {
        apiKey: 'test-key',
        memory: { resourceId: `resource-${pause}`, threadId: `parent-${pause}` },
        model: 'gpt-5.4',
        permissionPolicy: {
          policies: { edit: 'ask', execute: 'ask', mcp: 'deny', read: 'allow' },
          riskByTool: buildNativeToolRiskMap(),
          yolo: false,
        },
        provider: 'openai',
      },
      storage,
      tools: {
        'brainstrike.askUser': createAskUserTool(),
        'brainstrike.grepSearch': createTool({
          description: 'Read workspace evidence.',
          execute: workerEffect,
          id: 'worker-evidence',
          inputSchema: z.object({}),
        }),
        'brainstrike.writeWorkspaceFile': createTool({
          description: 'Prepare parent state before delegation.',
          execute: parentEffect,
          id: 'parent-prepare',
          inputSchema: z.object({}),
        }),
      },
    } as const;
    const initial = await drain(
      await streamMastraAgent(
        [
          {
            id: 'host-context',
            parts: [
              { text: marker, type: 'text' },
              {
                input: {},
                output: { note: 'METADATA_IS_NOT_AUTHORITY' },
                state: 'output-available',
                type: 'tool-contextMetadata',
              },
            ],
            role: 'system',
          },
          {
            id: 'user',
            parts: [{ text: 'Ask or prepare, then delegate to the worker.', type: 'text' }],
            role: 'user',
          },
        ],
        options
      )
    );
    expect(identities).toHaveLength(0);
    expect(childPrompts).toHaveLength(0);
    const pending = initial.find(
      (chunk) =>
        chunk.type === (pause === 'question' ? 'tool-suspend-required' : 'tool-approval-required')
    );
    if (
      !(
        pending &&
        (pending.type === 'tool-suspend-required' || pending.type === 'tool-approval-required')
      )
    ) {
      throw new Error('Expected parent pause before any child');
    }
    const target = getToolActionTarget(pending);
    expect(target.delegation).toBeUndefined();
    const resumed = await drain(
      pending.type === 'tool-approval-required'
        ? await streamMastraToolApprovalAction(
            { action: 'approve', ...target, toolName: pending.toolName },
            options
          )
        : await streamMastraToolResumeAction(
            { ...target, resumeData: { answer: 'Continue' }, toolName: pending.toolName },
            options
          )
    );
    expect(workerEffect).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(resumed)).toContain('PARENT_RECEIVED_NEW_WORKER');
    const prompt = z
      .array(z.object({ content: z.unknown(), role: z.string() }))
      .parse(childPrompts[0]);
    const system = JSON.stringify(prompt.filter((message) => message.role === 'system'));
    expect(system.split(marker)).toHaveLength(2);
    expect(system).not.toContain(task);
    expect(system).not.toContain('METADATA_IS_NOT_AUTHORITY');
    expect(JSON.stringify(prompt.filter((message) => message.role === 'user'))).toContain(task);
  }
);
