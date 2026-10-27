// @vitest-environment jsdom
/**
 * The composer while a run is active: Enter queues the draft, Shift+Ctrl/⌘+Enter
 * steers it, and each queued row can be steered, pulled back to edit, or
 * removed — through the real panel over a running external-store runtime.
 */
import '@testing-library/jest-dom/vitest';
import {
  type ExternalStoreAdapter,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from '@assistant-ui/react';
import { TooltipProvider } from '@brainstrike/ui';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssistantConversationPanel } from '../assistant-conversation-panel';
import { resetFollowUpQueueStore, useFollowUpQueueStore } from '../follow-up-queue-store';

const THREAD = 'run-controls';

function RunningConversation({
  onNew,
  onSteer,
}: {
  readonly onNew: ExternalStoreAdapter<ThreadMessageLike>['onNew'];
  readonly onSteer?: () => Promise<boolean>;
}) {
  const runtime = useExternalStoreRuntime({
    convertMessage: (value: ThreadMessageLike) => value,
    isRunning: true,
    messages: [{ content: [{ text: 'Working…', type: 'text' }], id: 'a1', role: 'assistant' }],
    onCancel: async () => undefined,
    onNew,
  });
  return (
    <TooltipProvider>
      <AssistantConversationPanel
        label="Run controls"
        onSteerActiveRun={onSteer}
        ownsFollowUpQueue
        runtime={runtime}
        threadKey={THREAD}
      />
    </TooltipProvider>
  );
}

const queued = () => useFollowUpQueueStore.getState().queuedByThread[THREAD]?.map((i) => i.text);

describe('composer run controls', () => {
  afterEach(() => {
    cleanup();
    resetFollowUpQueueStore();
  });

  it('queues the draft on Enter instead of sending over the run', async () => {
    const user = userEvent.setup();
    const onNew = vi.fn(async () => undefined);
    render(<RunningConversation onNew={onNew} />);
    const input = screen.getByRole('textbox', { name: 'Message input' });
    await user.type(input, 'then add tests{Enter}');

    expect(queued()).toEqual(['then add tests']);
    expect(input).toHaveValue('');
    expect(onNew).not.toHaveBeenCalled();
    expect(screen.getByRole('list', { name: 'Queued follow-up messages' })).toHaveTextContent(
      'then add tests'
    );
  });

  it('steers on Shift+Ctrl+Enter: the draft jumps the queue and the run is asked to stop', async () => {
    const user = userEvent.setup();
    const onSteer = vi.fn(async () => true);
    useFollowUpQueueStore.getState().enqueue(THREAD, 'earlier follow-up');
    render(<RunningConversation onNew={async () => undefined} onSteer={onSteer} />);
    const input = screen.getByRole('textbox', { name: 'Message input' });
    await user.type(input, 'use the vendor primitive instead');
    await user.keyboard('{Shift>}{Control>}{Enter}{/Control}{/Shift}');

    expect(onSteer).toHaveBeenCalledTimes(1);
    expect(queued()).toEqual(['use the vendor primitive instead', 'earlier follow-up']);
    expect(input).toHaveValue('');
  });

  it('steers an already-queued row by moving it to the front', async () => {
    const user = userEvent.setup();
    const onSteer = vi.fn(async () => true);
    useFollowUpQueueStore.getState().enqueue(THREAD, 'first');
    useFollowUpQueueStore.getState().enqueue(THREAD, 'second');
    render(<RunningConversation onNew={async () => undefined} onSteer={onSteer} />);

    await user.click(screen.getByRole('button', { name: 'Steer now: second' }));
    expect(queued()).toEqual(['second', 'first']);
    expect(onSteer).toHaveBeenCalledTimes(1);
  });

  it('pulls a queued row back into an empty composer to edit it', async () => {
    const user = userEvent.setup();
    useFollowUpQueueStore.getState().enqueue(THREAD, 'fix the typo');
    render(<RunningConversation onNew={async () => undefined} />);
    const list = screen.getByRole('list', { name: 'Queued follow-up messages' });

    await user.click(
      within(list).getByRole('button', { name: 'Edit queued message: fix the typo' })
    );
    expect(queued()).toEqual([]);
    const input = screen.getByRole('textbox', { name: 'Message input' });
    expect(input).toHaveValue('fix the typo');
    expect(input).toHaveFocus();
  });

  it('will not pull a row back over a draft the user is still writing', async () => {
    const user = userEvent.setup();
    useFollowUpQueueStore.getState().enqueue(THREAD, 'queued text');
    render(<RunningConversation onNew={async () => undefined} />);
    await user.type(screen.getByRole('textbox', { name: 'Message input' }), 'unsent draft');

    expect(screen.getByRole('button', { name: 'Edit queued message: queued text' })).toBeDisabled();
  });

  it('offers no Steer control without a steering transport', () => {
    useFollowUpQueueStore.getState().enqueue(THREAD, 'queued');
    render(<RunningConversation onNew={async () => undefined} />);
    expect(screen.queryByRole('button', { name: /^Steer/ })).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Queue message to send after this run' })
    ).toBeDisabled();
  });
});
