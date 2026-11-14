// @vitest-environment jsdom
// BST-2536: Compact now, in the context meter's popover: the person's words for
// what to keep, sent with the run their view ends with; disabled while a run
// is going or the thread is rewound; the host's refusal shown as it is.
import { refusalError } from '@brainstrike/assistant-contract';
import { TooltipProvider } from '@brainstrike/ui';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommittedAssistantConversation } from '../committed-assistant-conversation';
import { resetContextUsageStore } from '../context-usage-store';
import type { ThreadCompaction } from '../thread-compaction';
import { PublishedConversation, viewMessage } from './committed-assistant-test-support';

afterEach(() => {
  cleanup();
  resetContextUsageStore();
});

function thread(compact?: ThreadCompaction) {
  const store = new PublishedConversation('root', [
    viewMessage('answer-1', [{ text: 'First answer', type: 'text' }]),
    viewMessage('answer-2', [{ text: 'Second answer', type: 'text' }]),
  ]);
  render(
    <TooltipProvider>
      <CommittedAssistantConversation
        commands={{ onNew: vi.fn() }}
        compactionTrigger={180_000}
        contextWindow={400_000}
        label="Conversation"
        store={store}
        {...(compact ? { compact } : {})}
      />
    </TooltipProvider>
  );
  return store;
}

/** The meter's popover, opened. */
async function popover() {
  fireEvent.click(await screen.findByTestId('context-usage-trigger'));
  return await screen.findByTestId('context-usage-popover');
}

describe('Compact now', () => {
  it('sends what the person wrote to keep, with the run their view ends with', async () => {
    const compact = vi.fn<ThreadCompaction>(async () => undefined);
    thread(compact);
    const panel = await popover();
    const field = within(panel).getByRole('textbox', { name: 'What to keep' });
    fireEvent.change(field, { target: { value: '  Keep the parser decision.  ' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Compact now' }));

    await waitFor(() =>
      expect(compact).toHaveBeenCalledWith({
        focus: 'Keep the parser decision.',
        parentMessageId: 'answer-2',
      })
    );
    await waitFor(() => expect(field).toHaveValue(''));

    fireEvent.click(within(panel).getByRole('button', { name: 'Compact now' }));
    await waitFor(() => expect(compact).toHaveBeenLastCalledWith({ parentMessageId: 'answer-2' }));
  });

  it('is disabled while a run is going and while the thread is rewound, with nothing added', async () => {
    const store = thread(vi.fn<ThreadCompaction>(async () => undefined));
    const panel = await popover();
    const button = within(panel).getByRole('button', { name: 'Compact now' });
    const field = within(panel).getByRole('textbox', { name: 'What to keep' });
    expect(button).toBeEnabled();
    const row = within(panel).getByTestId('context-usage-compact');
    const text = row.textContent;
    /** Nothing explains the disabled control: the row reads as before, and no notice joins it. */
    const unexplained = () => {
      expect(row.textContent).toBe(text);
      expect(within(panel).queryByRole('alert')).toBeNull();
    };

    act(() => store.publish({ isRunning: true }));
    expect(button).toBeDisabled();
    expect(field).toBeDisabled();
    unexplained();

    // A rewind moved the view's head back: a later message still follows it.
    act(() =>
      store.publish({
        isRunning: false,
        repository: { ...store.getSnapshot().repository, headId: 'answer-1' },
      })
    );
    expect(button).toBeDisabled();
    unexplained();
  });

  it('shows the host’s refusal, and keeps what the person wrote', async () => {
    const compact = vi.fn<ThreadCompaction>(async () => {
      throw refusalError(
        'conflict',
        'compaction.nothing-to-compact',
        'Nothing in this thread can be compacted yet.'
      );
    });
    thread(compact);
    const panel = await popover();
    const field = within(panel).getByRole('textbox', { name: 'What to keep' });
    fireEvent.change(field, { target: { value: 'Keep the parser decision.' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Compact now' }));

    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      'Nothing in this thread can be compacted yet.'
    );
    expect(field).toHaveValue('Keep the parser decision.');
  });

  it('is not offered where the thread’s owner gives no compaction', async () => {
    thread();
    const panel = await popover();
    expect(within(panel).queryByRole('button', { name: 'Compact now' })).toBeNull();
    expect(within(panel).queryByRole('textbox', { name: 'What to keep' })).toBeNull();
  });
});
