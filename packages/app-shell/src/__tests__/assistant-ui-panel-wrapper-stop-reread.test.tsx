/**
 * The wrapper half of the root Stop re-read's composer-draft carry (BST-1749).
 *
 * A Stop that cancelled an undecided pause re-reads history by REMOUNTING the
 * panel's runtime, which discards the live composer. The wrapper carries the
 * draft across that remount through the thread-scoped command store the prompt
 * library already uses — never the global rewind slot, which no open thread
 * owns (owner ruling 2026-09-15). The panel half lives in assistant-ui's
 * `root-stop-rediscovers-approvals.behavior.test.tsx`.
 */
import './assistant-ui-panel-wrapper-test-support';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test } from 'vitest';
import { useAssistantComposerCommandStore } from '../assistant-composer-command-store';
import { renderAssistantThreadPanel } from './assistant-ui-panel-wrapper-test-support';

describe('AssistantUiPanelWrapper — Stop re-read draft carry', () => {
  test('carries the live composer draft into the thread that re-reads after a Stop', async () => {
    const user = userEvent.setup();
    useAssistantComposerCommandStore.getState().enqueue({
      mode: 'replace',
      text: 'Another thread is mid-sentence.',
      threadId: 'thread-other',
    });

    await renderAssistantThreadPanel(['openai'], 'thread-active');
    await screen.findByTestId('assistant-ui-panel');

    await act(async () => {
      await user.click(screen.getByTestId('report-composer-text'));
    });
    await act(async () => {
      await user.click(screen.getByTestId('trigger-stop-reread'));
    });

    // The draft reaches the remounted thread as its own replace command.
    await waitFor(() =>
      expect(screen.getByTestId('composer-draft-command-text')).toHaveTextContent(
        'Live composer draft'
      )
    );
    expect(screen.getByTestId('composer-draft-command-mode')).toHaveTextContent('replace');

    // Only this thread's queue moved. The harness mounts ONE wrapper per
    // render, so the other thread is asserted through the shared store rather
    // than a second mounted composer.
    expect(
      useAssistantComposerCommandStore.getState().commandsByThreadId['thread-active']
    ).toHaveLength(1);
    expect(
      useAssistantComposerCommandStore.getState().commandsByThreadId['thread-other']
    ).toHaveLength(1);
    expect(
      useAssistantComposerCommandStore.getState().commandsByThreadId['thread-other']?.[0]?.text
    ).toBe('Another thread is mid-sentence.');

    // Applied once: the wrapper acknowledges it, so a later mount cannot replay it.
    await act(async () => {
      await user.click(screen.getByTestId('apply-composer-draft-command'));
    });
    expect(
      useAssistantComposerCommandStore.getState().commandsByThreadId['thread-active']
    ).toBeUndefined();
  });
});
