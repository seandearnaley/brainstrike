import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createBranchSpy,
  fetchSpy,
  loggerMock,
  nonceHolder,
  refreshInventorySpy,
  repositorySpy,
  statusSpy,
  switchBranchSpy,
  toastSpy,
} = vi.hoisted(() => ({
  createBranchSpy: vi.fn(),
  fetchSpy: vi.fn(),
  loggerMock: {
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  },
  // A mutable box, not a plain number: the mocked store selector below reads
  // it fresh on every render, so tests can simulate live-refresh nonce bumps
  // by mutating `.value` and forcing a rerender.
  nonceHolder: { value: 0 },
  refreshInventorySpy: vi.fn(() => Promise.resolve()),
  repositorySpy: vi.fn(),
  statusSpy: vi.fn(),
  switchBranchSpy: vi.fn(),
  toastSpy: vi.fn(),
}));

vi.mock('../git-panel/git-bridge', () => ({
  resolveGitBridge: () => ({
    createBranch: createBranchSpy,
    fetch: fetchSpy,
    repository: repositorySpy,
    status: statusSpy,
    switchBranch: switchBranchSpy,
  }),
}));
vi.mock('../changes/use-git-inventory', () => ({
  useGitInventory: () => ({ refresh: refreshInventorySpy }),
}));
vi.mock('../changes/changes-live-refresh-store', () => ({
  useChangesLiveRefreshStore: (selector: (state: { anyInvalidationNonce: number }) => unknown) =>
    selector({ anyInvalidationNonce: nonceHolder.value }),
}));
vi.mock('@brainstrike/logging', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/logging')>()),
  createLogger: () => loggerMock,
}));
vi.mock('@brainstrike/ui', () => ({ toast: toastSpy }));

import { useBranchSwitcher } from '../hooks/use-branch-switcher';

const REPOSITORY = {
  branches: [
    { current: true, head: 'a', name: 'main', upstream: null, worktreePath: null },
    { current: false, head: 'b', name: 'feature/alpha', upstream: null, worktreePath: null },
  ],
  defaultRemote: 'origin',
  scope: 'repository' as const,
};
// `checkout` still gates whether a menu exists at all (mirrors "no chip
// rendered, no menu"), but its `dirty` is NEVER read for the switch gate —
// see the ruling above the interfaces. `dirty: true` here is a canary: every
// test below asserts against `statusSpy`'s `files`, not this flag, and one
// test explicitly proves an untracked-inclusive `checkout.dirty` is ignored.
const CLEAN = { ahead: null, behind: null, branch: 'main', dirty: false };
const CLEAN_STATUS = { ahead: null, behind: null, branch: 'main', clean: true, files: [] };
const TRACKED_STATUS = {
  ahead: null,
  behind: null,
  branch: 'main',
  clean: false,
  files: [{ path: 'tracked.ts', staged: true, status: 'M', unstaged: false, untracked: false }],
};

