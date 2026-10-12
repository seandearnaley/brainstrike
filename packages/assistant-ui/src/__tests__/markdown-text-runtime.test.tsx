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
import { AssistantMessageText } from '../assistant-message-text';

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

function AssistantTextHarness({ text }: { readonly text: string }) {
  const runtime = useLocalRuntime(chatModel, {
    initialMessages: [
      {
        content: [{ text, type: 'text' }],
        role: 'assistant',
        status: { reason: 'stop', type: 'complete' },
      },
    ],
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Messages
        components={{
          AssistantMessage: () => (
            <MessagePrimitive.Parts components={{ Text: AssistantMessageText }} />
          ),
          UserMessage: () => null,
        }}
      />
    </AssistantRuntimeProvider>
  );
}

describe('MarkdownText runtime integration', () => {
  it('shows HTML in model output as literal text instead of rendering it', async () => {
    // Streamdown's default pipeline renders raw HTML (sanitized). Model output
    // keeps the react-markdown behaviour: the markup is shown, never parsed.
    const { container } = render(
      <AssistantTextHarness text={'Before <b>bold</b> <img src="x" onerror="alert(1)"> after.'} />
    );

    const paragraph = await screen.findByText(/Before/u, undefined, { timeout: 10_000 });

    expect(paragraph).toHaveTextContent(
      'Before <b>bold</b> <img src="x" onerror="alert(1)"> after.'
    );
    expect(container.querySelector('.aui-md b, .aui-md img')).toBeNull();
  }, 15_000);

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
    // The inner findByText budget (10s) must fit inside the TEST deadline: with
    // vitest's 5s default this timed out on loaded runners before its own wait
    // could succeed.
  }, 15_000);
});
