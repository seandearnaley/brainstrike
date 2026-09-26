import {
  AssistantRuntimeProvider,
  ExportedMessageRepository,
  type ThreadHistoryAdapter,
  useAui,
  useAuiState,
} from '@assistant-ui/react';
import {
  TOOL_APPROVAL_DATA_NAME,
  TOOL_APPROVAL_RUN_CONFIG_KEY,
} from '@brainstrike/assistant-contract/tool-approval';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode, useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isActionRunConfig } from '../approval-action-message';
import { useBrainstrikeDataStreamRuntime } from '../data-stream-runtime';
import type { DelegatedConversationUpdate } from '../delegated-conversation-receiver';

function SendButton() {
  const aui = useAui();
  return (
    <button
      onClick={() =>
        aui.thread().append({ content: [{ text: 'send', type: 'text' }], role: 'user' })
      }
      type="button"
    >
      Send
    </button>
  );
}

function LastMessageStatus() {
  const status = useAuiState((state) => state.thread.messages.at(-1)?.status);
  return <output data-testid="last-message-status">{JSON.stringify(status)}</output>;
}

function EffectSender({ sendVersion }: { sendVersion: number }) {
  const aui = useAui();
  useEffect(() => {
    if (sendVersion === 0) {
      return;
    }
    aui.thread().append({ content: [{ text: 'send', type: 'text' }], role: 'user' });
  }, [aui, sendVersion]);
  return null;
}

function RuntimeHarness({
  onActivity,
  onFinish,
  onResponse,
  onDelegatedConversation,
  sendVersion = 0,
}: {
  onActivity?: () => void;
  onFinish?: () => void;
  onResponse: (response: Response) => void;
  onDelegatedConversation?: (update: DelegatedConversationUpdate) => void;
  sendVersion?: number;
}) {
  const runtime = useBrainstrikeDataStreamRuntime({
    api: 'http://assistant.test/api/assistant',
    ...(onActivity ? { onActivity } : {}),
    onDelegatedConversation,
    ...(onFinish ? { onFinish } : {}),
    onResponse,
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <EffectSender sendVersion={sendVersion} />
      <SendButton />
      <LastMessageStatus />
    </AssistantRuntimeProvider>
  );
}

afterEach(() => vi.unstubAllGlobals());

it('does not install a child receiver when a callback appears after the run started', async () => {
  let source: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      source = controller;
      controller.enqueue(new TextEncoder().encode('f:{"messageId":"root"}\n0:"Started."\n'));
    },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body))
  );
  const onActivity = vi.fn();
  const onFinish = vi.fn();
  const onResponse = vi.fn();
  const childCallback = vi.fn();
  const props = { onActivity, onFinish, onResponse };
  const { rerender } = render(<RuntimeHarness {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(onActivity).toHaveBeenCalled());
  rerender(<RuntimeHarness {...props} onDelegatedConversation={childCallback} />);
  const finish = { finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
  const envelope = {
    data: {
      frames: [
        { code: 'f', value: { messageId: 'native-child' } },
        { code: '0', value: 'Child answer.' },
        { code: 'd', value: finish },
      ],
      identity: {
        childRuntimeRunId: 'child',
        parentRuntimeRunId: 'parent',
        parentToolCallId: 'call',
        personaId: 'explorer',
      },
      messageId: 'native-child',
    },
    name: 'brainstrike.delegated-conversation',
  };
  source?.enqueue(
    new TextEncoder().encode(`aui-data:${JSON.stringify(envelope)}\nd:${JSON.stringify(finish)}\n`)
  );
  source?.close();
  await waitFor(() => expect(onFinish).toHaveBeenCalledOnce());
  expect(childCallback).not.toHaveBeenCalled();
});

