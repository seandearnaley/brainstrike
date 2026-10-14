/**
 * Retiring Main's tombstone finalizer must leave request preparation intact.
 * The retired method is a negative-control spy: no send or resume may call it.
 * Host branch changes still advance the existing hydration generation.
 */
import './assistant-ui-panel-wrapper-test-support';
import { useAssistantPreferencesStore } from '@brainstrike/app-state/stores/assistant-preferences-store';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ChangesBridge } from '../changes/changes-bridge';
import { useRewindStore } from '../changes/rewind-store';
import {
  preparedRequestDataLog,
  renderAssistantPanel,
} from './assistant-ui-panel-wrapper-test-support';

function installChangesBridge(finalizeRewinds: () => Promise<unknown>): ReturnType<typeof vi.fn> {
  const spy = vi.fn(finalizeRewinds);
  (window as unknown as { changes?: ChangesBridge }).changes = {
    applyRewind: vi.fn(),
    fileDiff: vi.fn(),
    finalizeRewinds: spy,
    inventory: vi.fn(),
    onInvalidated: vi.fn(() => () => {}),
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
  useRewindStore.getState().reset();
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

describe('AssistantUiPanelWrapper — host rewind ownership', () => {
  test('prepares a new run without dispatching retired rewind finalization', async () => {
    const user = userEvent.setup();
    const finalizeRewinds = installChangesBridge(async () => NOTHING_OUTSTANDING);

    await renderAssistantPanel(['openai'], async () => {
      await waitFor(() => expect(screen.getByTestId('assistant-ui-panel')).toBeInTheDocument());
      await user.click(screen.getByTestId('submit-thread-run'));
      await user.click(screen.getByTestId('prepare-thread-request'));
    });

    await waitFor(() => expect(preparedRequestDataLog).toHaveLength(1));
    expect(finalizeRewinds).not.toHaveBeenCalled();
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

  // A stale bridge with an unavailable retired method must not stall Send.
  test('prepares the request without invoking an unavailable retired finalizer', async () => {
    const user = userEvent.setup();
    const finalizeRewinds = installChangesBridge(() => new Promise<never>(() => undefined));

    await renderAssistantPanel(['openai'], async () => {
      await waitFor(() => expect(screen.getByTestId('assistant-ui-panel')).toBeInTheDocument());
      await user.click(screen.getByTestId('submit-thread-run'));
      await user.click(screen.getByTestId('prepare-thread-request'));
    });

    await waitFor(() => expect(preparedRequestDataLog).toHaveLength(1));
    expect(preparedRequestDataLog[0]).toMatchObject({ memory: expect.any(Object) });
    expect(finalizeRewinds).not.toHaveBeenCalled();
  });

  // A stale bridge with a throwing retired method must not affect Send.
  test('prepares the request without invoking a throwing retired finalizer', async () => {
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
    expect(finalizeRewinds).not.toHaveBeenCalled();
  });

  /**
   * The wrapper half of the re-hydration seam (BST-1115). `rewind-store.test.ts`
   * pins the counter and `rewind-history-generation.behavior.test.tsx` pins what
   * the panel does with it; this pins the WIRE between them, which is the link
   * that was missing entirely — a rewind changed the branch and the live
   * thread went on rendering the previous branch.
   */
  test('forwards the rewind re-hydration counter to the panel', async () => {
    installChangesBridge(async () => NOTHING_OUTSTANDING);

    await renderAssistantPanel(['openai'], async () => {
      const panel = await waitFor(() => screen.getByTestId('assistant-ui-panel'));
      expect(panel).toHaveAttribute('data-history-generation', '0');

      act(() => useRewindStore.getState().markRewindApplied());

      await waitFor(() =>
        expect(screen.getByTestId('assistant-ui-panel')).toHaveAttribute(
          'data-history-generation',
          '1'
        )
      );
    });
  });
});
