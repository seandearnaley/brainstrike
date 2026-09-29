import { describe, expect, it } from 'vitest';
import type {
  StreamChunk,
  StreamChunkDelegatedConversation,
  StreamChunkToolApprovalRequired,
} from '../../types';
import { withRootPauseNotices } from '../root-pause-notices';

const edge = {
  childRuntimeRunId: 'child-run',
  parentRuntimeRunId: 'root-run',
  parentToolCallId: 'delegate-1',
  personaId: 'explore',
};

const childNotice = (withDelegation = true): StreamChunkToolApprovalRequired => ({
  args: { path: '.' },
  ...(withDelegation ? { delegation: { path: [edge], toolCallId: 'leaf-1' } } : {}),
  riskCategory: 'read',
  runId: 'child-run',
  toolCallId: 'leaf-1',
  toolName: 'brainstrike.readWorkspaceDirectory',
  type: 'tool-approval-required',
});

const scoped = (chunk: StreamChunkDelegatedConversation['chunk']): StreamChunk => ({
  chunk,
  identity: edge,
  messageId: 'message-1',
  type: 'delegated-conversation-chunk',
});

// Every parked leaf decision gets a card in the ROOT thread. A background
// child's pause suspends nothing in the parent run, so the root card must be
// synthesized from the child envelope (thread-b629776b, 2026-09-14).
describe('withRootPauseNotices', () => {
  it('synthesizes a root card and its durable row for a background child pause', () => {
    const held = [scoped(childNotice())];
    const published = withRootPauseNotices(held);
    expect(published.slice(0, 1)).toEqual(held);
    expect(published.slice(1)).toMatchObject([
      {
        event: {
          kind: 'tool.approval.requested',
          metadata: {
            riskCategory: 'read',
            toolCallId: 'delegate-1',
            toolName: 'brainstrike.readWorkspaceDirectory',
          },
        },
        type: 'run-event',
      },
      {
        args: { path: '.' },
        delegation: { path: [edge], toolCallId: 'leaf-1' },
        riskCategory: 'read',
        runId: 'root-run',
        toolCallId: 'delegate-1',
        toolName: 'brainstrike.readWorkspaceDirectory',
        type: 'tool-approval-required',
      },
    ]);
  });

  it('adds nothing when a foreground parent pause already addressed the same leaf', () => {
    const held: StreamChunk[] = [
      scoped(childNotice()),
      {
        delegation: { path: [edge], toolCallId: 'leaf-1' },
        runId: 'root-run',
        toolCallId: 'delegate-1',
        toolName: 'brainstrike.readWorkspaceDirectory',
        type: 'tool-approval-required',
      },
    ];
    expect(withRootPauseNotices(held)).toEqual(held);
  });

  it('synthesizes a typed suspend card without a durable approval row', () => {
    const held = [
      scoped({
        delegation: { path: [edge], toolCallId: 'leaf-q' },
        runId: 'child-run',
        suspendPayload: { question: 'Which root?' },
        toolCallId: 'leaf-q',
        toolName: 'brainstrike.askUser',
        type: 'tool-suspend-required',
      }),
    ];
    const published = withRootPauseNotices(held);
    expect(published).toHaveLength(2);
    expect(published[1]).toMatchObject({
      runId: 'root-run',
      suspendPayload: { question: 'Which root?' },
      toolCallId: 'delegate-1',
      type: 'tool-suspend-required',
    });
  });

  it('ignores child chunks that are not decisions and notices without ancestry', () => {
    const held: StreamChunk[] = [
      scoped({ type: 'text-delta', value: 'hi' } as StreamChunkDelegatedConversation['chunk']),
      scoped(childNotice(false)),
    ];
    expect(withRootPauseNotices(held)).toEqual(held);
  });
});
