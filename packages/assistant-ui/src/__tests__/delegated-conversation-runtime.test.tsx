// @vitest-environment jsdom
import { fromThreadMessageLike, type ThreadMessageLike } from '@assistant-ui/react';
import type { AssistantUiThreadHistoryAdapter } from '@brainstrike/assistant-contract';
import { cleanup, renderHook } from '@testing-library/react';
import {
  type AssistantMessage,
  AssistantMessageAccumulator,
  DataStreamDecoder,
} from 'assistant-stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DelegatedConversationUpdate } from '../delegated-conversation-receiver';
import { useDelegatedConversationRuntime } from '../use-delegated-conversation-runtime';

type History = Awaited<ReturnType<AssistantUiThreadHistoryAdapter['load']>>;
function saved(
  id: string,
  content: ThreadMessageLike['content'],
  role: ThreadMessageLike['role'] = 'assistant'
) {
  return fromThreadMessageLike({ content, id, role }, id, { reason: 'stop', type: 'complete' });
}
async function live(
  id: string,
  frames: readonly [string, unknown][]
): Promise<DelegatedConversationUpdate> {
  const response = new Response(
    [['f', { messageId: 'native-live' }], ...frames]
      .map(([code, value]) => `${code}:${JSON.stringify(value)}\n`)
      .join('')
  );
  if (!response.body) {
    throw new Error('Missing stream');
  }
  let message: AssistantMessage | undefined;
  for await (const snapshot of response.body
    .pipeThrough(new DataStreamDecoder())
    .pipeThrough(new AssistantMessageAccumulator())) {
    message = snapshot;
  }
  if (!message) {
    throw new Error('Missing child message');
  }
  return {
    baseline: { hostRunId: 'resumed', messages: [], runEvents: [], threadId: id },
    identity: {
      childRuntimeRunId: id,
      parentRuntimeRunId: 'parent-run',
      parentToolCallId: `call-${id}`,
      personaId: 'explore',
    },
    message,
    messageId: 'native-live',
  };
}
const finish: [string, unknown] = [
  'd',
  { finishReason: 'stop', usage: { inputTokens: 0, outputTokens: 0 } },
];
afterEach(cleanup);

describe('shared child conversation runtime', () => {
  it('keeps prior text and reasoning, merges the resumed tool in place, and preserves identical continuation text', async () => {
    const history: History = {
      headId: 'prior',
      messages: [
        { message: saved('instructions', 'Inspect the workspace', 'user'), parentId: null },
        {
          message: saved('prior', [
            { text: 'Same evidence.', type: 'text' },
            { text: 'Read the exact file.', type: 'reasoning' },
            { args: { path: 'file' }, toolCallId: 'read-1', toolName: 'read', type: 'tool-call' },
          ]),
          parentId: 'instructions',
        },
      ],
    };
    const update = await live('child', [
      ['9', { args: { path: 'file' }, toolCallId: 'read-1', toolName: 'read' }],
      ['a', { result: { content: 'Actual file' }, toolCallId: 'read-1' }],
      ['0', 'Same evidence.'],
      finish,
    ]);
    const onNew = vi.fn(async () => undefined);
    const { result, rerender, unmount } = renderHook(
      (snapshot) => useDelegatedConversationRuntime({ history, onNew, update: snapshot }),
      { initialProps: update }
    );
    const messages = result.current.thread.getState().messages;
    expect(messages.map((message) => message.id)).toEqual(['instructions', 'prior']);
    expect(messages[1]?.content.map((part) => part.type)).toEqual([
      'text',
      'reasoning',
      'tool-call',
      'text',
    ]);
    expect(
      messages[1]?.content.filter((part) => part.type === 'text').map((part) => part.text)
    ).toEqual(['Same evidence.', 'Same evidence.']);
    expect(messages[1]?.content[2]).toMatchObject({
      args: { path: 'file' },
      result: { content: 'Actual file' },
      toolCallId: 'read-1',
    });
    rerender({ ...update, messageId: 'a-later-native-row' });
    expect(result.current.thread.getState().messages).toEqual(messages);
    unmount();
    expect(onNew).not.toHaveBeenCalled();
  });

  it('preserves inactive branches and gives the active head its live status without changing saved history', async () => {
    const history: History = {
      headId: 'active',
      messages: [
        { message: saved('user', 'Task', 'user'), parentId: null },
        { message: saved('inactive', 'Other branch'), parentId: 'user' },
        { message: saved('active', 'Before'), parentId: 'user' },
      ],
    };
    const update = await live('child', [['0', 'After']]);
    const running = {
      ...update,
      message: { ...update.message, status: { type: 'running' as const } },
    };
    const { result, rerender } = renderHook(
      (snapshot) =>
        useDelegatedConversationRuntime({
          history,
          onNew: async () => undefined,
          update: snapshot,
        }),
      { initialProps: running as DelegatedConversationUpdate }
    );
    expect(result.current.thread.getState().isRunning).toBe(true);
    expect(result.current.thread.getState().messages.at(-1)).toMatchObject({
      status: { type: 'running' },
    });
    expect(history.messages[2]?.message).toMatchObject({ status: { type: 'complete' } });
    const complete = await live('child', [['0', 'After'], finish]);
    rerender(complete);
    expect(result.current.thread.getState().isRunning).toBe(false);
    const exported = result.current.thread.export();
    expect(
      exported.messages.find(({ message }) => message.id === 'inactive')?.message.content
    ).toEqual(history.messages[1]?.message.content);
  });
});