describe('useBrainstrikeDataStreamRuntime', () => {
  async function renderActionCase(topologyWrite: Promise<void>, timeoutMs?: number) {
    const append = vi.fn<ThreadHistoryAdapter['append']>((item) =>
      isActionRunConfig(item.runConfig) ? topologyWrite : Promise.resolve()
    );
    const history: ThreadHistoryAdapter = {
      append,
      load: async () =>
        ExportedMessageRepository.fromBranchableArray(
          [
            {
              message: {
                content: [{ text: 'prompt', type: 'text' }],
                id: 'user-1',
                role: 'user',
              },
              parentId: null,
            },
            {
              message: {
                content: [
                  {
                    data: {
                      runId: 'native-1',
                      toolCallId: 'call-1',
                      toolName: 'shell.tool',
                    },
                    name: TOOL_APPROVAL_DATA_NAME,
                    type: 'data',
                  },
                ],
                id: 'paused-1',
                role: 'assistant',
                status: { reason: 'tool-calls', type: 'requires-action' },
              },
              parentId: 'user-1',
            },
          ],
          { headId: 'paused-1' }
        ),
    };
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('f:{"messageId":"reply"}\n'));
              controller.enqueue(
                new TextEncoder().encode(
                  'd:{"finishReason":"stop","usage":{"inputTokens":1,"outputTokens":1},"path":[]}\n'
                )
              );
              controller.close();
            },
          })
        )
    );
    vi.stubGlobal('fetch', fetchSpy);
    function ActionSender() {
      const aui = useAui();
      const messageCount = useAuiState((state) => state.thread.messages.length);
      return (
        <>
          <output data-testid="action-message-count">{messageCount}</output>
          <button
            onClick={() => {
              void Promise.resolve(
                aui.thread().append({
                  content: [{ text: 'Approved shell.tool.', type: 'text' }],
                  role: 'user',
                  runConfig: {
                    custom: {
                      [TOOL_APPROVAL_RUN_CONFIG_KEY]: {
                        action: 'approve',
                        runId: 'native-1',
                        toolCallId: 'call-1',
                        toolName: 'shell.tool',
                      },
                    },
                  },
                })
              ).catch(() => undefined);
            }}
            type="button"
          >
            Approve
          </button>
        </>
      );
    }
    function ActionRuntime({ historyAdapter }: { historyAdapter: ThreadHistoryAdapter }) {
      const runtime = useBrainstrikeDataStreamRuntime({
        adapters: { history: historyAdapter },
        api: 'http://assistant.test/api/assistant',
        ...(timeoutMs === undefined ? {} : { requestPreparationTimeoutMs: timeoutMs }),
      });
      return (
        <AssistantRuntimeProvider runtime={runtime}>
          <ActionSender />
          <LastMessageStatus />
        </AssistantRuntimeProvider>
      );
    }
    const view = render(
      <StrictMode>
        <ActionRuntime historyAdapter={history} />
      </StrictMode>
    );
    await waitFor(() => expect(screen.getByTestId('action-message-count')).toHaveTextContent('2'));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(append.mock.calls.some(([item]) => isActionRunConfig(item.runConfig))).toBe(true)
    );
    return {
      changeHistory: () =>
        view.rerender(
          <StrictMode>
            <ActionRuntime historyAdapter={{ ...history }} />
          </StrictMode>
        ),
      fetchSpy,
    };
  }

  it('waits for the exact action echo topology write before POST', async () => {
    let commit!: () => void;
    const topologyWrite = new Promise<void>((resolve) => {
      commit = resolve;
    });
    const { fetchSpy } = await renderActionCase(topologyWrite);
    expect(fetchSpy).not.toHaveBeenCalled();
    commit();
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
  });

  it('fails visibly before POST when an action history write times out', async () => {
    let finishLate!: () => void;
    const topologyWrite = new Promise<void>((resolve) => {
      finishLate = resolve;
    });
    const { fetchSpy } = await renderActionCase(topologyWrite, 20);
    await waitFor(() =>
      expect(screen.getByTestId('last-message-status')).toHaveTextContent('incomplete')
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    finishLate();
    await Promise.resolve();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails visibly before POST when an action history write rejects', async () => {
    let fail!: (reason: Error) => void;
    const topologyWrite = new Promise<void>((_resolve, reject) => {
      fail = reject;
    });
    const { fetchSpy } = await renderActionCase(topologyWrite);
    fail(new Error('topology write failed'));
    await waitFor(() =>
      expect(screen.getByTestId('last-message-status')).toHaveTextContent('incomplete')
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails the old action before POST when its history scope changes', async () => {
    let finishLate!: () => void;
    const topologyWrite = new Promise<void>((resolve) => {
      finishLate = resolve;
    });
    const { changeHistory, fetchSpy } = await renderActionCase(topologyWrite);
    changeHistory();
    await waitFor(() =>
      expect(screen.getByTestId('last-message-status')).toHaveTextContent('incomplete')
    );
    finishLate();
    await Promise.resolve();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('settles a rejected admission visibly through a real local append', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: 'assistant_admission_rejected',
              message: 'Assistant stream failed.',
            }),
            { status: 500 }
          )
      )
    );
    render(<RuntimeHarness onResponse={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(screen.getByTestId('last-message-status')).toHaveTextContent(
        'assistant_admission_rejected'
      )
    );
    expect(screen.getByTestId('last-message-status')).toHaveTextContent('incomplete');
  });

  it('uses the latest committed callback without recreating the runtime', async () => {
    const firstOnResponse = vi.fn();
    const secondOnResponse = vi.fn();
    const encoder = new TextEncoder();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(encoder.encode('f:{"messageId":"message-1"}\n'));
                controller.enqueue(encoder.encode('0:"Done"\n'));
                controller.enqueue(
                  encoder.encode(
                    'd:{"finishReason":"stop","usage":{"inputTokens":1,"outputTokens":1},"path":[]}\n'
                  )
                );
                controller.close();
              },
            })
          )
      )
    );
    const { rerender } = render(<RuntimeHarness onResponse={firstOnResponse} />);

    rerender(<RuntimeHarness onResponse={secondOnResponse} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(secondOnResponse).toHaveBeenCalledOnce();
    });
    expect(firstOnResponse).not.toHaveBeenCalled();
  });

  it('updates callbacks before a descendant passive effect starts a run', async () => {
    const firstOnResponse = vi.fn();
    const secondOnResponse = vi.fn();
    const encoder = new TextEncoder();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(encoder.encode('f:{"messageId":"message-1"}\n'));
                controller.enqueue(encoder.encode('0:"Done"\n'));
                controller.enqueue(
                  encoder.encode(
                    'd:{"finishReason":"stop","usage":{"inputTokens":1,"outputTokens":1},"path":[]}\n'
                  )
                );
                controller.close();
              },
            })
          )
      )
    );
    const { rerender } = render(<RuntimeHarness onResponse={firstOnResponse} sendVersion={0} />);

    rerender(<RuntimeHarness onResponse={secondOnResponse} sendVersion={1} />);

    await waitFor(() => {
      expect(secondOnResponse).toHaveBeenCalledOnce();
    });
    expect(firstOnResponse).not.toHaveBeenCalled();
  });
});

