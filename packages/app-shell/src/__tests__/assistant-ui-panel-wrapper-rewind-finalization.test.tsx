/**
 * The wrapper half of Conversation Rewind finalization (BST-1115, W5 T4b).
 *
 * `use-rewind-finalization.test.ts` proves the hook's conjunction in isolation.
 * This proves the WIRING: that the composer submit really reaches
 * `markUserAuthoredSend`, that the finalization really rides the run-creation
 * seam, and — the part that cannot be tested in the hook alone — that a
 * finalization which never settles does not stall `prepareRequestData`, which
 * the send is genuinely blocked on.
 */
import './assistant-ui-panel-wrapper-test-support';
import { useAssistantPreferencesStore } from '@brainstrike/app-state/stores/assistant-preferences-store';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ChangesBridge } from '../changes/changes-bridge';
import {
  preparedRequestDataLog,
  renderAssistantPanel,
} from './assistant-ui-panel-wrapper-test-support';

function installChangesBridge(
  finalizeRewinds: ChangesBridge['finalizeRewinds']
): ReturnType<typeof vi.fn> {
  const spy = vi.fn(finalizeRewinds);
  (window as unknown as { changes?: ChangesBridge }).changes = {
    applyRewind: vi.fn(),
    fileDiff: vi.fn(),
    finalizeRewinds: spy as unknown as ChangesBridge['finalizeRewinds'],
    inventory: vi.fn(),
    redoRewind: vi.fn(),
    resolveView: vi.fn(),
    rewindPreview: vi.fn(),
  } as unknown as ChangesBridge;
  return spy;
}

const NOTHING_OUTSTANDING = {
  ok: true,
  value: { deletedMessageIds: [], finalized: false, rewindIds: [] },
} as const;

beforeEach(() => {
  preparedRequestDataLog.length = 0;
  useAssistantPreferencesStore.setState((state) => ({
    ...state,
    selectedModel: 'openai::gpt-5.2',
    selectedProvider: 'openai',
  }));
});

afterEach(() => {
  Reflect.deleteProperty(window as unknown as { changes?: unknown }, 'changes');
});

describe('AssistantUiPanelWrapper — rewind finalization', () => {
  test('finalizes the thread when a composer submit is followed by a run creation', async () => {
    const user = userEvent.setup();
    const finalizeRewinds = installChangesBridge(async () => NOTHING_OUTSTANDING);

    await renderAssistantPanel(['openai'], async () => {
      await waitFor(() => expect(screen.getByTestId('assistant-ui-panel')).toBeInTheDocument());
      await user.click(screen.getByTestId('submit-thread-run'));
      await user.click(screen.getByTestId('prepare-thread-request'));
    });

    await waitFor(() => expect(finalizeRewinds).toHaveBeenCalledTimes(1));
    expect(finalizeRewinds.mock.calls[0]?.[0]).toEqual({ threadId: expect.any(String) });
  });

  // A tool-approval resume prepares a request WITHOUT a composer submit. It is
  // not a new user message, so it must not close the redo window.
  test('does NOT finalize for a run prepared without a composer submit', async () => {
    const user = userEvent.setup();
    const finalizeRewinds = installChangesBridge(async () => NOTHING_OUTSTANDING);

    await renderAssistantPanel(['openai'], async () => {
      await waitFor(() => expect(screen.getByTestId('assistant-ui-panel')).toBeInTheDocument());
      await user.click(screen.getByTestId('prepare-thread-request'));
    });

    await waitFor(() => expect(preparedRequestDataLog).toHaveLength(1));
    expect(finalizeRewinds).not.toHaveBeenCalled();
  });

  // assistant-ui submits the composer form on Enter even when there is nothing
  // to send. A submit alone must not finalize.
  test('does NOT finalize for a composer submit that prepares no request', async () => {
    const user = userEvent.setup();
    const finalizeRewinds = installChangesBridge(async () => NOTHING_OUTSTANDING);

    await renderAssistantPanel(['openai'], async () => {
      await waitFor(() => expect(screen.getByTestId('assistant-ui-panel')).toBeInTheDocument());
      await user.click(screen.getByTestId('submit-thread-run'));
    });

    expect(finalizeRewinds).not.toHaveBeenCalled();
  });

  // THE SEND IS NEVER BLOCKED. `prepareRequestData` is what the composer
  // awaits before the request goes out; a finalization that never answers (a
  // wedged main process, a slow delete) must not hold it.
  test('resolves the prepared request while the finalization is still in flight', async () => {
    const user = userEvent.setup();
    const finalizeRewinds = installChangesBridge(() => new Promise<never>(() => undefined));

    await renderAssistantPanel(['openai'], async () => {
      await waitFor(() => expect(screen.getByTestId('assistant-ui-panel')).toBeInTheDocument());
      await user.click(screen.getByTestId('submit-thread-run'));
      await user.click(screen.getByTestId('prepare-thread-request'));
    });

    await waitFor(() => expect(preparedRequestDataLog).toHaveLength(1));
    expect(preparedRequestDataLog[0]).toMatchObject({ memory: expect.any(Object) });
    expect(finalizeRewinds).toHaveBeenCalledTimes(1);
  });

  // A failing finalization is reported (the hook logs + toasts) but the
  // prepared request still lands: the user's message is not hostage to a
  // cleanup they never asked for.
  test('still resolves the prepared request when the finalization fails', async () => {
    const user = userEvent.setup();
    const finalizeRewinds = installChangesBridge(async () => {
      throw new Error('preload detached');
    });

    await renderAssistantPanel(['openai'], async () => {
      await waitFor(() => expect(screen.getByTestId('assistant-ui-panel')).toBeInTheDocument());
      await user.click(screen.getByTestId('submit-thread-run'));
      await user.click(screen.getByTestId('prepare-thread-request'));
    });

    await waitFor(() => expect(preparedRequestDataLog).toHaveLength(1));
    expect(preparedRequestDataLog[0]).not.toMatchObject({ error: expect.any(String) });
    expect(finalizeRewinds).toHaveBeenCalledTimes(1);
  });
});
