/**
 * BST-2133: a failed git status read must not be reported as "Not a git
 * repository". Split out of `use-worktree-mode.test.ts` to keep that file
 * under the line-count ceiling.
 */

import { act } from '@brainstrike/test-utils/react-act';
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { stubWorktreesBridge, workspaceGitWrapper } from './helpers/workspace-git-services-wrapper';

const wrapper = workspaceGitWrapper({
  worktrees: stubWorktreesBridge({
    getSettings: vi.fn(() => new Promise<never>(() => undefined)),
    list: vi.fn(() => new Promise<never>(() => undefined)),
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
  useFileSystem: () => ({
    addRootDirectory: vi.fn(),
    addRootDirectoryByPath: vi.fn(),
  }),
}));
vi.mock('@brainstrike/ui', () => ({ toast: vi.fn() }));

import { unavailableRepositoryReason, useWorktreeMode } from '../hooks/use-worktree-mode';

const ARGS = {
  checkout: { branch: null, mode: 'local' as const, worktreeId: null, worktreePath: null },
  firstRequestState: 'unsent' as const,
  isRepository: false,
  onHandOffToLocal: vi.fn(() => Promise.resolve()),
  onSelectWorktree: vi.fn(() => Promise.resolve()),
  primaryRootId: 'r-1',
  primaryRootPath: '/work/app',
  runId: null,
  statusFailure: null,
  threadId: 'thread-1',
};

describe('useWorktreeMode without a readable repository (BST-2133)', () => {
  it('names a failed status read instead of calling the folder a non-repository', async () => {
    const { result } = renderHook(
      () => useWorktreeMode({ ...ARGS, statusFailure: 'git binary missing' }),
      { wrapper }
    );
    const reason = 'Git status could not be read: git binary missing';

    expect(result.current?.disabledReason).toBe(reason);
    expect(result.current?.createDisabledReason).toBe(reason);
    await expect(
      result.current?.onCreate({ baseRef: 'HEAD', branch: { detached: true }, name: 'x' })
    ).rejects.toThrow(reason);
    await act(async () => {});
  });

  it('shows only a bounded first line of a long, multi-line git failure', async () => {
    const stderr = `fatal: index file corrupt\n${'detail line\n'.repeat(10_000)}`;
    const { result } = renderHook(() => useWorktreeMode({ ...ARGS, statusFailure: stderr }), {
      wrapper,
    });

    expect(result.current?.disabledReason).toBe(
      'Git status could not be read: fatal: index file corrupt'
    );
    await act(async () => {});
  });

  it('keeps "Not a git repository" for a read that succeeded', async () => {
    const { result } = renderHook(() => useWorktreeMode(ARGS), { wrapper });

    expect(result.current?.disabledReason).toBe('Not a git repository');
    expect(unavailableRepositoryReason(null)).toBe('Not a git repository');
    await act(async () => {});
  });
});
