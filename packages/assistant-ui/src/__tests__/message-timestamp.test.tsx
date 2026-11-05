import {
  AssistantRuntimeProvider,
  type ChatModelAdapter,
  type ThreadMessageLike,
  ThreadPrimitive,
  useLocalRuntime,
} from '@assistant-ui/react';
import { TooltipProvider } from '@brainstrike/ui';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AssistantActionBar } from '../assistant-action-bar';
import { UserActionBar } from '../assistant-ui-panel';

const chatModel: ChatModelAdapter = {
  run: vi.fn().mockResolvedValue({ content: [], status: { reason: 'stop', type: 'complete' } }),
};

const FIVE_MINUTES_AGO = new Date(Date.now() - 5 * 60_000 - 5000);
const YESTERDAY = new Date(Date.now() - 26 * 3_600_000);

const question = (createdAt: Date): ThreadMessageLike => ({
  content: [{ text: 'Question', type: 'text' }],
  createdAt,
  role: 'user',
});
const answer = (createdAt: Date): ThreadMessageLike => ({
  content: [{ text: 'Answer', type: 'text' }],
  createdAt,
  role: 'assistant',
  status: { reason: 'stop', type: 'complete' },
});

// The bars show for the last message without hover (`autohide="not-last"`).
function Harness({ messages }: { readonly messages: readonly ThreadMessageLike[] }) {
  const runtime = useLocalRuntime(chatModel, { initialMessages: messages });
  return (
    <TooltipProvider>
      <AssistantRuntimeProvider runtime={runtime}>
        <ThreadPrimitive.Messages
          components={{ AssistantMessage: AssistantActionBar, UserMessage: UserActionBar }}
        />
      </AssistantRuntimeProvider>
    </TooltipProvider>
  );
}

describe('message timestamps', () => {
  it('shows when an answer was sent as a relative time in its action bar', async () => {
    render(<Harness messages={[question(YESTERDAY), answer(FIVE_MINUTES_AGO)]} />);

    const time = await screen.findByText('5 minutes ago');
    expect(time.tagName).toBe('TIME');
    expect(time).toHaveAttribute('datetime', FIVE_MINUTES_AGO.toISOString());
  });

  it('opens the full date from the keyboard', async () => {
    render(<Harness messages={[question(YESTERDAY), answer(FIVE_MINUTES_AGO)]} />);
    const time = await screen.findByText('5 minutes ago');

    // Tab through the bars until the time takes focus, or focus runs out.
    const user = userEvent.setup();
    for (let step = 0; step < 10 && document.activeElement !== time; step += 1) {
      await user.tab();
    }

    expect(time).toHaveFocus();
    expect(await screen.findByRole('tooltip')).toBeInTheDocument();
  });

  it('shows when a question was sent in its action bar', async () => {
    render(<Harness messages={[question(YESTERDAY)]} />);

    const time = await screen.findByText('yesterday');
    expect(time).toHaveAttribute('datetime', YESTERDAY.toISOString());
  });
});
