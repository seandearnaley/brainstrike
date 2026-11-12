/**
 * ADR-0034: a person moves a sent thread between turns. Every checkout change
 * waits for the thread's run to end, because a run keeps the checkout it was
 * admitted with, and a new worktree leaves the folder's uncommitted changes
 * where they are. Split out of `use-worktree-mode.test.ts` to keep that file
 * under the line-count ceiling.
 */

import { act } from '@brainstrike/test-utils/react-act';
import type { WorktreeListEntry } from '@brainstrike/types';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type UseWorktreeModeArgs, useWorktreeMode } from '../hooks/use-worktree-mode';
import { stubWorktreesBridge, workspaceGitWrapper } from './helpers/workspace-git-services-wrapper';

const { addRootByPathSpy, archiveSpy, inspectArchiveSpy, listSpy, toastSpy } = vi.hoisted(() => ({
  addRootByPathSpy: vi.fn(),
  archiveSpy: vi.fn(),
  inspectArchiveSpy: vi.fn(),
  listSpy: vi.fn(),
  toastSpy: vi.fn(),
}));
const wrapper = workspaceGitWrapper({
  worktrees: stubWorktreesBridge({
    archive: archiveSpy,
    getSettings: vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        value: { isDefaultDirectory: true, managedDirectory: '/managed', setupCommand: null },
      })
    ),
    inspectArchive: inspectArchiveSpy,
    list: listSpy,
  }),
});
vi.mock('@brainstrike/logging', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/logging')>()),
  createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  }),
}));
vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  useFileSystem: () => ({ addRootDirectory: vi.fn(), addRootDirectoryByPath: addRootByPathSpy }),
}));
vi.mock('@brainstrike/ui', () => ({ toast: toastSpy }));

const RUN_IN_PROGRESS = "Available when this thread's run ends.";
const onHandOffToLocal = vi.fn(() => Promise.resolve());
const onSelectWorktree = vi.fn(() => Promise.resolve());
const ARGS: UseWorktreeModeArgs = {
  checkout: {
    branch: 'bs/bright-fox',
    mode: 'worktree',
    worktreeId: 'w-1',
    worktreePath: '/managed/app/bright-fox',
  },
  isRepository: true,
  onHandOffToLocal,
  onSelectWorktree,
  primaryRootId: 'r-1',
  primaryRootPath: '/managed/app/bright-fox',
  statusFailure: null,
  threadId: 'thread-1',
  threadState: 'idle',
  uncommittedChanges: false,
};

function entry(id: string, name: string): WorktreeListEntry {
  return {
    branch: `bs/${name}`,
    containment: ['r-1'],
    createdAt: null,
    detached: false,
    disabledReason: null,
    externalTool: null,
    id,
    lockedReason: null,
    managed: true,
    name,
    path: `/managed/app/${name}`,
    primary: false,
    provenance: 'both',
    remedy: null,
    repoCommonDir: '/work/app/.git',
    repositoryRoot: '/work/app',
    rootId: 'r-1',
    rootIdIsExactMount: true,
    setupReason: null,
    setupStatus: 'none',
    trust: 'validated',
    trustReason: null,
    usable: true,
  };
}

/** The thread works in `bright-fox`; `quiet-otter` is the other worktree it can move to. */
function renderMode(threadState: UseWorktreeModeArgs['threadState']) {
  return renderHook(
    (props: Pick<UseWorktreeModeArgs, 'threadState'>) => useWorktreeMode({ ...ARGS, ...props }),
    { initialProps: { threadState }, wrapper }
  );
}

function otherWorktree(result: ReturnType<typeof renderMode>['result']) {
  const option = result.current?.picker.options.find(({ worktreeId }) => worktreeId === 'w-2');
  if (!option) {
    throw new Error('The picker does not offer the other worktree');
  }
  return option;
}

