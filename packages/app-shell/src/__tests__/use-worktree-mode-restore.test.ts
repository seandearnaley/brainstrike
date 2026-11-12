/**
 * ADR-0034 decision 7: the where-control's Other worktree… picker lists the
 * repository's archived worktrees, and Restore and use brings one back through
 * the host's restore, then moves the thread into it through the thread
 * binding's own command, as Use does. A refusal shows in the picker.
 */

import { act } from '@brainstrike/test-utils/react-act';
import type { ManagedWorktreeRow } from '@brainstrike/types';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type UseWorktreeModeArgs, useWorktreeMode } from '../hooks/use-worktree-mode';
import { gitFailure } from './helpers/git-failure';
import { stubWorktreesBridge, workspaceGitWrapper } from './helpers/workspace-git-services-wrapper';

const { addRootByPathSpy, listArchivedSpy, listSpy, restoreSpy, toastSpy } = vi.hoisted(() => ({
  addRootByPathSpy: vi.fn(),
  listArchivedSpy: vi.fn(),
  listSpy: vi.fn(),
  restoreSpy: vi.fn(),
  toastSpy: vi.fn(),
}));
const wrapper = workspaceGitWrapper({
  worktrees: stubWorktreesBridge({
    getSettings: vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        value: { isDefaultDirectory: true, managedDirectory: '/managed', setupCommand: null },
      })
    ),
    list: listSpy,
    listArchived: listArchivedSpy,
    restore: restoreSpy,
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
const onSelectWorktree = vi.fn(() => Promise.resolve());
const ARGS: UseWorktreeModeArgs = {
  checkout: { branch: 'main', mode: 'local', worktreeId: null, worktreePath: null },
  isRepository: true,
  onHandOffToLocal: vi.fn(() => Promise.resolve()),
  onSelectWorktree,
  primaryRootId: 'r-1',
  primaryRootPath: '/work/app',
  statusFailure: null,
  threadId: 'thread-1',
  threadState: 'idle',
  uncommittedChanges: false,
};

function archivedRow(id: string, name: string, archivedAt: string): ManagedWorktreeRow {
  return {
    archivedAt,
    archiveSnapshotRef: `refs/brainstrike/worktree-archive/${id}`,
    baseRef: 'main',
    branch: `bs/${name}`,
    createdAt: '2026-11-01T00:00:00.000Z',
    createdBy: 'agent',
    id,
    path: `/managed/app/${name}`,
    repoCommonDir: '/work/app/.git',
    runId: null,
    setupOutput: null,
    setupReason: null,
    setupStatus: 'none',
    threadId: null,
  };
}

const BADGER_ARCHIVED_AT = '2026-11-12T10:30:00.000Z';
const BADGER = archivedRow('w-badger', 'swift-badger', BADGER_ARCHIVED_AT);
const OTTER = archivedRow('w-otter', 'calm-otter', '2026-11-10T08:00:00.000Z');
const BADGER_ENTRY = {
  archivedAt: BADGER_ARCHIVED_AT,
  branch: 'bs/swift-badger',
  name: 'swift-badger',
  path: '/managed/app/swift-badger',
  worktreeId: 'w-badger',
} as const;

function restored(row: ManagedWorktreeRow) {
  return {
    ok: true as const,
    value: {
      setup: {
        copiedPaths: [],
        output: '',
        reason: null,
        skippedCopies: [],
        status: 'none' as const,
        truncated: false,
      },
      worktree: { ...row, archivedAt: null, archiveSnapshotRef: null },
    },
  };
}

/** The where-control with its Other worktree… picker open and its archived list read. */
async function openPicker(args: UseWorktreeModeArgs = ARGS) {
  const rendered = renderHook(() => useWorktreeMode(args), { wrapper });
  await waitFor(() => expect(rendered.result.current?.picker).toBeDefined());
  act(() => {
    rendered.result.current?.picker.onOpenChange(true);
  });
  await waitFor(() => expect(rendered.result.current?.picker.archived?.loading).toBe(false));
  return rendered;
}

describe('restoring an archived worktree from the where-control', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listSpy.mockResolvedValue({ ok: true, value: [] });
    listArchivedSpy.mockResolvedValue({ ok: true, value: [BADGER, OTTER] });
    restoreSpy.mockResolvedValue(restored(BADGER));
    addRootByPathSpy.mockResolvedValue({ name: 'swift-badger', path: BADGER.path });
  });

  it("lists the repository's archived worktrees, as the host orders them, when the picker opens", async () => {
    const { result } = await openPicker();

    expect(listArchivedSpy).toHaveBeenCalledWith({ rootId: 'r-1' });
    expect(result.current?.picker.archived).toMatchObject({
      disabledReason: null,
      entries: [
        BADGER_ENTRY,
        {
          archivedAt: OTTER.archivedAt,
          branch: 'bs/calm-otter',
          name: 'calm-otter',
          path: '/managed/app/calm-otter',
          worktreeId: 'w-otter',
        },
      ],
      error: null,
      refusal: null,
    });
  });

  it('Restore and use restores the worktree, then moves the thread into it', async () => {
    const { result } = await openPicker();
    listArchivedSpy.mockResolvedValue({ ok: true, value: [OTTER] });

    act(() => {
      result.current?.picker.archived?.onRestore(BADGER_ENTRY);
    });

    await waitFor(() =>
      expect(onSelectWorktree).toHaveBeenCalledWith({
        branch: 'bs/swift-badger',
        path: '/managed/app/swift-badger',
        worktreeId: 'w-badger',
      })
    );
    expect(restoreSpy).toHaveBeenCalledWith({ worktreeId: 'w-badger' });
    expect(addRootByPathSpy).toHaveBeenCalledWith('/managed/app/swift-badger');
    await waitFor(() => expect(result.current?.picker.open).toBe(false));
    await waitFor(() =>
      expect(result.current?.picker.archived?.entries.map(({ name }) => name)).toEqual([
        'calm-otter',
      ])
    );
    expect(result.current?.picker.archived?.refusal).toBeNull();
    expect(result.current?.pending).toBe(false);
  });

  it('a refused restore shows its reason in the picker and moves nothing', async () => {
    restoreSpy.mockResolvedValue(
      gitFailure(
        '"/managed/app/swift-badger" already exists and is not empty — move it aside before restoring.'
      )
    );
    const { result } = await openPicker();

    act(() => {
      result.current?.picker.archived?.onRestore(BADGER_ENTRY);
    });

    await waitFor(() =>
      expect(result.current?.picker.archived?.refusal).toBe(
        'Could not restore swift-badger: "/managed/app/swift-badger" already exists and is not empty — move it aside before restoring.'
      )
    );
    expect(addRootByPathSpy).not.toHaveBeenCalled();
    expect(onSelectWorktree).not.toHaveBeenCalled();
    expect(result.current?.picker.open).toBe(true);
    expect(result.current?.picker.archived?.restoringId).toBeNull();
  });

  it('says so when the restored worktree could not take the thread', async () => {
    onSelectWorktree.mockRejectedValueOnce(new Error('the thread binding refused'));
    const { result } = await openPicker();

    act(() => {
      result.current?.picker.archived?.onRestore(BADGER_ENTRY);
    });

    await waitFor(() =>
      expect(result.current?.picker.archived?.refusal).toBe(
        'Restored swift-badger, but this thread could not move into it: the thread binding refused'
      )
    );
    expect(result.current?.picker.open).toBe(true);
  });

  it("waits for the thread's run to end, like every checkout change", async () => {
    const { result } = await openPicker({ ...ARGS, threadState: 'running' });

    expect(result.current?.picker.archived?.disabledReason).toBe(RUN_IN_PROGRESS);
    act(() => {
      result.current?.picker.archived?.onRestore(BADGER_ENTRY);
    });

    expect(result.current?.picker.archived?.refusal).toBe(
      `Could not restore swift-badger: ${RUN_IN_PROGRESS}`
    );
    expect(restoreSpy).not.toHaveBeenCalled();
  });

  it('says why the archived worktrees could not be read', async () => {
    listArchivedSpy.mockResolvedValue(gitFailure('The worktree ledger could not be read.'));
    const { result } = await openPicker();

    expect(result.current?.picker.archived).toMatchObject({
      entries: [],
      error: 'The worktree ledger could not be read.',
    });
  });
});
