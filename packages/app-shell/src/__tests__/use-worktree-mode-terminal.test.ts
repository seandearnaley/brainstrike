/**
 * Open in Terminal wiring (BST-1457): the capability-gated `onOpenTerminal`
 * handler on `WorkspaceBarMode`, supplied only when the terminal bridge is
 * available AND the current checkout resolves inside an open folder — split
 * out of `use-worktree-mode.test.ts` to keep both files under the
 * line-count ceiling.
 */
import type { WorktreeListEntry } from '@brainstrike/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  archiveSpy,
  createSpy,
  getSettingsSpy,
  isTerminalBridgeAvailableMock,
  listSpy,
  openTerminalAtMock,
} = vi.hoisted(() => ({
  archiveSpy: vi.fn(),
  createSpy: vi.fn(),
  getSettingsSpy: vi.fn(),
  isTerminalBridgeAvailableMock: vi.fn(() => true),
  listSpy: vi.fn(),
  openTerminalAtMock: vi.fn(),
}));

vi.mock('../worktrees/worktrees-bridge', () => ({
  resolveWorktreesBridge: () => ({
    adopt: vi.fn(),
    archive: archiveSpy,
    checkoutStatus: vi.fn(),
    create: createSpy,
    createBranchHere: vi.fn(),
    createContext: vi.fn(),
    getSettings: getSettingsSpy,
    list: listSpy,
    listManagedPaths: vi.fn(),
    restore: vi.fn(),
    setSettings: vi.fn(),
  }),
}));
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
vi.mock('../terminal-panel/terminal-bridge', () => ({
  isTerminalBridgeAvailable: isTerminalBridgeAvailableMock,
}));
vi.mock('../stores/terminal-target-store', () => ({
  useTerminalTargetStore: {
    getState: () => ({ openTerminalAt: openTerminalAtMock }),
  },
}));

import { useWorktreeMode } from '../hooks/use-worktree-mode';

const onHandOffToLocal = vi.fn(() => Promise.resolve());
const onSelectWorktree = vi.fn(() => Promise.resolve());

const ARGS = {
  checkout: { branch: null, mode: 'local' as const, worktreeId: null, worktreePath: null },
  firstRequestState: 'unsent' as const,
  isRepository: true,
  onHandOffToLocal,
  onSelectWorktree,
  primaryRootId: 'r-1',
  primaryRootPath: '/work/app',
  runId: null,
  threadId: 'thread-1',
};

const WORKTREE_CHECKOUT = {
  branch: 'bs/bright-fox',
  mode: 'worktree' as const,
  worktreeId: 'w-1',
  worktreePath: '/managed/app/bright-fox',
};

function entry(overrides: Partial<WorktreeListEntry> = {}): WorktreeListEntry {
  return {
    branch: 'main',
    containment: ['r-1'],
    createdAt: null,
    detached: false,
    disabledReason: null,
    externalTool: null,
    id: 'w-1',
    lockedReason: null,
    managed: true,
    name: 'bright-fox',
    path: '/managed/app/bright-fox',
    primary: false,
    provenance: 'both',
    remedy: null,
    repoCommonDir: '/repo/.git',
    repositoryRoot: '/work/app',
    rootId: 'r-1',
    rootIdIsExactMount: true,
    setupReason: null,
    setupStatus: 'none',
    trust: 'validated',
    trustReason: null,
    usable: true,
    ...overrides,
  };
}

describe('useWorktreeMode terminal wiring', () => {
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
  });

  it('supplies onOpenTerminal with the checkout path and its containing root', async () => {
    // A nested worktree: `path` is the checkout itself, `rootId` is the
    // CONTAINING root — the two are DISTINCT values on purpose (Task 4's
    // falsifier: passing the root as cwd must fail this assertion).
    const nested = entry({
      path: '/repo/.claude/worktrees/bright-fox',
      rootId: 'root-1',
      rootIdIsExactMount: false,
    });
    listSpy.mockResolvedValue({ ok: true, value: [nested] });
    const { result } = renderHook(() => useWorktreeMode({ ...ARGS, checkout: WORKTREE_CHECKOUT }));
    act(() => result.current?.onOpenPicker());
    await waitFor(() => expect(result.current?.onOpenTerminal).toEqual(expect.any(Function)));

    result.current?.onOpenTerminal?.();

    expect(openTerminalAtMock).toHaveBeenCalledExactlyOnceWith({
      cwd: '/repo/.claude/worktrees/bright-fox',
      rootId: 'root-1',
    });
    // Falsifiers: opening a terminal touches neither archive nor create.
    expect(archiveSpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('omits onOpenTerminal when the checkout has no containing root', async () => {
    const noRoot = entry({
      path: '/repo/.claude/worktrees/bright-fox',
      rootId: null,
      rootIdIsExactMount: false,
    });
    listSpy.mockResolvedValue({ ok: true, value: [noRoot] });
    const { result } = renderHook(() => useWorktreeMode({ ...ARGS, checkout: WORKTREE_CHECKOUT }));
    act(() => result.current?.onOpenPicker());
    // NOT `worktree not null`: `computeWorktreeSummary` has a second,
    // "missing worktree" branch fed by `missingWorktreePath`, which is
    // derived synchronously from `checkout.worktreePath` — non-null on the
    // very FIRST render, before `listSpy` ever resolves. Gating on mere
    // non-null is satisfiable by that placeholder and never actually waits
    // for `currentEntry` to resolve from the mocked list. The placeholder's
    // `path` is `checkout.worktreePath` ('/managed/app/bright-fox'), a
    // different literal from the RESOLVED entry's path below, so gating on
    // the resolved path is the fact only a real list match can produce.
    await waitFor(() =>
      expect(result.current?.worktree?.path).toBe('/repo/.claude/worktrees/bright-fox')
    );

    expect(result.current?.onOpenTerminal).toBeUndefined();
    expect(openTerminalAtMock).not.toHaveBeenCalled();
  });

  it('omits onOpenTerminal when the terminal bridge is unavailable even with a valid containing root', async () => {
    // Pins the capability gate itself: a valid rootId alone must not be
    // enough.
    isTerminalBridgeAvailableMock.mockReturnValueOnce(false);
    const nested = entry({
      path: '/repo/.claude/worktrees/bright-fox',
      rootId: 'root-1',
      rootIdIsExactMount: false,
    });
    listSpy.mockResolvedValue({ ok: true, value: [nested] });
    const { result } = renderHook(() => useWorktreeMode({ ...ARGS, checkout: WORKTREE_CHECKOUT }));
    act(() => result.current?.onOpenPicker());
    // Same fallback-satisfiable-waitFor trap as above: gate on the RESOLVED
    // entry's path, not mere non-null worktree.
    await waitFor(() =>
      expect(result.current?.worktree?.path).toBe('/repo/.claude/worktrees/bright-fox')
    );

    expect(result.current?.onOpenTerminal).toBeUndefined();
    expect(openTerminalAtMock).not.toHaveBeenCalled();
  });
});
