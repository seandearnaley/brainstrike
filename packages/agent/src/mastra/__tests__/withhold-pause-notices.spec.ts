import { describe, expect, it } from 'vitest';
import type {
  StreamChunk,
  StreamChunkDelegatedConversation,
  StreamFinishReason,
} from '../../types';
import {
  dropHeldPauseFinish,
  releaseParkedNotices,
  withholdPauseNotices,
} from '../agent-streaming';

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

// A BACKGROUND child's pause parks its own task; nothing in this run suspends,
// so the notice publishes without the leg's completion join (thread-4f14436f,
// 2026-09-14: three cards held 77 s until the last sibling returned) — but not
// before the task is durably parked: the child's pause chunk streams ahead of
// the task's storage row, and a decision delivered into the leg in that window
// finds nothing to resume. The native `background-task-suspended` part is the
// release.
describe('withholdPauseNotices for background children', () => {
  const owner = JSON.stringify(['root-run', 'delegate-a']);
  const scopedNotice: StreamChunk = {
    chunk: {
      delegation: { path: [identity('delegate-a')], toolCallId: 'leaf-a' },
      runId: 'child-run',
      toolCallId: 'leaf-a',
      toolName: 'brainstrike.readWorkspaceDirectory',
      type: 'tool-approval-required',
    },
    identity: identity('delegate-a'),
    messageId: 'message-a',
    type: 'delegated-conversation-chunk',
  };
  const suspendedPart = {
    payload: { runId: 'root-run', taskId: 'task-a', toolCallId: 'delegate-a' },
    type: 'background-task-suspended',
  };

  it('parks a background child pause until its task is suspended, then publishes it with a root card', () => {
    const held: StreamChunk[] = [];
    const parked = new Map<string, StreamChunk[]>();
    const published = [
      ...withholdPauseNotices(
        [scopedNotice, scoped('delegate-a', finish('tool-calls'))],
        held,
        new Set(),
        new Set([owner]),
        parked
      ),
    ];
    expect(published).toEqual([]);
    expect(held).toEqual([]);
    expect(parked.get(owner)).toHaveLength(2);
    // Another task's suspension releases nothing of this child's.
    expect([
      ...releaseParkedNotices(
        {
          payload: { runId: 'root-run', taskId: 'task-b', toolCallId: 'delegate-b' },
          type: 'background-task-suspended',
        },
        parked,
        held
      ),
    ]).toEqual([]);
    const released = [...releaseParkedNotices(suspendedPart, parked, held)];
    // The notice and its root card publish; the child's pause FINISH does not:
    // it is the child view's terminal, and the child is parked, not finished.
    expect(released.map((chunk) => chunk.type)).toEqual([
      'delegated-conversation-chunk',
      'run-event',
      'tool-approval-required',
    ]);
    expect(released[2]).toMatchObject({ runId: 'root-run', toolCallId: 'delegate-a' });
    expect(held).toEqual([scoped('delegate-a', finish('tool-calls'))]);
    expect(parked.size).toBe(0);
    // A second suspension of the same task (its next gated read) has nothing stale to replay.
    expect([...releaseParkedNotices(suspendedPart, parked, held)]).toEqual([]);
    // The child resumed in this leg: its held terminal is dropped, another child's stays.
    held.push(scoped('delegate-b', finish('tool-calls')));
    dropHeldPauseFinish(
      {
        payload: { runId: 'root-run', taskId: 'task-a', toolCallId: 'delegate-a' },
        type: 'background-task-resumed',
      },
      held
    );
    expect(held).toEqual([scoped('delegate-b', finish('tool-calls'))]);
  });

  it('still withholds a foreground child pause', () => {
    const held: StreamChunk[] = [];
    const published = [
      ...withholdPauseNotices(
        [scoped('delegate-b', notice('leaf-b'))],
        held,
        new Set(),
        new Set([JSON.stringify(['root-run', 'delegate-a'])])
      ),
    ];
    expect(published).toEqual([]);
    expect(held).toHaveLength(1);
  });
});
