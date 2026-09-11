import { BUILT_IN_PERSONAS } from '@brainstrike/assistant-contract/personas';
import { InMemoryStore } from '@mastra/core/storage';
import { createTool } from '@mastra/core/tools';
import { Memory } from '@mastra/memory';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createDelegatedConversationBinding,
  type DelegatedConversationIdentity,
  type DelegatedToolActionScope,
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
      throw new Error('Missing scripted model');
    }
    return modelHolder.current;
  },
}));
const { streamMastraAgent, streamMastraToolApprovalAction } = await import(
  '../mastra/agent-streaming'
);

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

// Runtime assembly and native approval are real; this in-memory host port is
// deliberately not another proof of desktop persistence or process restart.
it.for(['approve', 'decline'] as const)(
  'built-in worker preserves context and executes a guarded edit only after %s',
  async (action) => {
    const worker = BUILT_IN_PERSONAS.find((persona) => persona.id === 'worker');
    expect(worker, 'The production built-in worker must be available after BST-1720').toBeDefined();
    if (!worker) {
      throw new Error('Built-in worker is not implemented');
    }
    const write = vi.fn(async (_input: { content: string; path: string }) => ({ written: true }));
    const preToolUse = vi.fn(async () => ({ decision: 'allow' as const }));
    const postToolUse = vi.fn(async () => ({}));
    const identities: DelegatedConversationIdentity[] = [];
    const scopes: DelegatedToolActionScope[] = [];
    const binding = {
      ...createDelegatedConversationBinding(async (identity) => {
        identities.push(identity);
      }),
      bindRun: async (identity: DelegatedRunIdentity) => {
        const child = identities.find(
          (entry) => entry.parentToolCallId === identity.parentToolCallId
        );
        if (!child) {
          throw new Error('Native child was not bound');
        }
        scopes.splice(0, scopes.length, {
          identity,
          ...(child.originalToolCall ? { originalToolCall: child.originalToolCall } : {}),
          resourceId: child.childResourceId,
          threadId: child.childThreadId,
        });
        return { threadId: child.childThreadId };
      },
      claimToolAction: async () => undefined,
      finishToolActions: async () => undefined,
      prepareToolAction: async () => undefined,
      releaseUnexecutedToolAction: async () => undefined,
      resolveToolAction: async () => scopes,
    };
    const childPrompts: unknown[] = [];
    const parentResults: unknown[] = [];
    modelHolder.current = scriptedAgentModel((options) => {
      if (options.tools?.some((tool) => tool.name === 'agent-worker')) {
        if (hasToolResult(options, 'agent-worker')) {
          parentResults.push(options.prompt);
          return textParts('PARENT_RECEIVED_WORKER_RESULT');
        }
        return toolCallParts('agent-worker', 'worker-delegation', {
          instructions: 'DELEGATED_TASK_DETAIL',
          prompt: 'Create the requested deliverable.',
        });
      }
      childPrompts.push(options.prompt);
      return hasToolResult(options, 'brainstrike_writeWorkspaceFile')
        ? textParts('WORKER_DELIVERABLE_RESULT')
        : toolCallParts('brainstrike_writeWorkspaceFile', 'worker-edit', {
            content: 'disposable output',
            path: 'worker-output.txt',
          });
    }).model;
    const storage = new InMemoryStore({ id: `worker-${action}` });
    const memory = new Memory({ options: { generateTitle: false }, storage });
    const options = {
      conversationBinding: binding,
      memory,
      personas: [worker],
      runtime: {
        apiKey: 'test-key',
        hookRunner: { postToolUse, preToolUse },
        memory: { resourceId: `worker-resource-${action}`, threadId: `worker-root-${action}` },
        permissionPolicy: {
          policies: { edit: 'ask', execute: 'ask', mcp: 'deny', read: 'allow' },
          riskByTool: { 'brainstrike.writeWorkspaceFile': 'edit' },
          yolo: false,
        },
        provider: 'openai',
      },
      storage,
      tools: {
        'brainstrike.writeWorkspaceFile': createTool({
          description: 'Write a disposable workspace deliverable.',
          execute: write,
          id: 'brainstrike.writeWorkspaceFile',
          inputSchema: z.object({ content: z.string(), path: z.string() }),
        }),
      },
    } as const;
    const initial = await drain(
      await streamMastraAgent(
        [
          {
            id: 'workspace-context',
            parts: [{ text: 'TRUSTED_WORKSPACE_CONVENTION', type: 'text' }],
            role: 'system',
          },
          {
            id: 'user',
            parts: [{ text: 'Delegate my deliverable to Worker.', type: 'text' }],
            role: 'user',
          },
        ],
        options
      )
    );
    const pending = initial.find((chunk) => chunk.type === 'tool-approval-required');
    expect(pending).toBeDefined();
    expect(write).not.toHaveBeenCalled();
    expect(preToolUse).not.toHaveBeenCalled();
    if (pending?.type !== 'tool-approval-required') {
      throw new Error('Missing native child approval');
    }
    expect(pending.delegation).toBeDefined();
    const resumed = await drain(
      await streamMastraToolApprovalAction(
        {
          action,
          runId: pending.runId,
          toolCallId: pending.toolCallId,
          toolName: pending.toolName,
          ...(pending.delegation ? { delegation: pending.delegation } : {}),
        },
        options
      )
    );
    expect(write).toHaveBeenCalledTimes(action === 'approve' ? 1 : 0);
    expect(preToolUse).toHaveBeenCalledTimes(action === 'approve' ? 1 : 0);
    expect(postToolUse).toHaveBeenCalledTimes(action === 'approve' ? 1 : 0);
    if (action === 'approve') {
      expect(write).toHaveBeenCalledWith(
        { content: 'disposable output', path: 'worker-output.txt' },
        expect.anything()
      );
    }
    expect(JSON.stringify(resumed)).toContain('PARENT_RECEIVED_WORKER_RESULT');
    expect(JSON.stringify(parentResults)).toContain('WORKER_DELIVERABLE_RESULT');
    const firstPrompt = z
      .array(z.object({ content: z.unknown(), role: z.string() }))
      .parse(childPrompts[0]);
    expect(JSON.stringify(firstPrompt.filter((message) => message.role === 'system'))).toContain(
      'TRUSTED_WORKSPACE_CONVENTION'
    );
    expect(
      JSON.stringify(firstPrompt.filter((message) => message.role === 'system'))
    ).not.toContain('DELEGATED_TASK_DETAIL');
    expect(JSON.stringify(firstPrompt.filter((message) => message.role === 'user'))).toContain(
      'DELEGATED_TASK_DETAIL'
    );
    await memory.settled();
  }
);
