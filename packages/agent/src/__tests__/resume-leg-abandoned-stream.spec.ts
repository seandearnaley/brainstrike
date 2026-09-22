/**
 * A RESUME LEG THAT FAILS AFTER ITS STREAM EXISTS SETTLES IT (BST-1749).
 *
 * The approval-resume and suspended-tool resume legs build their native
 * output (`approveToolCall` / `declineToolCall` / `resumeStream`) and then run
 * steps that can still throw before any chunk is read — the aborted-turn
 * attach, and the `empty_stream` refusal below. Their `catch` aborted and
 * disposed the leg but never read the stream to its close, so Mastra's cancel
 * persistence and snapshot DELETEs floated past the end of the turn
 * (BST-1221). Each leg now settles what it abandoned through
 * `settleNativeStream`, as the initial leg's binding steps already do.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  streamMastraToolApprovalAction,
  streamMastraToolResumeAction,
} from '../mastra/agent-streaming';
import {
  mastraAgentModuleMock,
  mcpHost,
  resetMastraStreamHarness,
  setSuspendedRuns,
} from './fixtures/mastra-stream-harness';

vi.mock(
  '@ai-sdk/openai',
  async () => (await import('./fixtures/mastra-stream-harness')).openAiSdkMock
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

/** A native output with no `fullStream`: the leg refuses it as `empty_stream`. */
function emptyNativeOutput() {
  return { consumeStream: vi.fn(async () => {}), getFullOutput: async () => ({}) };
}

const runtime = { apiKey: 'test-key', provider: 'openai' } as const;
const storage = { id: 'workflow-storage' } as never;

describe('resume legs abandoned after stream construction', () => {
  beforeEach(resetMastraStreamHarness);

  it('settles the approval-resume stream it refuses as empty', async () => {
    const output = emptyNativeOutput();
    vi.spyOn(mastraAgentModuleMock.Agent.prototype, 'approveToolCall').mockResolvedValueOnce(
      output as never
    );

    await expect(
      streamMastraToolApprovalAction(
        {
          action: 'approve',
          runId: 'run-approval-1',
          toolCallId: 'tool-call-1',
          toolName: 'workspace.writeFile',
        },
        { mcpHost, requireToolApproval: true, runtime, storage }
      )
    ).rejects.toThrow();

    // MUTATION: without the settle the refused stream is never read.
    expect(output.consumeStream).toHaveBeenCalledTimes(1);
  });

  it('settles the suspended-tool resume stream it refuses as empty', async () => {
    setSuspendedRuns([
      {
        runId: 'run-suspended-1',
        status: 'suspended',
        suspendedAt: new Date('2026-07-21T00:00:00Z'),
        toolCalls: [
          {
            args: {},
            requiresApproval: false,
            suspendPayload: { question: 'Which city?' },
            toolCallId: 'tool-call-suspended-1',
            toolName: 'brainstrike_askUser',
          },
        ],
      },
    ]);
    const output = emptyNativeOutput();
    vi.spyOn(mastraAgentModuleMock.Agent.prototype, 'resumeStream').mockResolvedValueOnce(
      output as never
    );

    await expect(
      streamMastraToolResumeAction(
        {
          resumeData: { answer: 'Paris' },
          runId: 'run-suspended-1',
          toolCallId: 'tool-call-suspended-1',
        },
        { runtime, storage }
      )
    ).rejects.toThrow();

    // MUTATION: without the settle the refused stream is never read.
    expect(output.consumeStream).toHaveBeenCalledTimes(1);
  });
});
