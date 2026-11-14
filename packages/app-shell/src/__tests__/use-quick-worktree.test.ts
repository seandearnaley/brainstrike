/**
 * New worktree… in one click (ADR-0034, BST-2506): the where-control's row makes
 * the worktree at once with the defaults Automatic isolation uses, and moves the
 * thread into it as the create sheet's Create does. While the repository's setup
 * script has no answer it creates nothing and asks for the sheet, so the script
 * is never skipped silently. Its own file because `use-worktree-mode.test.ts` is
 * at the line-count ceiling.
 */
import { act } from '@brainstrike/test-utils/react-act';
import { DEFAULT_WORKTREE_BASE_REF, WORKTREE_BRANCH_PREFIX } from '@brainstrike/types';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorktreeMode } from '../hooks/use-worktree-mode';
import { gitFailure } from './helpers/git-failure';
import { stubWorktreesBridge, workspaceGitWrapper } from './helpers/workspace-git-services-wrapper';

const { addRootByPathSpy, createContextSpy, createSpy, getSettingsSpy, listSpy, toastSpy } =
  vi.hoisted(() => ({
    addRootByPathSpy: vi.fn(),
    createContextSpy: vi.fn(),
    createSpy: vi.fn(),
    getSettingsSpy: vi.fn(),
    listSpy: vi.fn(),
    toastSpy: vi.fn(),
  }));

const wrapper = workspaceGitWrapper({
  worktrees: stubWorktreesBridge({
    create: createSpy,
    createContext: createContextSpy,
    getSettings: getSettingsSpy,
    list: listSpy,
  }),
});
vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  useFileSystem: () => ({
    addRootDirectory: vi.fn(),
    addRootDirectoryByPath: addRootByPathSpy,
  }),
}));
vi.mock('@brainstrike/ui', () => ({ toast: toastSpy }));

const RUN_IN_PROGRESS = "Available when this thread's run ends.";
const onSelectWorktree = vi.fn(() => Promise.resolve());
const ARGS = {
  checkout: { branch: null, mode: 'local' as const, worktreeId: null, worktreePath: null },
  isRepository: true,
  onHandOffToLocal: vi.fn(() => Promise.resolve()),
  onSelectWorktree,
  primaryRootId: 'r-1',
  primaryRootPath: '/work/app',
  statusFailure: null,
  threadId: 'thread-1',
  threadState: 'idle' as const,
  uncommittedChanges: false,
};

/** The host's create context, with the repository's setup script when it has one. */
function createContext(setup: 'approved' | 'denied' | 'none' | 'unanswered') {
  return {
    ok: true,
    value: {
      managedParentPath: '/managed/app-slug',
      repositorySetup:
        setup === 'none'
          ? null
          : {
              decision: setup === 'unanswered' ? null : setup,
              repositoryId: '/work/app/.git',
              repositoryPath: '/work/app',
              scriptPath: '/work/app/.brainstrike/worktree-setup.sh',
              scriptSha256: 'a'.repeat(64),
            },
      suggestedName: 'quiet-otter',
    },
  };
}

async function renderReady() {
  const rendered = renderHook(() => useWorktreeMode(ARGS), { wrapper });
  await waitFor(() => expect(rendered.result.current?.createDisabledReason).toBeNull());
  return rendered;
}

