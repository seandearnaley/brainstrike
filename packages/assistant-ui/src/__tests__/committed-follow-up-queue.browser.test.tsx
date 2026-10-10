import '@testing-library/jest-dom/vitest';
// Must evaluate before anything that loads React DOM (see its header).
import './committed-assistant-browser-support';
import { TooltipProvider } from '@brainstrike/ui';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, onTestFinished, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { CommittedAssistantConversation } from '../committed-assistant-conversation';
import type { CommittedAssistantLogSourceSnapshot } from '../committed-assistant-log-store';
import type { CommittedAssistantCommands } from '../committed-assistant-store';
import {
  followUpQueueKey,
  resetFollowUpQueueStore,
  useFollowUpQueueStore,
} from '../follow-up-queue-store';
import {
  answerStepLength,
  committedRows,
  RecordedCommittedSource,
  recordedStore,
  recordedThreadId,
  settleFrames,
} from './committed-assistant-browser-support';
import '@brainstrike/ui/globals.css';
import '../overrides.css';
import './assistant-conversation-panel.browser.css';

/**
 * The committed (agent host) conversation owns its thread's follow-up queue:
 * a message written while the host's run is active waits as a chip and is sent
 * once the committed log finishes that run. The host still admits one active
 * run per thread; the queue only times the send.
 */

const LABEL = 'Committed conversation';
const QUEUED = 'Summarise the result next';

afterEach(() => {
  resetFollowUpQueueStore();
});

/** A remounted view's owner: loading until its subscription's replay arrives. */
class ReplayingSource extends RecordedCommittedSource {
  private loading = true;
  private readonly recorded = this.getSnapshot;
  override readonly getSnapshot = (): CommittedAssistantLogSourceSnapshot => ({
    ...this.recorded(),
    isLoading: this.loading,
  });

  replayed(length: number): void {
    this.loading = false;
    this.publishPrefix(length);
  }
}

async function mount(source: RecordedCommittedSource, onNew: CommittedAssistantCommands['onNew']) {
  const store = await recordedStore(source);
  onTestFinished(() => store.dispose());
  render(
    <TooltipProvider>
      <div style={{ height: 620, width: 900 }}>
        <CommittedAssistantConversation
          commands={{ onCancel: async () => undefined, onNew }}
          label={LABEL}
          store={store}
        />
      </div>
    </TooltipProvider>
  );
  const region = screen.getByRole('region', { name: LABEL });
  return { region, ui: within(region) };
}

test('a message written during an active committed run is queued and sent once at its committed finish', async () => {
  const onNew = vi.fn<CommittedAssistantCommands['onNew']>(async () => undefined);
  const source = new RecordedCommittedSource();
  source.publishPrefix(answerStepLength);
  const { ui } = await mount(source, onNew);
  const input = ui.getByRole('textbox', { name: 'Message input' });
  await act(async () => {
    input.focus();
    await userEvent.keyboard(QUEUED);
  });
  const queue = ui.getByRole('button', { name: 'Queue message to send after this run' });
  await act(async () => {
    await userEvent.click(queue);
  });
  const chips = ui.getByRole('list', { name: 'Queued follow-up messages' });
  expect(chips).toHaveTextContent(QUEUED);
  expect(input).toHaveValue('');
  await settleFrames();
  expect(onNew).not.toHaveBeenCalled();

  await act(async () => source.publishPrefix(committedRows.length));
  await waitFor(() => expect(onNew).toHaveBeenCalledOnce());
  expect(onNew).toHaveBeenCalledWith(
    expect.objectContaining({ content: [{ text: QUEUED, type: 'text' }], role: 'user' })
  );
  expect(ui.queryByRole('list', { name: 'Queued follow-up messages' })).toBeNull();
  await settleFrames();
  expect(onNew).toHaveBeenCalledOnce();
});

test('a queued message waits through replay loading and a replayed active run', async () => {
  const onNew = vi.fn<CommittedAssistantCommands['onNew']>(async () => undefined);
  useFollowUpQueueStore.getState().enqueue(followUpQueueKey(recordedThreadId), QUEUED);
  // Before the replay arrives, no run is visible.
  const source = new ReplayingSource();
  const { ui } = await mount(source, onNew);
  await settleFrames();
  expect(onNew).not.toHaveBeenCalled();

  await act(async () => source.replayed(answerStepLength));
  await settleFrames();
  expect(onNew).not.toHaveBeenCalled();
  expect(ui.getByRole('list', { name: 'Queued follow-up messages' })).toHaveTextContent(QUEUED);

  await act(async () => source.publishPrefix(committedRows.length));
  await waitFor(() => expect(onNew).toHaveBeenCalledOnce());
});
