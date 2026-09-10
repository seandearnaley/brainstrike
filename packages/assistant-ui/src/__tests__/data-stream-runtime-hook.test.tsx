import { AssistantRuntimeProvider, useAui } from '@assistant-ui/react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  onResponse,
  onDelegatedConversation,
  sendVersion = 0,
}: {
  onResponse: (response: Response) => void;
  onDelegatedConversation?: (update: DelegatedConversationUpdate) => void;
  sendVersion?: number;
}) {
  const runtime = useBrainstrikeDataStreamRuntime({
    api: 'http://assistant.test/api/assistant',
    onDelegatedConversation,
    onResponse,
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <EffectSender sendVersion={sendVersion} />
      <SendButton />
    </AssistantRuntimeProvider>
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('useBrainstrikeDataStreamRuntime', () => {
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
