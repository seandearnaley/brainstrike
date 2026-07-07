import {
  AssistantRuntimeProvider,
  type ChatModelAdapter,
  MessagePrimitive,
  type ThreadMessageLike,
  ThreadPrimitive,
  useLocalRuntime,
} from '@assistant-ui/react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AssistantMessageText } from '../assistant-ui-panel/assistant-message-text';

vi.mock('@assistant-ui/react-markdown/styles/dot.css', () => ({}));

const chatModel: ChatModelAdapter = {
  run: vi.fn().mockResolvedValue({
    content: [],
    status: { reason: 'stop', type: 'complete' },
  }),
};

const initialMessages: readonly ThreadMessageLike[] = [
  {
    content: [
      { text: 'Plan a short reply.', type: 'reasoning' },
      { text: 'Visible answer.', type: 'text' },
    ],
    role: 'assistant',
    status: { reason: 'stop', type: 'complete' },
  },
];

function AssistantReasoningHarness() {
  const runtime = useLocalRuntime(chatModel, { initialMessages });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Messages
        components={{
          AssistantMessage: () => (
            <MessagePrimitive.Parts
              components={{
                Reasoning: AssistantMessageText,
                Text: AssistantMessageText,
              }}
            />
          ),
          UserMessage: () => null,
        }}
      />
    </AssistantRuntimeProvider>
  );
}

describe('MarkdownText runtime integration', () => {
  it('renders reasoning parts through the real assistant-ui text hook', async () => {
    render(<AssistantReasoningHarness />);

    // The markdown renderer behind AssistantMessageText is lazy-loaded; on a
    // loaded CI runner the dynamic import can exceed findByText's default 1s
    // deadline while the Suspense "Loading message…" placeholder is shown.
    expect(
      await screen.findByText('Plan a short reply.', undefined, { timeout: 10_000 })
    ).toBeInTheDocument();
    expect(screen.getByText('Visible answer.')).toBeInTheDocument();
    expect(screen.queryByTestId('assistant-thinking-indicator')).not.toBeInTheDocument();
  });
});
