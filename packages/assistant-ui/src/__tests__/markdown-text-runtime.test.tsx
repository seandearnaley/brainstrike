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
import { AssistantMessageText, preloadMarkdownText } from '../assistant-message-text';

// The markdown renderer behind AssistantMessageText is a lazily imported chunk.
// Loaded while this file is collected, which no timeout bounds, it renders in
// the first commit. Loaded inside a test, it outlasted that test's wait on a
// loaded machine (BST-2491).
await preloadMarkdownText();

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
  it('shows HTML in model output as literal text instead of rendering it', () => {
    // Streamdown's default pipeline renders raw HTML (sanitized). Model output
    // keeps the react-markdown behaviour: the markup is shown, never parsed.
    const { container } = render(
      <AssistantTextHarness text={'Before <b>bold</b> <img src="x" onerror="alert(1)"> after.'} />
    );

    expect(screen.getByText(/Before/u)).toHaveTextContent(
      'Before <b>bold</b> <img src="x" onerror="alert(1)"> after.'
    );
    expect(container.querySelector('.aui-md b, .aui-md img')).toBeNull();
  });

  it('renders reasoning parts through the real assistant-ui text hook', () => {
    render(<AssistantReasoningHarness />);

    expect(screen.getByText('Plan a short reply.')).toBeInTheDocument();
    expect(screen.getByText('Visible answer.')).toBeInTheDocument();
    expect(screen.queryByTestId('assistant-thinking-indicator')).not.toBeInTheDocument();
  });
});