it('forwards the latest child callback through the stable hook adapter', async () => {
  const first = vi.fn();
  const second = vi.fn();
  const finish = { finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
  const envelope = {
    data: {
      frames: [
        { code: 'f', value: { messageId: 'native-child' } },
        { code: '0', value: 'Child answer.' },
        { code: 'd', value: finish },
      ],
      identity: {
        childRuntimeRunId: 'child',
        parentRuntimeRunId: 'parent',
        parentToolCallId: 'call',
        personaId: 'explorer',
      },
      messageId: 'native-child',
    },
    name: 'brainstrike.delegated-conversation',
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          `f:{"messageId":"root"}\naui-data:${JSON.stringify(envelope)}\nd:${JSON.stringify(finish)}\n`
        )
    )
  );
  const onResponse = vi.fn();
  const { rerender } = render(
    <RuntimeHarness onDelegatedConversation={first} onResponse={onResponse} />
  );
  rerender(<RuntimeHarness onDelegatedConversation={second} onResponse={onResponse} />);
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() =>
    expect(second).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({ status: expect.objectContaining({ type: 'complete' }) }),
      })
    )
  );
  expect(first).not.toHaveBeenCalled();
});

it('delivers child updates to a callback replaced while a run is active', async () => {
  const first = vi.fn();
  const second = vi.fn();
  const finish = { finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
  const envelope = (frames: readonly { code: string; value: unknown }[]): string =>
    `aui-data:${JSON.stringify({
      data: {
        frames,
        identity: {
          childRuntimeRunId: 'child',
          parentRuntimeRunId: 'parent',
          parentToolCallId: 'call',
          personaId: 'explorer',
        },
        messageId: 'native-child',
      },
      name: 'brainstrike.delegated-conversation',
    })}\n`;
  let source: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      source = controller;
      controller.enqueue(
        new TextEncoder().encode(
          'f:{"messageId":"root"}\n' +
            envelope([
              { code: 'f', value: { messageId: 'native-child' } },
              { code: '0', value: 'Before.' },
            ])
        )
      );
    },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body))
  );
  const onResponse = vi.fn();
  const { rerender } = render(
    <RuntimeHarness onDelegatedConversation={first} onResponse={onResponse} />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() =>
    expect(first).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          parts: expect.arrayContaining([expect.objectContaining({ text: 'Before.' })]),
        }),
      })
    )
  );
  rerender(<RuntimeHarness onDelegatedConversation={second} onResponse={onResponse} />);
  const firstCount = first.mock.calls.length;
  source?.enqueue(
    new TextEncoder().encode(
      `${envelope([
        { code: '0', value: 'After.' },
        { code: 'd', value: finish },
      ])}d:${JSON.stringify(finish)}\n`
    )
  );
  source?.close();
  await waitFor(() =>
    expect(second).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({ status: expect.objectContaining({ type: 'complete' }) }),
      })
    )
  );
  expect(first).toHaveBeenCalledTimes(firstCount);
});
