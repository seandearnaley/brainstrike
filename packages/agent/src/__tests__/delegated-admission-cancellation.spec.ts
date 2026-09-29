/** The production attempt factories must recheck owner cancellation after durable admission.
 * Native execution is observed through the existing stream harness, not replaced admission code. */
import { beforeEach, expect, it, vi } from 'vitest';
import { createMastraAgentRuntime } from '../mastra/agent-runtime';
import {
  createToolApprovalIteratorFromRuntime,
  createToolResumeIteratorFromRuntime,
} from '../mastra/attempt-legs';
import { createDelegatedConversationBinding } from '../mastra/delegated-conversation-binding';
import { resetMastraStreamHarness, setSuspendedRuns } from './fixtures/mastra-stream-harness';

vi.mock(
  '@ai-sdk/openai',
  async () => (await import('./fixtures/mastra-stream-harness')).openAiSdkMock
);

vi.mock(
  '@ai-sdk/anthropic',
  async () => (await import('./fixtures/mastra-stream-harness')).anthropicSdkMock
);

vi.mock(
  '@ai-sdk/google',
  async () => (await import('./fixtures/mastra-stream-harness')).googleSdkMock
);

vi.mock(
  '@mastra/core/agent',
  async () => (await import('./fixtures/mastra-stream-harness')).mastraAgentModuleMock
);

vi.mock(
  '@mastra/core/mastra',
  async () => (await import('./fixtures/mastra-stream-harness')).mastraCoreModuleMock
);

vi.mock(
  '../mcp/explicit-stdio-client',
  async () => (await import('./fixtures/mastra-stream-harness')).explicitStdioMcpClientModuleMock
);

beforeEach(resetMastraStreamHarness);
it.each([
  { abortAt: 'claim', leg: 'approve' },
  { abortAt: 'prepare', leg: 'approve' },
  { abortAt: 'claim', leg: 'resume' },
  { abortAt: 'prepare', leg: 'resume' },
] as const)(
  'never invokes native $leg when the owner aborts during awaited $abortAt',
  async ({ leg, abortAt }) => {
    const owner = new AbortController();
    const stopped = new Error('Owner cancelled during durable admission');
    const identity = {
      childRuntimeRunId: 'child-run',
      parentRuntimeRunId: 'parent-run',
      parentToolCallId: 'parent-call',
      personaId: 'child',
    };
    const claimToolAction = vi.fn(async () => {
      await Promise.resolve();
      if (abortAt === 'claim') {
        owner.abort(stopped);
      }
    });
    const prepareToolAction = vi.fn(async () => {
      await Promise.resolve();
      if (abortAt === 'prepare') {
        owner.abort(stopped);
      }
    });
    const finishToolActions = vi.fn(async () => undefined);
    const runtime = await createMastraAgentRuntime({
      conversationBinding: {
        ...createDelegatedConversationBinding(async () => undefined),
        claimToolAction,
        finishToolActions,
        prepareToolAction,
        releaseUnexecutedToolAction: vi.fn(async () => undefined),
        resolveToolAction: async () => [
          {
            identity,
            originalToolCall: { args: { prompt: 'Read' }, toolName: 'agent-child' },
            resourceId: 'child-owner',
            threadId: 'child-thread',
          },
        ],
      },
      runtime: { apiKey: 'key', provider: 'openai' },
      storage: { id: 'storage-with-workflows' } as never,
    });
    // The harness models native snapshots through the public Agent methods.
    // The immutable host scope and production claim/freshness code remain real.
    Object.defineProperty(runtime.agent, 'listAgents', {
      value: async () => ({
        child: {
          listAgents: async () => ({}),
          listSuspendedRuns: async () => ({
            runs: [
              {
                runId: 'child-run',
                status: 'suspended',
                suspendedAt: new Date(),
                toolCalls: [
                  {
                    args: {},
                    requiresApproval: leg === 'approve',
                    toolCallId: 'leaf-call',
                    toolName: 'read',
                  },
                ],
              },
            ],
          }),
        },
      }),
    });
    setSuspendedRuns([
      {
        runId: 'parent-run',
        status: 'suspended',
        suspendedAt: new Date(),
        toolCalls: [
          {
            args: { prompt: 'Read' },
            requiresApproval: leg === 'approve',
            toolCallId: 'parent-call',
            toolName: 'agent-child',
          },
        ],
      },
    ]);
    const approve = vi.spyOn(runtime.agent, 'approveToolCall');
    const resume = vi.spyOn(runtime.agent, 'resumeStream');
    const target = {
      delegation: { path: [identity], toolCallId: 'leaf-call' },
      runId: 'parent-run',
      toolCallId: 'parent-call',
    };
    const operation =
      leg === 'approve'
        ? createToolApprovalIteratorFromRuntime({
            action: { ...target, action: 'approve' },
            runtime,
            runtimeData: { signal: owner.signal },
          })
        : createToolResumeIteratorFromRuntime({
            action: { ...target, resumeData: { answer: 'Read' } },
            runtime,
            runtimeData: { signal: owner.signal },
          });
    let iterator: Awaited<typeof operation> | undefined;
    await expect
      .soft(
        operation.then((value) => {
          iterator = value;
          return value;
        })
      )
      .rejects.toThrow();
    expect(claimToolAction).toHaveBeenCalledOnce();
    expect(prepareToolAction).toHaveBeenCalledOnce();
    expect(finishToolActions).toHaveBeenCalledOnce();
    expect(owner.signal.aborted).toBe(true);
    expect.soft(approve).not.toHaveBeenCalled();
    expect.soft(resume).not.toHaveBeenCalled();
    if (iterator) {
      for await (const _chunk of iterator) {
        /* Let the existing abort lifecycle clean up the red control. */
      }
    }
  }
);
