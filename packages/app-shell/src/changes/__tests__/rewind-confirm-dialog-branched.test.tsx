/**
 * The confirm modal over a host thread's port (BST-1977, gap 2): a host
 * rewind moves the conversation back and leaves the later turns on their own
 * branch, so every line the modal shows says where they went — never that
 * they are hidden or deleted.
 */
import { createTestActionRegistry } from '@brainstrike/context-actions';
import { AdaptersProvider } from '@brainstrike/file-explorer-hooks';
import type { FileSystemAdapter } from '@brainstrike/types';
import { ActionRegistryProvider, resetToastStore, Toaster } from '@brainstrike/ui';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { useChangesStore } from '../changes-store';
import type { ReadyRewindPreview, RewindPort } from '../rewind-port';
import { useRewindStore } from '../rewind-store';
import { RewindConfirmDialog } from '../ui/rewind-confirm-dialog';

vi.mock('../use-root-labels', () => ({ useRootLabelById: () => new Map() }));

/** A host thread's conversation-only target: two later turns, no file restore. */
const PREVIEW: ReadyRewindPreview = {
  changeset: null,
  conflicts: [],
  conversation: { kind: 'branched', turns: 2 },
  filesScope: { available: false, message: "This message's turn predates workspace snapshots" },
  messageId: 'message-2',
  noRecordedEdits: false,
  ok: true,
  previewId: null,
  restoreRoots: null,
  threadId: 'thread-1',
  view: null,
};

function hostPort(): RewindPort & { apply: ReturnType<typeof vi.fn> } {
  return {
    apply: vi.fn(async () => ({
      ok: true as const,
      value: {
        ok: true as const,
        outcome: { conversation: PREVIEW.conversation, notRestored: [], roots: [] },
        rewindId: 'rewind-1',
      },
    })),
    conversation: 'branched',
    fileDiff: vi.fn(),
    preview: vi.fn(async () => ({ ok: true as const, value: PREVIEW })),
    redo: vi.fn(),
  };
}

beforeEach(() => {
  useRewindStore.getState().reset();
  useChangesStore.getState().reset();
  resetToastStore();
  document.body.removeAttribute('style');
  document.body.removeAttribute('data-scroll-locked');
});

it('says the later turns leave the conversation for their branch, before and after applying', async () => {
  const user = userEvent.setup();
  const port = hostPort();
  useRewindStore.getState().openRewind({
    composerText: null,
    port,
    target: { messageId: 'message-2', threadId: 'thread-1' },
  });
  render(
    <AdaptersProvider
      fileSystemAdapter={
        {
          onWatcherHealth: () => () => undefined,
          platform: 'electron',
        } as unknown as FileSystemAdapter
      }
      storageAdapter={{} as never}
    >
      <ActionRegistryProvider registry={createTestActionRegistry().registry}>
        <RewindConfirmDialog />
        <Toaster />
      </ActionRegistryProvider>
    </AdaptersProvider>
  );

  expect(
    await screen.findByText(
      'The conversation returns to before this message. 2 turns leave this conversation; switch back to them with the branch picker.'
    )
  ).toBeInTheDocument();
  expect(
    screen.getByText(
      'Returns the conversation to before this message only. Nothing on disk is touched.'
    )
  ).toBeInTheDocument();
  expect(screen.queryByText(/hidden|deleted/i)).not.toBeInTheDocument();

  await user.click(screen.getByTestId('rewind-confirm'));
  expect(port.apply).toHaveBeenCalledWith({
    acknowledgeConflicts: false,
    mode: 'conversation-only',
    preview: PREVIEW,
  });
  expect(await screen.findByTestId('rewind-outcome-messages')).toHaveTextContent(
    '2 turns left this conversation; switch back to them with the branch picker.'
  );
  expect(screen.queryByText(/hidden|deleted/i)).not.toBeInTheDocument();
});
