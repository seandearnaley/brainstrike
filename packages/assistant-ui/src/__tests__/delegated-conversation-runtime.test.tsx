// @vitest-environment jsdom
import { fromThreadMessageLike, type ThreadMessageLike } from '@assistant-ui/react';
import type { AssistantUiThreadHistoryAdapter } from '@brainstrike/assistant-contract';
import { TooltipProvider } from '@brainstrike/ui';
import { cleanup, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  type AssistantMessage,
  AssistantMessageAccumulator,
  DataStreamDecoder,
} from 'assistant-stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssistantConversationPanel } from '../assistant-conversation-panel';
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

function BranchedConversation({
  history,
  onBranch,
}: {
  readonly history: History;
  readonly onBranch: NonNullable<Parameters<typeof useDelegatedConversationRuntime>[0]['onBranch']>;
}) {
  const runtime = useDelegatedConversationRuntime({
    history,
    onBranch,
    onNew: async () => undefined,
  });
  return (
    <TooltipProvider>
      <AssistantConversationPanel label="Cedar" runtime={runtime} threadKey="child" />
    </TooltipProvider>
  );
}
afterEach(cleanup);

describe('shared child conversation runtime', () => {
  it('keeps human follow-ups between the child replies through the shared runtime', async () => {
    const history: History = {
      headId: 'task',
      messages: [{ message: saved('task', 'Inspect', 'user'), parentId: null }],
    };
    const update = await live('child', [
      ['0', 'Before input.'],
      [
        'aui-data',
        {
          data: {
            createdAt: '2026-09-11T21:00:00.000Z',
            id: 'human-input',
            text: 'Check the second file.',
          },
          name: 'brainstrike.child-user-message',
        },
      ],
      ['0', 'After input.'],
      finish,
    ]);
    const onNew = vi.fn(async () => {});
    const { result, rerender } = renderHook(
      (snapshot) => useDelegatedConversationRuntime({ history, onNew, update: snapshot }),
      { initialProps: update }
    );
    expect(
      result.current.thread.getState().messages.map((message) => ({
        content: message.content.map((part) =>
          part.type === 'text' ? { text: part.text, type: part.type } : { type: part.type }
        ),
        role: message.role,
      }))
    ).toEqual([
      { content: [{ text: 'Inspect', type: 'text' }], role: 'user' },
      { content: [{ text: 'Before input.', type: 'text' }], role: 'assistant' },
      { content: [{ text: 'Check the second file.', type: 'text' }], role: 'user' },
      { content: [{ text: 'After input.', type: 'text' }], role: 'assistant' },
    ]);
    expect(
      result.current.thread
        .getState()
        .messages.find((message) => message.id === 'human-input')
        ?.createdAt.toISOString()
    ).toBe('2026-09-11T21:00:00.000Z');
    const previous = result.current.thread.getState().messages;
    rerender({ ...update, messageId: 'later-native-row' });
    expect(result.current.thread.getState().messages).toEqual(previous);
    expect(onNew).not.toHaveBeenCalled();
  });

  it('retains live image-only child input in the ordinary user transcript across replay', async () => {
    const update = await live('child', [
      [
        'aui-data',
        {
          data: {
            attachments: [
              {
                data: 'data:image/png;base64,aW1hZ2U=',
                filename: 'evidence.png',
                mediaType: 'image/png',
                type: 'file',
              },
            ],
            createdAt: '2026-09-12T12:00:00Z',
            id: 'image-input',
            text: '',
          },
          name: 'brainstrike.child-user-message',
        },
      ],
      ['0', 'Image inspected.'],
      finish,
    ]);
    const onNew = vi.fn(async () => {});
    const { result, rerender } = renderHook(
      (snapshot) =>
        useDelegatedConversationRuntime({ history: { messages: [] }, onNew, update: snapshot }),
      { initialProps: update }
    );
    const input = () =>
      result.current.thread.getState().messages.find((message) => message.id === 'image-input');
    expect(input()?.content).toMatchObject([
      { image: 'data:image/png;base64,aW1hZ2U=', type: 'image' },
    ]);
    rerender({ ...update });
    expect(input()?.content).toMatchObject([
      { image: 'data:image/png;base64,aW1hZ2U=', type: 'image' },
    ]);
    expect(onNew).not.toHaveBeenCalled();
  });

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

  it('dispatches Retry from the shared conversation DOM with the exact durable answer', async () => {
    const history: History = {
      headId: 'answer',
      messages: [
        { message: saved('prompt', 'Inspect the first file', 'user'), parentId: null },
        { message: saved('answer', 'The first result'), parentId: 'prompt' },
      ],
    };
    const onBranch = vi.fn<NonNullable<Parameters<typeof BranchedConversation>[0]['onBranch']>>(
      async () => undefined
    );
    render(<BranchedConversation history={history} onBranch={onBranch} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Regenerate response' }));
    await waitFor(() => expect(onBranch).toHaveBeenCalledTimes(1));
    expect(onBranch.mock.calls[0]?.[0]).toMatchObject({
      branch: { kind: 'retry', messageId: 'answer' },
      text: 'Retry the selected child answer.',
    });
  });

  it('dispatches Edit from the shared conversation DOM with the exact durable prompt', async () => {
    const history: History = {
      headId: 'answer',
      messages: [
        { message: saved('prompt', 'Inspect the first file', 'user'), parentId: null },
        { message: saved('answer', 'The first result'), parentId: 'prompt' },
      ],
    };
    const onBranch = vi.fn<NonNullable<Parameters<typeof BranchedConversation>[0]['onBranch']>>(
      async () => undefined
    );
    render(<BranchedConversation history={history} onBranch={onBranch} />);
    const user = userEvent.setup();

    const prompt = document.querySelector('[data-message-id="prompt"]');
    if (!prompt) {
      throw new Error('Missing durable child prompt row.');
    }
    await user.hover(prompt);
    await user.click(screen.getByRole('button', { name: 'Edit message' }));
    const editor = screen.getByDisplayValue('Inspect the first file');
    await user.clear(editor);
    await user.type(editor, 'Inspect the second file');
    const editForm = editor.closest('form');
    if (!editForm) {
      throw new Error('Missing child edit composer.');
    }
    await user.click(within(editForm).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(onBranch).toHaveBeenCalledOnce());
    expect(onBranch.mock.calls[0]?.[0]).toMatchObject({
      branch: { kind: 'edit', messageId: 'prompt' },
      text: 'Inspect the second file',
    });
  });
});
