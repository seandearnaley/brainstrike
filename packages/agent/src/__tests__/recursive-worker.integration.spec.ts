import { buildNativeToolRiskMap, getToolActionTarget } from '@brainstrike/assistant-contract';
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

const modelHolder = vi.hoisted(() => ({
  current: undefined as ReturnType<typeof scriptedAgentModel>['model'] | undefined,
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

// Provider transport alone is scripted. Production factory, native snapshots and
// host-observed ancestry remain real; disk restart durability belongs to desktop acceptance.
it.each([
  { cancel: false, depth: 2 },
  { cancel: false, depth: 3 },
  { cancel: false, depth: 3, failLeaf: true },
  { cancel: true, depth: 3, stopAtConstruction: false },
  { cancel: true, depth: 3, stopAtConstruction: true },
])(
  'same-persona Worker depth $depth with cancellation=$cancel retains native ownership',
  async ({ depth, cancel, stopAtConstruction, failLeaf }) => {
    const stop = new AbortController();
    const leafStarted = Promise.withResolvers<void>();
    const nativeSignals: (AbortSignal | undefined)[] = [];
    const worker = BUILT_IN_PERSONAS.find((persona) => persona.id === 'worker');
    if (!worker) {
      throw new Error('Built-in Worker prerequisite is missing');
    }
    const identities: DelegatedConversationIdentity[] = [];
    const scopes: DelegatedToolActionScope[] = [];
    const messageIds = new Map<string, string>();
    const reserveStep = vi.fn(async (_scope: { threadId: string; resourceId: string }) => ({
      id: `step-${reserveStep.mock.calls.length}`,
      outputTokens: 8192,
      synthesis: false,
    }));
    const settleStep = vi.fn(async (_id: string, _outputTokens: number | undefined) => undefined);
    const binding = {
      budget: { reserveStep, settleStep },
      ...createDelegatedConversationBinding(async (identity) => {
        identities.push(identity);
      }),
      bindRun: async (identity: DelegatedRunIdentity) => {
        const child = identities.find(
          (entry) =>
            entry.parentToolCallId === identity.parentToolCallId &&
            entry.parentRuntimeRunId === identity.parentRuntimeRunId
        );
        if (!child) {
          throw new Error('Native descendant has no persisted host identity');
        }
        const scope = {
          identity,
          ...(child.originalToolCall ? { originalToolCall: child.originalToolCall } : {}),
          resourceId: child.childResourceId,
          threadId: child.childThreadId,
        };
        const existing = scopes.findIndex(
          (entry) => entry.identity.childRuntimeRunId === identity.childRuntimeRunId
        );
        if (existing < 0) {
          scopes.push(scope);
        } else {
          scopes[existing] = scope;
        }
        const messageId = messageIds.get(identity.childRuntimeRunId);
        return { threadId: child.childThreadId, ...(messageId ? { messageId } : {}) };
      },
      claimToolAction: async () => undefined,
      finishToolActions: async () => undefined,
      prepareToolAction: async () => undefined,
      releaseUnexecutedToolAction: async () => undefined,
      resolveToolAction: async () => {
        const child = scopes.find((entry) => entry.identity.parentToolCallId === 'root-worker');
        const leaf = scopes.find(
          (entry) =>
            entry.identity.parentToolCallId === (depth === 3 ? 'middle-worker' : 'child-worker')
        );
        if (!(child && leaf)) {
          throw new Error('Approval requires the complete observed ancestry');
        }
        const middle = scopes.find((entry) => entry.identity.parentToolCallId === 'child-worker');
        if (depth === 3 && !middle) {
          throw new Error('Missing native middle worker');
        }
        return depth === 3 && middle ? [child, middle, leaf] : [child, leaf];
      },
    };
    const write = vi.fn(async (_input: { content: string; path: string }) => ({ written: true }));
    const childTools: string[][] = [];
    const rootResults: unknown[] = [];
    const childResults: unknown[] = [];
    const scripted = scriptedAgentModel((options) => {
      const userText = JSON.stringify(options.prompt.filter((message) => message.role === 'user'));
      if (userText.includes('LEAF_TASK_1722')) {
        return hasToolResult(options, 'brainstrike_writeWorkspaceFile')
          ? textParts('LEAF_EFFECT_RESULT_1722')
          : toolCallParts('brainstrike_writeWorkspaceFile', 'leaf-edit', {
              content: 'recursive disposable output',
              path: 'recursive-output.txt',
            });
      }
      if (userText.includes('MIDDLE_TASK_1722')) {
        return hasToolResult(options, 'agent-worker')
          ? textParts('MIDDLE_RECEIVED_LEAF_EFFECT_RESULT_1722')
          : toolCallParts('agent-worker', 'middle-worker', {
              prompt: 'LEAF_TASK_1722: write the disposable deliverable.',
            });
      }
      if (userText.includes('CHILD_TASK_1722')) {
        const tools = options.tools?.map((tool) => tool.name) ?? [];
        childTools.push(tools);
        // Fail at the production capability assertion below, rather than invoking
        // an unavailable tool or waiting for an unrelated native stream failure.
        if (!tools.includes('agent-worker')) {
          return textParts('CHILD_RECURSION_UNAVAILABLE');
        }
        if (hasToolResult(options, 'agent-worker')) {
          childResults.push(options.prompt);
          return textParts('CHILD_RECEIVED_LEAF_EFFECT_RESULT_1722');
        }
        return toolCallParts('agent-worker', 'child-worker', {
          prompt:
            depth === 3
              ? 'MIDDLE_TASK_1722: delegate the leaf deliverable.'
              : 'LEAF_TASK_1722: write the disposable deliverable.',
        });
      }
      if (hasToolResult(options, 'agent-worker')) {
        rootResults.push(options.prompt);
        return textParts('ROOT_RECEIVED_CHILD_RESULT_1722');
      }
      return toolCallParts('agent-worker', 'root-worker', {
        prompt: 'CHILD_TASK_1722: delegate the deliverable to another Worker.',
      });
    }).model;
    modelHolder.current = {
      ...scripted,
      async doStream(options) {
        const task = JSON.stringify(options.prompt.filter((message) => message.role === 'user'));
        if (task.includes('_TASK_1722')) {
          nativeSignals.push(options.abortSignal);
        }
        if (failLeaf && task.includes('LEAF_TASK_1722')) {
          throw new Error('LEAF_PROVIDER_FAILURE_1722');
        }
        if (!(cancel && task.includes('LEAF_TASK_1722'))) {
          return await scripted.doStream(options);
        }
        if (stopAtConstruction) {
          leafStarted.resolve();
        }
        return {
          stream: new ReadableStream({
            start(controller) {
              options.abortSignal?.addEventListener(
                'abort',
                () => controller.error(options.abortSignal?.reason),
                { once: true }
              );
              for (const part of textParts('LEAF_WAITING_1722').filter(
                (part) => part.type !== 'finish' && part.type !== 'text-end'
              )) {
                controller.enqueue(part);
              }
            },
          }),
        };
      },
    };
    const storage = new InMemoryStore({ id: 'recursive-worker' });
    const memory = new Memory({ options: { generateTitle: false }, storage });
    const options = {
      conversationBinding: binding,
      memory,
      model: 'gpt-5.4',
      personas: [worker],
      runtime: {
        apiKey: 'test-key',
        memory: { resourceId: 'recursive-resource', threadId: 'recursive-root' },
        model: 'gpt-5.4',
        permissionPolicy: {
          policies: { edit: 'ask', execute: 'ask', mcp: 'deny', read: 'allow' },
          riskByTool: buildNativeToolRiskMap(),
          yolo: false,
        },
        provider: 'openai',
        signal: stop.signal,
      },
      storage,
      tools: {
        'brainstrike.writeWorkspaceFile': createTool({
          description: 'Write a disposable deliverable.',
          execute: write,
          id: 'brainstrike.writeWorkspaceFile',
          inputSchema: z.object({ content: z.string(), path: z.string() }),
        }),
      },
    } as const;
    const initialStream = await streamMastraAgent(
      [
        {
          id: 'user',
          parts: [{ text: 'Delegate a deliverable through two Workers.', type: 'text' }],
          role: 'user',
        },
      ],
      options
    );
    const initial: StreamChunk[] = [];
    const initialDone = (async () => {
      for await (const chunk of initialStream) {
        initial.push(chunk);
        if (JSON.stringify(chunk).includes('LEAF_WAITING_1722')) {
          leafStarted.resolve();
        }
      }
    })();
    if (cancel) {
      await leafStarted.promise;
      const reservationsBeforeStop = reserveStep.mock.calls.length;
      stop.abort(new Error('User stopped recursive work'));
      await initialDone;
      expect(reserveStep).toHaveBeenCalledTimes(reservationsBeforeStop);
      expect(write).not.toHaveBeenCalled();
      expect(identities).toHaveLength(depth);
      expect(nativeSignals).toHaveLength(depth);
      expect(nativeSignals.every((signal) => signal?.aborted)).toBe(true);
      const events = initial.flatMap((chunk) =>
        chunk.type === 'run-event'
          ? [chunk.event]
          : chunk.type === 'delegated-conversation-chunk' && chunk.chunk.type === 'run-event'
            ? [chunk.chunk.event]
            : []
      );
      const started = events.filter((event) => event.kind === 'subagent.started');
      expect(started).toHaveLength(depth);
      for (const event of started) {
        expect(
          events.some(
            (candidate) =>
              candidate.kind === 'subagent.failed' &&
              candidate.status === 'cancelled' &&
              candidate.metadata?.['parentToolCallId'] === event.metadata?.['parentToolCallId']
          )
        ).toBe(true);
      }
      return;
    }
    await initialDone;
    if (failLeaf) {
      const events = initial.flatMap((chunk) =>
        chunk.type === 'run-event'
          ? [chunk.event]
          : chunk.type === 'delegated-conversation-chunk' && chunk.chunk.type === 'run-event'
            ? [chunk.chunk.event]
            : []
      );
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'subagent.failed',
            metadata: expect.objectContaining({ parentToolCallId: 'middle-worker' }),
            status: 'failed',
          }),
        ])
      );
      expect(events).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'subagent.failed',
            metadata: expect.objectContaining({ parentToolCallId: 'root-worker' }),
          }),
        ])
      );
      expect(write).not.toHaveBeenCalled();
      expect(
        initial.some(
          (chunk) =>
            chunk.type === 'text-delta' && chunk.value.includes('ROOT_RECEIVED_CHILD_RESULT_1722')
        )
      ).toBe(true);
      return;
    }
    expect(childTools, JSON.stringify(initial)).not.toHaveLength(0);
    expect(
      childTools[0],
      'Production Worker must advertise same-persona agent-worker for a permitted descendant'
    ).toContain('agent-worker');
    expect(write).not.toHaveBeenCalled();
    for (const frame of initial) {
      if (frame.type === 'delegated-conversation-chunk') {
        messageIds.set(frame.identity.childRuntimeRunId, frame.messageId);
      }
    }
    const child = identities.find((entry) => entry.parentToolCallId === 'root-worker');
    const leaf = identities.find(
      (entry) => entry.parentToolCallId === (depth === 3 ? 'middle-worker' : 'child-worker')
    );
    const middle = identities.find((entry) => entry.parentToolCallId === 'child-worker');
    expect(identities).toHaveLength(depth);
    expect(child?.parentThreadId).toBe('recursive-root');
    expect(leaf?.parentThreadId).toBe(depth === 3 ? middle?.childThreadId : child?.childThreadId);
    expect(leaf?.childThreadId).not.toBe(child?.childThreadId);
    expect(new Set(scopes.map((entry) => entry.identity.childRuntimeRunId)).size).toBe(depth);
    expect(messageIds.size).toBe(depth);
    const pending = initial.find((chunk) => chunk.type === 'tool-approval-required');
    if (pending?.type !== 'tool-approval-required') {
      throw new Error('Missing native grandchild approval');
    }
    const target = getToolActionTarget(pending);
    expect(target.toolCallId).toBe('root-worker');
    expect(target.delegation?.toolCallId).toBe('leaf-edit');
    expect(target.delegation?.path).toHaveLength(depth);
    expect(target.delegation?.path.at(-1)?.childRuntimeRunId).toBe(
      scopes.find(
        (entry) =>
          entry.identity.parentToolCallId === (depth === 3 ? 'middle-worker' : 'child-worker')
      )?.identity.childRuntimeRunId
    );
    const resumed = await drain(
      await streamMastraToolApprovalAction(
        { action: 'approve', ...target, toolName: pending.toolName },
        options
      )
    );
    expect(reserveStep).toHaveBeenCalled();
    expect(settleStep).toHaveBeenCalledTimes(reserveStep.mock.calls.length);
    expect(new Set(reserveStep.mock.calls.map(([scope]) => scope.threadId))).toEqual(
      new Set(identities.map((identity) => identity.childThreadId))
    );
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0]).toEqual({
      content: 'recursive disposable output',
      path: 'recursive-output.txt',
    });
    expect(JSON.stringify(childResults)).toContain('LEAF_EFFECT_RESULT_1722');
    expect(JSON.stringify(rootResults)).toContain('CHILD_RECEIVED_LEAF_EFFECT_RESULT_1722');
    expect(JSON.stringify(resumed)).toContain('ROOT_RECEIVED_CHILD_RESULT_1722');
  },
  10_000
);
