import { describe, expect, it } from 'vitest';
import type {
  StreamChunk,
  StreamChunkDelegatedConversation,
  StreamFinishReason,
} from '../../types';
import { withholdPauseNotices } from '../agent-streaming';

const identity = (parentToolCallId: string) => ({
  childRuntimeRunId: `child-${parentToolCallId}`,
  parentRuntimeRunId: 'root-run',
  parentToolCallId,
  personaId: 'explore',
});

const scoped = (
  parentToolCallId: string,
  chunk: StreamChunkDelegatedConversation['chunk']
): StreamChunk => ({
  chunk,
  identity: identity(parentToolCallId),
  messageId: `message-${parentToolCallId}`,
  type: 'delegated-conversation-chunk',
});

const finish = (finishReason: StreamFinishReason): StreamChunkDelegatedConversation['chunk'] => ({
  finishReason,
  path: [],
  type: 'message-finish',
  usage: { completionTokens: 0, promptTokens: 0 },
});

const notice = (toolCallId: string): StreamChunkDelegatedConversation['chunk'] => ({
  runId: 'child-run',
  toolCallId,
  toolName: 'brainstrike.readWorkspaceDirectory',
  type: 'tool-approval-required',
});

const requested = (): StreamChunkDelegatedConversation['chunk'] => ({
  event: {
    id: 'evt-1',
    kind: 'tool.approval.requested',
    label: 'Awaiting your approval',
    status: 'running',
    timestamp: '2026-09-14T00:00:00.000Z',
  },
  type: 'run-event',
});

function split(chunks: StreamChunk[]) {
  const held: StreamChunk[] = [];
  const published = [...withholdPauseNotices(chunks, held, new Set())];
  return { held, published };
}

describe('withholdPauseNotices', () => {
  it('withholds a decision, its durable row, and the paused child finish behind it', () => {
    const { held, published } = split([
      scoped('delegate-a', requested()),
      scoped('delegate-a', notice('a-dir')),
      scoped('delegate-a', finish('tool-calls')),
      { type: 'text-delta', value: 'sibling still streaming' },
    ]);
    expect(
      held.map((chunk) =>
        chunk.type === 'delegated-conversation-chunk' ? chunk.chunk.type : chunk.type
      )
    ).toEqual(['run-event', 'tool-approval-required', 'message-finish']);
    expect(published).toEqual([{ type: 'text-delta', value: 'sibling still streaming' }]);
  });

  it('keeps a child finish live when that child raised no pause (CodeRabbit review of #3187)', () => {
    const { held, published } = split([
      scoped('delegate-a', notice('a-dir')),
      scoped('delegate-b', finish('tool-calls')),
      scoped('delegate-a', finish('tool-calls')),
    ]);
    expect(published).toEqual([scoped('delegate-b', finish('tool-calls'))]);
    expect(held).toEqual([
      scoped('delegate-a', notice('a-dir')),
      scoped('delegate-a', finish('tool-calls')),
    ]);
  });

  it('never withholds a root finish or a normal child finish', () => {
    const rootFinish: StreamChunk = finish('tool-calls');
    const { held, published } = split([rootFinish, scoped('delegate-a', finish('stop'))]);
    expect(held).toEqual([]);
    expect(published).toEqual([rootFinish, scoped('delegate-a', finish('stop'))]);
  });

  it('carries pause provenance for a continuation-scoped child too', () => {
    const wrap = (chunk: StreamChunkDelegatedConversation['chunk']): StreamChunk => ({
      chunk,
      continuationId: 'continuation-1',
      messageId: 'message-1',
      nativeRunId: 'native-1',
      threadId: 'thread-1',
      type: 'child-continuation-chunk',
    });
    const { held, published } = split([wrap(notice('c-dir')), wrap(finish('tool-calls'))]);
    expect(published).toEqual([]);
    expect(held).toHaveLength(2);
  });
});
