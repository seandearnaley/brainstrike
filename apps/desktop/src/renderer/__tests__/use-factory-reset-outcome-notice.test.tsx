// @vitest-environment jsdom

import type { WorktreeResetOutcome } from '@brainstrike/types';
import { resetToastStore, Toaster } from '@brainstrike/ui';
import { render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { VisibleDesktopElectronApi } from '../../types/desktop-electron-api';
import { useFactoryResetOutcomeNotice } from '../use-factory-reset-outcome-notice';

/**
 * ADR-0034: Factory Reset archives the managed worktrees before it deletes their ledger. The
 * window that asked is replaced before the reset answers, so the replacement window tells the
 * person what became of them.
 */
function installOutcome(outcome: WorktreeResetOutcome | null) {
  const takeWorktreeOutcome = vi.fn(async () => outcome);
  window.electronAPI = {
    factoryReset: {
      resetLocal: async () => ({ success: true }),
      takeWorktreeOutcome,
      unavailableReason: undefined,
    },
  } as unknown as VisibleDesktopElectronApi;
  return takeWorktreeOutcome;
}

function Window() {
  useFactoryResetOutcomeNotice();
  return <Toaster />;
}

afterEach(() => {
  Reflect.deleteProperty(window, 'electronAPI');
  resetToastStore();
});

const ARCHIVED = {
  path: '/home/tester/.brainstrike/worktrees/app/swift-badger',
  snapshotRef: 'refs/brainstrike/worktree-archive/wt-1',
  worktreeId: 'wt-1',
};

it('names each worktree the reset left on disk, with why, and where the archived work is', async () => {
  installOutcome({
    archived: [ARCHIVED],
    retained: [
      {
        code: 'worktree.locked',
        path: '/home/tester/.brainstrike/worktrees/app/calm-otter',
        reason: 'This worktree is locked.',
        worktreeId: 'wt-2',
      },
      {
        code: 'worktree.run-active',
        path: '/home/tester/.brainstrike/worktrees/app/bold-heron',
        reason: 'A run is active in this worktree.',
        worktreeId: 'wt-3',
      },
    ],
    status: 'archived',
  });

  render(<Window />);

  expect(await screen.findByText('Factory reset left 2 worktrees on disk')).toBeVisible();
  expect(
    screen.getByText('/home/tester/.brainstrike/worktrees/app/calm-otter: This worktree is locked.')
  ).toBeVisible();
  expect(
    screen.getByText(
      '/home/tester/.brainstrike/worktrees/app/bold-heron: A run is active in this worktree.'
    )
  ).toBeVisible();
  expect(
    screen.getByText(
      "1 worktree was archived: its work is in its repository's refs/brainstrike/worktree-archive/* and its branch."
    )
  ).toBeVisible();
});

it('says why the reset could not archive the managed worktrees', async () => {
  installOutcome({ reason: 'The agent host is not running.', status: 'failed' });

  render(<Window />);

  expect(await screen.findByText('Factory reset could not archive your worktrees')).toBeVisible();
  expect(
    screen.getByText(
      'The agent host is not running. Their folders are still on disk, outside the app.'
    )
  ).toBeVisible();
});

it('says only how many were archived when none was left', async () => {
  installOutcome({
    archived: [ARCHIVED, { ...ARCHIVED, worktreeId: 'wt-4' }],
    retained: [],
    status: 'archived',
  });

  render(<Window />);

  expect(await screen.findByText('2 worktrees archived into their repositories')).toBeVisible();
});

it('shows nothing after a reset with no managed worktrees, or none at all', async () => {
  const empty = installOutcome({ archived: [], retained: [], status: 'archived' });
  const { unmount } = render(<Window />);
  await vi.waitFor(() => expect(empty).toHaveBeenCalledOnce());
  unmount();
  const none = installOutcome(null);
  render(<Window />);
  await vi.waitFor(() => expect(none).toHaveBeenCalledOnce());

  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.queryByText(/worktree/u)).toBeNull();
});
