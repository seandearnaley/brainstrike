import {
  type AppendMessage,
  AssistantRuntimeProvider,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from '@assistant-ui/react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ThreadMessagesRegion } from '../assistant-thread-messages';
import { ThreadScrollFollowProvider } from '../thread-scroll-follow';

const noopNew = (_message: AppendMessage): Promise<void> => Promise.resolve();
const convertMessage = (message: ThreadMessageLike): ThreadMessageLike => message;
const COMPONENTS = {
  AssistantMessage: () => <p>Answer</p>,
  UserMessage: () => <p>Question</p>,
};
const HISTORY: readonly ThreadMessageLike[] = [
  { content: [{ text: 'Question', type: 'text' }], id: 'user-1', role: 'user' },
];

function Harness({
  isLoading,
  messages,
}: {
  readonly isLoading: boolean;
  readonly messages: readonly ThreadMessageLike[];
}) {
  const runtime = useExternalStoreRuntime({ convertMessage, isLoading, messages, onNew: noopNew });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadScrollFollowProvider>
        <ThreadMessagesRegion components={COMPONENTS} />
      </ThreadScrollFollowProvider>
    </AssistantRuntimeProvider>
  );
}

describe('opening a thread', () => {
  it('shows placeholder messages and a busy transcript while its history loads', () => {
    render(<Harness isLoading messages={[]} />);

    expect(screen.getByTestId('thread-history-skeleton')).toBeInTheDocument();
    expect(screen.getByTestId('assistant-ui-viewport')).toHaveAttribute('aria-busy', 'true');
  });

  it('replaces the placeholders with the history once it arrives', () => {
    const { rerender } = render(<Harness isLoading messages={[]} />);

    rerender(<Harness isLoading={false} messages={HISTORY} />);

    expect(screen.queryByTestId('thread-history-skeleton')).not.toBeInTheDocument();
    expect(screen.getByTestId('assistant-ui-viewport')).not.toHaveAttribute('aria-busy');
    expect(screen.getByText('Question')).toBeInTheDocument();
  });

  it('shows an empty loaded thread as empty, not loading', () => {
    render(<Harness isLoading={false} messages={[]} />);

    expect(screen.queryByTestId('thread-history-skeleton')).not.toBeInTheDocument();
  });
});
