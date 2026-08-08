import { AssistantRuntimeProvider, useAui } from '@assistant-ui/react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

function RuntimeHarness({ onResponse }: { onResponse: (response: Response) => void }) {
  const runtime = useBrainstrikeDataStreamRuntime({
    api: 'http://assistant.test/api/assistant',
    onResponse,
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
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
});
