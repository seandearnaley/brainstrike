// @vitest-environment jsdom
/**
 * Messages written while a committed run is active wait in assistant-ui's own
 * queue and are sent one per committed run end. Enter queues, Shift+Ctrl/⌘+Enter
 * steers (first in line, and the run is asked to stop at its next step), and
 * each waiting row can be steered, sent, pulled back to edit, or removed.
 * Driven through the shipped conversation over a published committed view.
 */
import '@testing-library/jest-dom/vitest';
import { type AppendMessage, MessageNotSentError } from '@assistant-ui/react';
import { act } from '@brainstrike/test-utils/react-act';
import { TooltipProvider } from '@brainstrike/ui';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApprovalDecisionMessage } from '../approval-decision-message';
import { CommittedAssistantConversation } from '../committed-assistant-conversation';
import { resetThreadMessageQueues } from '../thread-message-queue';
import { PublishedConversation } from './committed-assistant-test-support';
import { queuedPrompts, queueMessage } from './thread-message-queue-support';

const THREAD = 'run-controls';

const sentText = (message: AppendMessage): string =>
  message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');

/** A host whose every accepted send starts a run the test ends. */
function runningHost() {
  const store = new PublishedConversation(THREAD, []);
  store.publish({ isRunning: true });
  const sent: string[] = [];
  const onNew = vi.fn(async (message: AppendMessage) => {
    sent.push(sentText(message));
    store.publish({ isRunning: true });
  });
  const endRun = () =>
    act(async () => {
      store.publish({ isRunning: false });
    });
  return { endRun, onNew, sent, store };
}

function Conversation({
  onCancel,
  onNew,
  onSteer,
  store,
}: {
  readonly onCancel?: () => Promise<void>;
  readonly onNew: (message: AppendMessage) => Promise<void>;
  readonly onSteer?: () => Promise<boolean>;
  readonly store: PublishedConversation;
}) {
  return (
    <TooltipProvider>
      <CommittedAssistantConversation
        commands={{ onCancel: onCancel ?? (async () => undefined), onNew }}
        label="Run controls"
        onSteerActiveRun={onSteer}
        store={store}
      />
    </TooltipProvider>
  );
}

const input = () => screen.getByRole('textbox', { name: 'Message input' });
const queueList = () => screen.getByRole('list', { name: 'Queued follow-up messages' });