describe('useWorktreeMode between turns (ADR-0034)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listSpy.mockResolvedValue({
      ok: true,
      value: [entry('w-1', 'bright-fox'), entry('w-2', 'quiet-otter')],
    });
    addRootByPathSpy.mockResolvedValue({ name: 'quiet-otter', path: '/managed/app/quiet-otter' });
    archiveSpy.mockResolvedValue({ ok: true, value: null });
    inspectArchiveSpy.mockResolvedValue({
      ok: true,
      value: {
        confirmationToken: null,
        ignoredEntryCount: 0,
        ignoredTopLevelEntries: [],
        ignoredTopLevelEntriesTruncated: false,
        ignoredTopLevelEntryCount: 0,
      },
    });
  });

  it('a run in progress refuses Use existing, Hand off to Local and Archive, with the reason', async () => {
    const { result } = renderMode('running');
    await waitFor(() => expect(result.current?.picker.options).toHaveLength(2));
    expect(result.current?.checkoutChangeDisabledReason).toBe(RUN_IN_PROGRESS);

    act(() => {
      result.current?.picker.onSelect(otherWorktree(result));
      result.current?.onHandOffToLocal?.();
      result.current?.onArchive?.();
    });

    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(3));
    for (const title of [
      'Could not use that worktree',
      'Could not hand off to Local',
      'Could not archive the worktree',
    ]) {
      expect(toastSpy).toHaveBeenCalledWith({
        description: RUN_IN_PROGRESS,
        title,
        variant: 'destructive',
      });
    }
    expect(addRootByPathSpy).not.toHaveBeenCalled();
    expect(onSelectWorktree).not.toHaveBeenCalled();
    expect(onHandOffToLocal).not.toHaveBeenCalled();
    expect(inspectArchiveSpy).not.toHaveBeenCalled();
    expect(archiveSpy).not.toHaveBeenCalled();
  });

  it('moves the thread again once its run ends', async () => {
    const { rerender, result } = renderMode('running');
    await waitFor(() => expect(result.current?.picker.options).toHaveLength(2));
    rerender({ threadState: 'idle' });
    expect(result.current?.checkoutChangeDisabledReason).toBeNull();

    act(() => result.current?.picker.onSelect(otherWorktree(result)));
    await waitFor(() =>
      expect(onSelectWorktree).toHaveBeenCalledWith({
        branch: 'bs/quiet-otter',
        path: '/managed/app/quiet-otter',
        worktreeId: 'w-2',
      })
    );
    act(() => result.current?.onHandOffToLocal?.());
    await waitFor(() => expect(onHandOffToLocal).toHaveBeenCalledTimes(1));
    act(() => result.current?.onArchive?.());
    await waitFor(() => expect(archiveSpy).toHaveBeenCalledWith({ worktreeId: 'w-1' }));
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it('keeps the checkout of a run that starts while Archive inspects the worktree', async () => {
    let finishInspection: (value: unknown) => void = () => undefined;
    inspectArchiveSpy.mockReturnValueOnce(
      new Promise((resolve) => {
        finishInspection = resolve;
      })
    );
    const { rerender, result } = renderMode('idle');
    await waitFor(() => expect(result.current?.picker.options).toHaveLength(2));

    act(() => result.current?.onArchive?.());
    await waitFor(() => expect(inspectArchiveSpy).toHaveBeenCalledTimes(1));
    rerender({ threadState: 'running' });
    await act(async () => {
      finishInspection({
        ok: true,
        value: {
          confirmationToken: null,
          ignoredEntryCount: 0,
          ignoredTopLevelEntries: [],
          ignoredTopLevelEntriesTruncated: false,
          ignoredTopLevelEntryCount: 0,
        },
      });
    });

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith({
        description: RUN_IN_PROGRESS,
        title: 'Could not hand off to Local — worktree not archived',
        variant: 'destructive',
      })
    );
    expect(onHandOffToLocal).not.toHaveBeenCalled();
    expect(archiveSpy).not.toHaveBeenCalled();
  });

  it("names the thread's folder while it has uncommitted changes, which stay there", async () => {
    const { rerender, result } = renderHook(
      (props: Pick<UseWorktreeModeArgs, 'uncommittedChanges'>) =>
        useWorktreeMode({ ...ARGS, ...props }),
      { initialProps: { uncommittedChanges: true }, wrapper }
    );
    expect(result.current?.uncommittedFolderName).toBe('bright-fox');

    rerender({ uncommittedChanges: false });
    expect(result.current?.uncommittedFolderName).toBeNull();
    await act(async () => {});
  });
});
