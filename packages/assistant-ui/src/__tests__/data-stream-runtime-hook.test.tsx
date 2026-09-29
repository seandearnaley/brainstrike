import {
  AssistantRuntimeProvider,
  ExportedMessageRepository,
  type ThreadHistoryAdapter,
  useAui,
  useAuiState,
} from '@assistant-ui/react';
import { ACTION_PAUSED_OWNER_MESSAGE_ID_KEY } from '@brainstrike/assistant-contract/approval-action-message';
import {
  TOOL_APPROVAL_DATA_NAME,
  TOOL_APPROVAL_RUN_CONFIG_KEY,
} from '@brainstrike/assistant-contract/tool-approval';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  async function renderActionCase(
    topologyWrite: Promise<void>,
    timeoutMs?: number,
    laterTurn = false,
    ownerCase: 'ambiguous' | 'missing' | 'single' = 'single'
  ) {
    const append = vi.fn<ThreadHistoryAdapter['append']>((item) => {
      if (!isActionRunConfig(item.runConfig)) {
        return Promise.resolve();
      }
      if (item.message.metadata.custom[ACTION_PAUSED_OWNER_MESSAGE_ID_KEY] === null) {
        return Promise.reject(new Error('invalid paused owner'));
      }
      return topologyWrite;
    });
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
                      toolCallId: ownerCase === 'missing' ? 'other-call' : 'call-1',
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
            ...(ownerCase === 'ambiguous'
              ? [
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
                          type: 'data' as const,
                        },
                      ],
                      id: 'paused-2',
                      role: 'assistant' as const,
                      status: { reason: 'tool-calls' as const, type: 'requires-action' as const },
                    },
                    parentId: 'paused-1',
                  },
                ]
              : []),
            ...(laterTurn
              ? [
                  {
                    message: {
                      content: [{ text: 'later prompt', type: 'text' as const }],
                      id: 'user-later',
                      role: 'user' as const,
                    },
                    parentId: 'paused-1',
                  },
                ]
              : []),
          ],
          { headId: laterTurn ? 'user-later' : ownerCase === 'ambiguous' ? 'paused-2' : 'paused-1' }
        ),
    };
    const fetchSpy = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
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
    await waitFor(() =>
      expect(screen.getByTestId('action-message-count')).toHaveTextContent(
        String(2 + Number(laterTurn) + Number(ownerCase === 'ambiguous'))
      )
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    });
    await waitFor(() =>
      expect(append.mock.calls.some(([item]) => isActionRunConfig(item.runConfig))).toBe(true)
    );
    return {
      append,
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

  it('carries an older paused owner through an echo appended at the later tail', async () => {
    const { append, fetchSpy } = await renderActionCase(Promise.resolve(), undefined, true);
    const actionItem = append.mock.calls.find(([item]) => isActionRunConfig(item.runConfig))?.[0];
    expect(actionItem?.parentId).toBe('user-later');
    expect(actionItem?.message.metadata.custom[ACTION_PAUSED_OWNER_MESSAGE_ID_KEY]).toBe(
      'paused-1'
    );
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
    const body = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body['pausedMessageId']).toBe('paused-1');
  });

  it.each(['missing', 'ambiguous'] as const)(
    'fails visibly without POST when the action owner is %s',
    async (ownerCase) => {
      const { append, fetchSpy } = await renderActionCase(
        Promise.resolve(),
        undefined,
        false,
        ownerCase
      );
      await waitFor(() =>
        expect(screen.getByTestId('last-message-status')).toHaveTextContent('incomplete')
      );
      const actionItem = append.mock.calls.find(([item]) => isActionRunConfig(item.runConfig))?.[0];
      expect(actionItem?.message.metadata.custom[ACTION_PAUSED_OWNER_MESSAGE_ID_KEY]).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  );

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