describe('composer run controls over the committed queue', () => {
  beforeAll(() => {
    // jsdom has no element scrolling; a shrinking queue re-pins a pinned thread.
    Element.prototype.scrollTo ??= () => undefined;
  });
  afterEach(() => {
    cleanup();
    resetThreadMessageQueues();
  });

  it('queues the draft on Enter and sends it once at the committed run end', async () => {
    const user = userEvent.setup();
    const host = runningHost();
    render(<Conversation onNew={host.onNew} store={host.store} />);
    await user.type(input(), 'then add tests{Enter}');

    expect(input()).toHaveValue('');
    expect(queueList()).toHaveTextContent('then add tests');
    expect(host.onNew).not.toHaveBeenCalled();

    await host.endRun();
    await waitFor(() => expect(host.sent).toEqual(['then add tests']));
    expect(screen.queryByRole('list', { name: 'Queued follow-up messages' })).toBeNull();
  });

  it('sends queued messages one per run end, in order', async () => {
    const user = userEvent.setup();
    const host = runningHost();
    render(<Conversation onNew={host.onNew} store={host.store} />);
    await user.type(input(), 'first{Enter}');
    await user.type(input(), 'second{Enter}');

    await host.endRun();
    await waitFor(() => expect(host.sent).toEqual(['first']));
    expect(queuedPrompts(THREAD)).toEqual(['second']);
    await host.endRun();
    await waitFor(() => expect(host.sent).toEqual(['first', 'second']));
  });

  it('advances on a run that starts and ends between two renders (BST-2207)', async () => {
    const user = userEvent.setup();
    const host = runningHost();
    render(<Conversation onNew={host.onNew} store={host.store} />);
    await user.type(input(), 'first{Enter}');
    await user.type(input(), 'second{Enter}');
    await host.endRun();
    await waitFor(() => expect(host.sent).toEqual(['first']));

    // The dispatched run is admitted and finishes before React renders it.
    await act(async () => {
      host.store.publish({ isRunning: true });
      host.store.publish({ isRunning: false });
    });
    await waitFor(() => expect(host.sent).toEqual(['first', 'second']));
  });

  it('steers on Shift+Ctrl+Enter: the draft goes first and the run is asked to stop', async () => {
    const user = userEvent.setup();
    const host = runningHost();
    const onSteer = vi.fn(async () => true);
    render(<Conversation onNew={host.onNew} onSteer={onSteer} store={host.store} />);
    await user.type(input(), 'earlier follow-up{Enter}');
    await user.type(input(), 'use the vendor primitive instead');
    await user.keyboard('{Shift>}{Control>}{Enter}{/Control}{/Shift}');

    expect(onSteer).toHaveBeenCalledOnce();
    expect(queuedPrompts(THREAD)).toEqual([
      'use the vendor primitive instead',
      'earlier follow-up',
    ]);
    expect(input()).toHaveValue('');
    await host.endRun();
    await waitFor(() => expect(host.sent).toEqual(['use the vendor primitive instead']));
  });

  it('keeps a steered message first in line when the steer request fails', async () => {
    const user = userEvent.setup();
    const host = runningHost();
    const onSteer = vi.fn(async () => {
      throw new Error('control endpoint down');
    });
    render(<Conversation onNew={host.onNew} onSteer={onSteer} store={host.store} />);
    await user.type(input(), 'steer this');
    await user.click(
      screen.getByRole('button', { name: 'Steer: send now, stopping the run at the next step' })
    );

    expect(queuedPrompts(THREAD)).toEqual(['steer this']);
    await host.endRun();
    await waitFor(() => expect(host.sent).toEqual(['steer this']));
  });

  it('steers an already-queued row by moving it to the front', async () => {
    const user = userEvent.setup();
    const host = runningHost();
    const onSteer = vi.fn(async () => true);
    render(<Conversation onNew={host.onNew} onSteer={onSteer} store={host.store} />);
    await user.type(input(), 'first{Enter}');
    await user.type(input(), 'second{Enter}');

    await user.click(screen.getByRole('button', { name: 'Steer now: second' }));
    expect(queuedPrompts(THREAD)).toEqual(['second', 'first']);
    expect(onSteer).toHaveBeenCalledOnce();
  });

  it('pulls a queued row back into an empty composer to edit, never over a draft', async () => {
    const user = userEvent.setup();
    const host = runningHost();
    render(<Conversation onNew={host.onNew} store={host.store} />);
    await user.type(input(), 'fix the typo{Enter}');
    await user.type(input(), 'unsent draft');
    const edit = within(queueList()).getByRole('button', {
      name: 'Edit queued message: fix the typo',
    });
    expect(edit).toBeDisabled();

    await user.clear(input());
    await user.click(edit);
    expect(queuedPrompts(THREAD)).toEqual([]);
    expect(input()).toHaveValue('fix the typo');
    expect(input()).toHaveFocus();
  });

  it('never sends a removed row', async () => {
    const user = userEvent.setup();
    const host = runningHost();
    render(<Conversation onNew={host.onNew} store={host.store} />);
    await user.type(input(), 'drop me{Enter}');
    await user.click(screen.getByRole('button', { name: 'Remove queued message' }));

    await host.endRun();
    expect(host.onNew).not.toHaveBeenCalled();
  });

  it('waits out a disconnect: an idle-looking view is not a committed run end', async () => {
    const user = userEvent.setup();
    const host = runningHost();
    render(<Conversation onNew={host.onNew} store={host.store} />);
    await user.type(input(), 'after the reconnect{Enter}');

    await act(async () => {
      host.store.publish({ connection: 'disconnected', isRunning: false });
    });
    expect(host.onNew).not.toHaveBeenCalled();
    // The replay shows the host run still active: still nothing is sent.
    await act(async () => {
      host.store.publish({ connection: 'connected', isRunning: true });
    });
    expect(host.onNew).not.toHaveBeenCalled();
    await host.endRun();
    await waitFor(() => expect(host.sent).toEqual(['after the reconnect']));
  });

  it('sends a message whose run ended while its thread was off screen', async () => {
    const user = userEvent.setup();
    const host = runningHost();
    const view = render(<Conversation onNew={host.onNew} store={host.store} />);
    await user.type(input(), 'sent on return{Enter}');
    view.unmount();

    host.store.publish({ isRunning: false });
    expect(host.onNew).not.toHaveBeenCalled();
    render(<Conversation onNew={host.onNew} store={host.store} />);
    await waitFor(() => expect(host.sent).toEqual(['sent on return']));
  });

  it('keeps the queue after Stop until the user sends a row', async () => {
    const user = userEvent.setup();
    const host = runningHost();
    render(<Conversation onNew={host.onNew} store={host.store} />);
    await user.type(input(), 'held after stop{Enter}');
    await user.click(screen.getByRole('button', { name: /^Stop/ }));
    await host.endRun();
    expect(host.onNew).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Send now: held after stop' }));
    await waitFor(() => expect(host.sent).toEqual(['held after stop']));
  });

  it('keeps a refused queued message in line and sendable', async () => {
    const user = userEvent.setup();
    const host = runningHost();
    host.onNew.mockRejectedValueOnce(new MessageNotSentError('host busy'));
    render(<Conversation onNew={host.onNew} store={host.store} />);
    await user.type(input(), 'retry me{Enter}');

    await host.endRun();
    await waitFor(() => expect(host.onNew).toHaveBeenCalledOnce());
    await waitFor(() => expect(queuedPrompts(THREAD)).toEqual(['retry me']));
    await user.click(await screen.findByRole('button', { name: 'Send now: retry me' }));
    await waitFor(() => expect(host.sent).toEqual(['retry me']));
  });

  it('still sends a held row after the conversation gets new commands', async () => {
    const user = userEvent.setup();
    const host = runningHost();
    const view = render(<Conversation onNew={host.onNew} store={host.store} />);
    await user.type(input(), 'held after stop{Enter}');
    await user.click(screen.getByRole('button', { name: /^Stop/ }));
    await host.endRun();
    view.rerender(<Conversation onNew={(message) => host.onNew(message)} store={host.store} />);

    await user.click(screen.getByRole('button', { name: 'Send now: held after stop' }));
    await waitFor(() => expect(host.sent).toEqual(['held after stop']));
  });

  it('drops a queued decision the host answered meanwhile', async () => {
    const host = runningHost();
    const request = {
      riskCategory: 'read',
      runId: 'root-run',
      toolCallId: 'call-1',
      toolName: 'brainstrike.grepSearch',
    } as const;
    queueMessage(THREAD, buildApprovalDecisionMessage(request, 'approve').message);
    render(<Conversation onNew={host.onNew} store={host.store} />);
    expect(queueList()).toHaveTextContent('Approved brainstrike.grepSearch.');

    await act(async () => {
      host.store.publish({
        repository: {
          headId: 'answered',
          messages: [
            {
              message: {
                content: [
                  {
                    data: { decision: 'approve', reason: 'session-grant', ...request },
                    name: 'brainstrike.tool-approval-answered',
                    type: 'data',
                  },
                ],
                createdAt: new Date(0),
                id: 'answered',
                metadata: {
                  custom: {},
                  steps: [],
                  unstable_annotations: [],
                  unstable_data: [],
                  unstable_state: null,
                },
                role: 'assistant',
                status: { reason: 'stop', type: 'complete' },
              },
              parentId: null,
            },
          ],
        },
      });
    });
    await waitFor(() => expect(queuedPrompts(THREAD)).toEqual([]));
    await host.endRun();
    expect(host.onNew).not.toHaveBeenCalled();
  });

  it('offers no Steer control without a steering transport', async () => {
    const user = userEvent.setup();
    const host = runningHost();
    render(<Conversation onNew={host.onNew} store={host.store} />);
    await user.type(input(), 'queued{Enter}');
    expect(screen.queryByRole('button', { name: /^Steer/ })).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Queue message to send after this run' })
    ).toBeDisabled();
  });
});