describe('useBranchSwitcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nonceHolder.value = 0;
    repositorySpy.mockResolvedValue({ ok: true, value: REPOSITORY });
    statusSpy.mockResolvedValue({ ok: true, value: CLEAN_STATUS });
    switchBranchSpy.mockResolvedValue({ ok: true, value: { branch: 'feature/alpha' } });
    createBranchSpy.mockResolvedValue({ ok: true, value: { branch: 'bs/bright-fox' } });
    fetchSpy.mockResolvedValue({ ok: true, value: { output: '' } });
  });

  it('returns undefined without a root or a checkout', () => {
    const { result } = renderHook(() => useBranchSwitcher({ checkout: undefined, dbRootId: null }));
    expect(result.current).toBeUndefined();
  });

  it('never reads the repository or status for a non-repository root, and never warns, across nonce bumps', async () => {
    // `checkout: undefined` with a `dbRootId` set is exactly what
    // `useThreadCheckoutStatus` returns for a primary root that resolved but
    // is not a git repository (BST-1452 M2) — the effect must not fetch or
    // warn for it, on the initial render or on any later invalidation.
    const { rerender } = renderHook(
      ({ nonce: _nonce }) => useBranchSwitcher({ checkout: undefined, dbRootId: 'r-1' }),
      { initialProps: { nonce: 0 } }
    );
    await act(async () => {
      await Promise.resolve();
    });
    nonceHolder.value += 1;
    rerender({ nonce: 1 });
    await act(async () => {
      await Promise.resolve();
    });
    nonceHolder.value += 1;
    rerender({ nonce: 2 });
    await act(async () => {
      await Promise.resolve();
    });

    expect(repositorySpy).not.toHaveBeenCalled();
    expect(statusSpy).not.toHaveBeenCalled();
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it('builds rows from window.git.repository for the primary root', async () => {
    const { result } = renderHook(() => useBranchSwitcher({ checkout: CLEAN, dbRootId: 'r-1' }));
    await waitFor(() => expect(result.current?.rows).toHaveLength(2));
    expect(repositorySpy).toHaveBeenCalledWith('r-1');
    expect(statusSpy).toHaveBeenCalledWith('r-1');
    expect(result.current?.rows.map((row) => row.name)).toEqual(['main', 'feature/alpha']);
  });

  it('switches, then refreshes the inventory so the next open is not pre-switch', async () => {
    const { result } = renderHook(() => useBranchSwitcher({ checkout: CLEAN, dbRootId: 'r-1' }));
    await waitFor(() => expect(result.current).toBeDefined());
    await act(async () => {
      result.current?.onSwitch('feature/alpha');
    });
    expect(switchBranchSpy).toHaveBeenCalledWith('r-1', { branch: 'feature/alpha' });
    await waitFor(() => expect(refreshInventorySpy).toHaveBeenCalled());
  });

  it('surfaces a switch failure as a toast and never leaves `pending` stuck', async () => {
    switchBranchSpy.mockResolvedValue({ error: 'index.lock exists', ok: false });
    const { result } = renderHook(() => useBranchSwitcher({ checkout: CLEAN, dbRootId: 'r-1' }));
    await waitFor(() => expect(result.current).toBeDefined());
    await act(async () => {
      result.current?.onSwitch('feature/alpha');
    });
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ description: 'index.lock exists', variant: 'destructive' })
      )
    );
    expect(result.current?.pending).toBe(false);
  });

  it('omits onFetch when the repository has no default remote', async () => {
    repositorySpy.mockResolvedValue({ ok: true, value: { ...REPOSITORY, defaultRemote: null } });
    const { result } = renderHook(() => useBranchSwitcher({ checkout: CLEAN, dbRootId: 'r-1' }));
    await waitFor(() => expect(result.current).toBeDefined());
    expect(result.current?.onFetch).toBeUndefined();
  });

  it('derives the switch gate from a TRACKED status file, never from checkout.dirty', async () => {
    statusSpy.mockResolvedValue({ ok: true, value: TRACKED_STATUS });
    // checkout.dirty is FALSE here on purpose — if the hook still read it,
    // this row would wrongly stay switchable despite the tracked change.
    const { result } = renderHook(() => useBranchSwitcher({ checkout: CLEAN, dbRootId: 'r-1' }));
    await waitFor(() => expect(result.current?.rows).toHaveLength(2));
    const alpha = result.current?.rows.find((row) => row.name === 'feature/alpha');
    expect(alpha?.switchable).toBe(false);
    expect(alpha?.disabledReason).toContain('uncommitted changes');
  });

  it('stays switchable when checkout.dirty is true but the status has no TRACKED files', async () => {
    // The dot-vs-gate separation, the other direction: the workspace-bar dot
    // can be lit (`checkout.dirty: true`, e.g. from an untracked file) while
    // the switch gate — reading its own tracked-only status — stays open.
    statusSpy.mockResolvedValue({ ok: true, value: CLEAN_STATUS });
    const { result } = renderHook(() =>
      useBranchSwitcher({ checkout: { ...CLEAN, dirty: true }, dbRootId: 'r-1' })
    );
    await waitFor(() => expect(result.current?.rows).toHaveLength(2));
    const alpha = result.current?.rows.find((row) => row.name === 'feature/alpha');
    expect(alpha?.switchable).toBe(true);
  });
});
