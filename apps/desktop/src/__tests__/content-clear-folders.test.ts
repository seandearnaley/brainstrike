import { describe, expect, it, vi } from 'vitest';
import { createDesktopFactoryResetHandler } from '../desktop-reset-platform';

const prepareDatabaseProfileReset = vi.fn(async () => ({
  clearRootContents: async () => undefined,
  isReleased: false,
  release: () => undefined,
  root: '/mock/profile',
}));

// ADR-0015, ADR-0034: Clear Database deletes the worktree ledger and every scratch thread's row,
// but both kinds of folder live on disk. The worktrees are archived while the host still serves
// the ledger; the scratch folders go to the Trash only once their rows are gone.
describe('Clear Database and the folders the app made', () => {
  const ARCHIVED = {
    path: '/home/tester/.brainstrike/worktrees/app/swift-badger',
    snapshotRef: 'refs/brainstrike/worktree-archive/wt-1',
    worktreeId: 'wt-1',
  };
  const LOCKED = {
    code: 'worktree.locked',
    path: '/home/tester/.brainstrike/worktrees/app/calm-otter',
    reason: 'This worktree is locked.',
    worktreeId: 'wt-2',
  };
  const SCRATCH = '/retained/profile/scratch';

  async function contentClear(
    options: {
      archiveManagedWorktrees?: () => Promise<never>;
      clearRetainedContent?: () => Promise<void>;
      trashScratchFolders?: () => Promise<never>;
    } = {}
  ) {
    const order: string[] = [];
    const takenByReplacement: unknown[] = [];
    const handleReset = createDesktopFactoryResetHandler({
      archiveManagedWorktrees:
        options.archiveManagedWorktrees ??
        (async () => {
          order.push('archive-worktrees');
          return { ok: true as const, value: { archived: [ARCHIVED], retained: [LOCKED] } };
        }),
      clearRetainedContent:
        options.clearRetainedContent ??
        (async () => {
          order.push('clear-content');
        }),
      completeSuccessfulReset: async (_signal, mode) => {
        order.push(`replace:${mode}`);
        takenByReplacement.push(handleReset.takeResetOutcome());
      },
      logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn() },
      prepareDatabaseProfileReset,
      resetLocalDatabase: vi.fn(async () => undefined),
      resumeAfterReset: async (outcome) => {
        order.push(`resume:${outcome}`);
      },
      runtimes: [
        {
          name: 'sources',
          stop: async () => undefined,
          stopForContent: async () => {
            order.push('stop');
          },
        },
      ],
      sessionDataPath: '/retained/session',
      trashScratchFolders:
        options.trashScratchFolders ??
        (async () => {
          order.push('trash-scratch');
          return {
            retained: [
              {
                path: `${SCRATCH}/quiet-otter`,
                reason: `${SCRATCH}/quiet-otter was not moved to the Trash: Failed to move item to the trash`,
              },
            ],
            trashed: [`${SCRATCH}/brave-heron`],
          };
        }),
      userDataPath: '/retained/profile',
    });
    const result = await handleReset.clearContent();
    return { handleReset, order, result, takenByReplacement };
  }

  it('archives the worktrees before the clear, and moves the scratch folders to the Trash after it', async () => {
    const { handleReset, order, result, takenByReplacement } = await contentClear();

    expect(order).toEqual([
      'stop',
      'archive-worktrees',
      'clear-content',
      'trash-scratch',
      'replace:content',
      'resume:succeeded',
    ]);
    const outcome = {
      managedWorktrees: { archived: [ARCHIVED], retained: [LOCKED], status: 'archived' },
      scratchFolders: {
        retained: [
          {
            path: `${SCRATCH}/quiet-otter`,
            reason: `${SCRATCH}/quiet-otter was not moved to the Trash: Failed to move item to the trash`,
          },
        ],
        status: 'trashed',
        trashed: [`${SCRATCH}/brave-heron`],
      },
    };
    expect(result).toEqual({ ...outcome, success: true });
    // The window that asked is replaced before the clear answers it: its replacement takes this.
    expect(takenByReplacement).toEqual([{ ...outcome, mode: 'content' }]);
    expect(handleReset.takeResetOutcome()).toBeNull();
  });

  it('never moves a scratch folder to the Trash when the clear fails', async () => {
    const trashScratchFolders = vi.fn(async (): Promise<never> => {
      throw new Error('a scratch folder was trashed after a failed clear');
    });

    const { handleReset, order, result } = await contentClear({
      clearRetainedContent: async () => {
        throw new Error('The host did not report its content clear');
      },
      trashScratchFolders,
    });

    expect(result).toEqual({
      message: 'The host did not report its content clear',
      success: false,
    });
    expect(trashScratchFolders).not.toHaveBeenCalled();
    expect(order).toEqual(['stop', 'archive-worktrees', 'resume:failed']);
    expect(handleReset.takeResetOutcome()).toBeNull();
  });

  it('completes the clear, and says why, when the worktrees or the scratch folders could not be handled', async () => {
    const { order, result, takenByReplacement } = await contentClear({
      archiveManagedWorktrees: async () => {
        throw new Error('The agent host is not running.');
      },
      trashScratchFolders: async () => {
        throw new Error(`EACCES: permission denied, scandir '${SCRATCH}'`);
      },
    });

    const outcome = {
      managedWorktrees: { reason: 'The agent host is not running.', status: 'failed' },
      scratchFolders: {
        reason: `EACCES: permission denied, scandir '${SCRATCH}'`,
        status: 'failed',
      },
    };
    expect(result).toEqual({ ...outcome, success: true });
    expect(order).toEqual(['stop', 'clear-content', 'replace:content', 'resume:succeeded']);
    expect(takenByReplacement).toEqual([{ ...outcome, mode: 'content' }]);
  });
});
