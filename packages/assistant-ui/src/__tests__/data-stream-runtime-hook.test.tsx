import { AssistantRuntimeProvider, useAui } from '@assistant-ui/react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useBrainstrikeDataStreamRuntime } from '../data-stream-runtime';

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
  sendVersion = 0,
}: {
  onResponse: (response: Response) => void;
  sendVersion?: number;
}) {
  const runtime = useBrainstrikeDataStreamRuntime({
    api: 'http://assistant.test/api/assistant',
    onResponse,
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <EffectSender sendVersion={sendVersion} />
      <SendButton />
    </AssistantRuntimeProvider>
  );
}

describe('useBrainstrikeDataStreamRuntime', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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