describe('New worktree… in one click', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSettingsSpy.mockResolvedValue({
      ok: true,
      value: {
        isDefaultDirectory: true,
        managedDirectory: '/home/me/.brainstrike/worktrees',
        setupCommand: null,
      },
    });
    listSpy.mockResolvedValue({ ok: true, value: [] });
    createContextSpy.mockResolvedValue(createContext('none'));
    createSpy.mockResolvedValue({
      ok: true,
      value: {
        setup: {
          copiedPaths: [],
          output: '',
          reason: null,
          skippedCopies: [],
          status: 'none',
          truncated: false,
        },
        worktree: {
          archivedAt: null,
          archiveSnapshotRef: null,
          baseRef: 'HEAD',
          branch: 'bs/quiet-otter',
          createdAt: '2026-11-13T00:00:00.000Z',
          createdBy: 'user',
          id: 'w-1',
          path: '/managed/app-slug/quiet-otter',
          repoCommonDir: '/work/app/.git',
          runId: null,
          setupOutput: null,
          setupReason: null,
          setupStatus: 'none',
          threadId: 'thread-1',
        },
      },
    });
    addRootByPathSpy.mockResolvedValue({
      name: 'quiet-otter',
      path: '/managed/app-slug/quiet-otter',
    });
  });

  it('makes the worktree from HEAD on bs/<the host’s name>, then moves the thread into it', async () => {
    const { result } = await renderReady();

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current?.onQuickCreate();
    });

    expect(outcome).toEqual({ needsSheet: false });
    expect(createContextSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledExactlyOnceWith({
      baseRef: 'HEAD',
      branch: { name: 'bs/quiet-otter' },
      createdBy: 'user',
      name: 'quiet-otter',
      rootId: 'r-1',
      threadId: 'thread-1',
    });
    expect(addRootByPathSpy).toHaveBeenCalledWith('/managed/app-slug/quiet-otter');
    expect(onSelectWorktree).toHaveBeenCalledWith({
      branch: 'bs/quiet-otter',
      path: '/managed/app-slug/quiet-otter',
      worktreeId: 'w-1',
    });
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it.each(['approved', 'denied'] as const)(
    'creates at once when the repository’s setup script is %s: the host runs or skips it as answered',
    async (answer) => {
      createContextSpy.mockResolvedValue(createContext(answer));
      const { result } = await renderReady();

      let outcome: unknown;
      await act(async () => {
        outcome = await result.current?.onQuickCreate();
      });

      expect(outcome).toEqual({ needsSheet: false });
      expect(createSpy).toHaveBeenCalledTimes(1);
    }
  );

  it('creates nothing while the setup script has no answer, and leaves the sheet the question', async () => {
    createContextSpy.mockResolvedValue(createContext('unanswered'));
    const { result } = await renderReady();

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current?.onQuickCreate();
    });

    expect(outcome).toEqual({ needsSheet: true });
    expect(createSpy).not.toHaveBeenCalled();
    expect(onSelectWorktree).not.toHaveBeenCalled();
    // The sheet opens on the context New worktree… read: it asks, with the same name.
    expect(createContextSpy).toHaveBeenCalledTimes(1);
    expect(result.current?.repositorySetupConsent).toMatchObject({
      decision: null,
      scriptPath: '/work/app/.brainstrike/worktree-setup.sh',
    });
    expect(result.current?.defaultName).toBe('quiet-otter');
  });

  it('starts from the defaults the create sheet offers first', async () => {
    const { result } = await renderReady();

    expect(result.current?.baseRefs[0].value).toBe(DEFAULT_WORKTREE_BASE_REF);
    expect(result.current?.defaultBranchPrefix).toBe(WORKTREE_BRANCH_PREFIX);
  });

  it('rejects a failed create with the toast the sheet’s Create shows', async () => {
    createSpy.mockResolvedValue(gitFailure('local branch "bs/quiet-otter" already exists'));
    const { result } = await renderReady();

    await act(async () => {
      await expect(result.current?.onQuickCreate()).rejects.toThrow(
        'local branch "bs/quiet-otter" already exists'
      );
    });

    expect(toastSpy).toHaveBeenCalledExactlyOnceWith({
      description: 'local branch "bs/quiet-otter" already exists',
      title: 'Worktree creation failed',
      variant: 'destructive',
    });
    expect(onSelectWorktree).not.toHaveBeenCalled();
  });

  it('waits for the thread’s run to end, with the reason', async () => {
    const { result } = renderHook(() => useWorktreeMode({ ...ARGS, threadState: 'running' }), {
      wrapper,
    });
    await waitFor(() => expect(result.current?.createDisabledReason).toBe(RUN_IN_PROGRESS));

    await act(async () => {
      await expect(result.current?.onQuickCreate()).rejects.toThrow(RUN_IN_PROGRESS);
    });

    expect(createContextSpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
  });
});
