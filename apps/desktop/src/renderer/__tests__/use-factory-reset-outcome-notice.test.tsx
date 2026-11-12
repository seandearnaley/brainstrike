// @vitest-environment jsdom

import type { ResetOutcome } from '@brainstrike/types';
import { resetToastStore, Toaster } from '@brainstrike/ui';
import { render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { VisibleDesktopElectronApi } from '../../types/desktop-electron-api';
import { useFactoryResetOutcomeNotice } from '../use-factory-reset-outcome-notice';

/**
 * ADR-0034: Factory Reset and Clear Database archive the managed worktrees before they delete
 * their ledger, and Clear Database moves the scratch folders to the Trash. The window that asked
 * is replaced before the reset answers, so the replacement window tells the person what became
 * of them.
 */
function installOutcome(outcome: ResetOutcome | null) {
  const takeResetOutcome = vi.fn(async () => outcome);
  window.electronAPI = {
    factoryReset: {
      resetLocal: async () => ({ success: true }),
      takeResetOutcome,
      unavailableReason: undefined,
    },
  } as unknown as VisibleDesktopElectronApi;
  return takeResetOutcome;
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
const SCRATCH = '/home/tester/Library/Application Support/Brainstrike/scratch';

it('names each worktree the reset left on disk, with why, and where the archived work is', async () => {
  installOutcome({
    managedWorktrees: {
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
    },
    mode: 'factory',
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
  installOutcome({
    managedWorktrees: { reason: 'The agent host is not running.', status: 'failed' },
    mode: 'factory',
  });

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
    managedWorktrees: {
      archived: [ARCHIVED, { ...ARCHIVED, worktreeId: 'wt-4' }],
      retained: [],
      status: 'archived',
    },
    mode: 'factory',
  });

  render(<Window />);

  expect(await screen.findByText('2 worktrees archived into their repositories')).toBeVisible();
});

it('shows nothing after a reset with no managed worktrees, or none at all', async () => {
  const empty = installOutcome({
    managedWorktrees: { archived: [], retained: [], status: 'archived' },
    mode: 'factory',
  });
  const { unmount } = render(<Window />);
  await vi.waitFor(() => expect(empty).toHaveBeenCalledOnce());
  unmount();
  const none = installOutcome(null);
  render(<Window />);
  await vi.waitFor(() => expect(none).toHaveBeenCalledOnce());

  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.queryByText(/worktree/u)).toBeNull();
});

it('names the worktrees and each scratch folder Clear Database left on disk, with why', async () => {
  installOutcome({
    managedWorktrees: {
      archived: [],
      retained: [
        {
          code: 'worktree.locked',
          path: '/home/tester/.brainstrike/worktrees/app/calm-otter',
          reason: 'This worktree is locked.',
          worktreeId: 'wt-2',
        },
      ],
      status: 'archived',
    },
    mode: 'content',
    scratchFolders: {
      retained: [
        {
          path: `${SCRATCH}/quiet-otter`,
          reason: `${SCRATCH}/quiet-otter was not moved to the Trash: Failed to move item to the trash`,
        },
      ],
      status: 'trashed',
      trashed: [`${SCRATCH}/brave-heron`, `${SCRATCH}/swift-lark`],
    },
  });

  render(<Window />);

  expect(await screen.findByText('Clearing content left 1 worktree on disk')).toBeVisible();
  expect(
    screen.getByText('/home/tester/.brainstrike/worktrees/app/calm-otter: This worktree is locked.')
  ).toBeVisible();
  expect(screen.getByText('Clearing content left 1 scratch folder on disk')).toBeVisible();
  expect(
    screen.getByText(
      `${SCRATCH}/quiet-otter was not moved to the Trash: Failed to move item to the trash`
    )
  ).toBeVisible();
  expect(screen.getByText('2 scratch folders were moved to the Trash.')).toBeVisible();
});

it('says why Clear Database could not move the scratch folders to the Trash', async () => {
  installOutcome({
    managedWorktrees: { archived: [], retained: [], status: 'archived' },
    mode: 'content',
    scratchFolders: { reason: `EACCES: permission denied, scandir '${SCRATCH}'`, status: 'failed' },
  });

  render(<Window />);

  expect(
    await screen.findByText('Clearing content could not move your scratch folders to the Trash')
  ).toBeVisible();
  expect(
    screen.getByText(
      `EACCES: permission denied, scandir '${SCRATCH}' Their folders are still on disk, outside the app.`
    )
  ).toBeVisible();
});

it('says how many scratch folders went to the Trash when none was left', async () => {
  installOutcome({
    managedWorktrees: { archived: [ARCHIVED], retained: [], status: 'archived' },
    mode: 'content',
    scratchFolders: { retained: [], status: 'trashed', trashed: [`${SCRATCH}/brave-heron`] },
  });

  render(<Window />);

  expect(await screen.findByText('1 worktree archived into its repository')).toBeVisible();
  expect(screen.getByText('1 scratch folder moved to the Trash')).toBeVisible();
});
