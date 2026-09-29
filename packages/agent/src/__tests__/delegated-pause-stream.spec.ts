import { beforeEach, expect, it, vi } from 'vitest';
import { createMastraAgentRuntime } from '../mastra/agent-runtime';
import { createStreamIteratorFromRuntime } from '../mastra/attempt-legs';
import { createDelegatedConversationBinding } from '../mastra/delegated-conversation-binding';
import type { StreamChunk } from '../types';
import { resetMastraStreamHarness, setMockStreamParts } from './fixtures/mastra-stream-harness';

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
  { toolName: 'brainstrike.askUser', type: 'tool-call-suspended', unsupported: false },
  { toolName: 'brainstrike.submitPlan', type: 'tool-call-suspended', unsupported: false },
  { toolName: 'mcp_safe', type: 'tool-call-approval', unsupported: false },
  { toolName: 'unknown_suspend_tool', type: 'tool-call-suspended', unsupported: true },
  { toolName: 'brainstrike.executeCommand', type: 'tool-call-approval', unsupported: false },
] as const)(
  'projects the observed $toolName leaf before parent pause classification',
  async ({ type, toolName, unsupported }) => {
    const leafPayload = { question: 'Which workspace?' };
    const leafArgs = { command: 'pnpm build' };
    // Distinct args/payload values deliberately prove selection of the decision kind.
    const leaf = {
      payload: {
        args: leafArgs,
        messageId: 'child-message',
        resumeSchema: '{}',
        suspendPayload: leafPayload,
        toolCallId: 'leaf-call',
        toolName: toolName === 'mcp_safe' ? 'mcp_safe_leaf' : toolName,
      },
      runId: 'child-run',
      type,
    };
    setMockStreamParts([
      {
        payload: { output: leaf, toolCallId: 'delegate-call', toolName: 'agent-explore' },
        runId: 'root-run',
        type: 'tool-output',
      },
      {
        payload: {
          args: { prompt: 'Inspect' },
          resumeSchema: 'wrong-parent-schema',
          suspendPayload: { wrong: 'parent wrapper' },
          toolCallId: 'delegate-call',
          toolName: 'agent-explore',
        },
        runId: 'root-run',
        type,
      },
    ]);
    const runtime = await createMastraAgentRuntime({
      conversationBinding: {
        ...createDelegatedConversationBinding(async () => undefined),
        bindRun: async () => ({ messageId: 'child-message', threadId: 'owned-child' }),
      },
      runtime: { apiKey: 'test-key', provider: 'openai' },
    });
    // This is stream-loop wiring proof, with native/model assembly mocked. The
    // separate process fixture verifies actual Agent/tool/storage behavior.
    runtime.delegationToolPersonas = new Map([['agent-explore', 'explore']]);
    const stream = await createStreamIteratorFromRuntime({
      messages: [{ id: 'user', parts: [{ text: 'Inspect', type: 'text' }], role: 'user' }],
      runtime,
      sanitizedNameMap: new Map([
        ['mcp_safe_leaf', 'mcp_safe'],
        ['mcp_safe', 'mcp.safe'],
      ]),
    });
    const chunks: StreamChunk[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    const noticeType =
      type === 'tool-call-approval' ? 'tool-approval-required' : 'tool-suspend-required';
    expect(chunks.find((chunk) => chunk.type === noticeType)).toMatchObject({
      delegation: {
        path: [
          {
            childRuntimeRunId: 'child-run',
            parentRuntimeRunId: 'root-run',
            parentToolCallId: 'delegate-call',
            personaId: 'explore',
          },
        ],
        toolCallId: 'leaf-call',
      },
      resumeSchema: '{}',
      runId: 'root-run',
      toolCallId: 'delegate-call',
      toolName,
      type: noticeType,
      ...(type === 'tool-call-approval' ? { args: leafArgs } : { suspendPayload: leafPayload }),
    });
    expect(
      chunks.filter(
        (chunk) => chunk.type === 'run-event' && chunk.event.kind === 'tool.resume.unsupported'
      )
    ).toHaveLength(unsupported ? 1 : 0);
  }
);
