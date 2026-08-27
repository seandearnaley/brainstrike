import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listMock = vi.fn();
const checkoutStatusMock = vi.fn();
const adoptMock = vi.fn();
const archiveMock = vi.fn();

vi.mock('../../worktrees/worktrees-bridge', () => ({
  resolveWorktreesBridge: () => ({
    adopt: adoptMock,
    archive: archiveMock,
    checkoutStatus: checkoutStatusMock,
    list: listMock,
  }),
}));

const useForgePrCacheMock = vi.fn(() => ({ byRepoBranch: new Map(), error: null, loading: false }));
vi.mock('../../hooks/use-forge-pr-cache', () => ({
  useForgePrCache: () => useForgePrCacheMock(),
}));

// The two stores the hook reads. Both are mocked as SELECTOR-CALLING functions
// (that is how zustand hooks are consumed), so the hook's real selectors run
// against a controlled state object rather than being stubbed out wholesale.
const storeThreads: readonly unknown[] = [];
vi.mock('@brainstrike/assistant-data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/assistant-data')>()),
  useAssistantThreadStore: (
    selector: (state: { threadsByResourceId: Record<string, readonly unknown[]> }) => unknown
  ) => selector({ threadsByResourceId: { 'brainstrike:workspace': storeThreads } }),
}));

const indexingOptIn: Record<string, true> = {};
vi.mock('@brainstrike/app-state/stores/background-indexing-preferences-store', () => ({
  useBackgroundIndexingPreferencesStore: (
    selector: (state: { worktreeRootIndexingOptInById: Record<string, true> }) => unknown
  ) => selector({ worktreeRootIndexingOptInById: indexingOptIn }),
}));

let invalidationNonce = 0;
vi.mock('../../changes/changes-live-refresh-store', () => ({
  useChangesLiveRefreshStore: (selector: (state: { anyInvalidationNonce: number }) => unknown) =>
    selector({ anyInvalidationNonce: invalidationNonce }),
}));
vi.mock('../../changes/use-changes-live-refresh', () => ({
  useChangesLiveRefreshSubscription: () => undefined,
}));

// Controllable root-identity context value. `null` is the honest
// provider-absent default (web, or a subtree outside the workspace-sync
// provider); tests that exercise the registration-driven reload swap in a
// fresh value object, mirroring how `RootIdentityProvider` re-memoizes when
// `publishCanonicalMapping` lands a new adapter→DB pair.
let rootIdentityValue: {
  resolveAdapterRootId: (dbRootId: string) => string | null;
  workspaceDbRootIds: readonly string[];
} | null = null;
vi.mock('../../roots/root-identity-context', () => ({
  useOptionalRootIdentity: () => rootIdentityValue,
}));

import { type UseWorktreeMapInput, useWorktreeMap } from '../use-worktree-map';

const INPUT: UseWorktreeMapInput = {
  database: null,
  resourceId: 'brainstrike:workspace',
  runningThreadIds: new Set<string>(),
};

function entry(overrides: Record<string, unknown> = {}) {
  return {
    branch: 'main',
    containment: ['root-1'],
    createdAt: null,
    detached: false,
    disabledReason: null,
    externalTool: null,
    id: null,
    lockedReason: null,
    managed: false,
    name: 'repo',
    path: '/repo',
    primary: true,
    provenance: 'scanned',
    remedy: null,
    repoCommonDir: '/repo/.git',
    repositoryRoot: '/repo',
    rootId: 'root-1',
    setupReason: null,
    setupStatus: 'none',
    trust: 'validated',
    trustReason: null,
    usable: false,
    ...overrides,
  };
}

describe('useWorktreeMap', () => {
  beforeEach(() => {
    invalidationNonce = 0;
    rootIdentityValue = null;
    listMock.mockReset().mockResolvedValue({ ok: true, value: [entry()] });
    checkoutStatusMock.mockReset().mockResolvedValue({
      ok: true,
      value: { ahead: 0, behind: 0, clean: true, path: '/repo', upstream: 'origin/main' },
    });
    adoptMock.mockReset();
    archiveMock.mockReset();
  });

  it('loads the list once on mount and projects it into repository lanes', async () => {
    const { result } = renderHook(() => useWorktreeMap(INPUT));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(listMock).toHaveBeenCalledTimes(1);
    // Falsifier: the Map must not mutate anything to render itself.
    expect(adoptMock).not.toHaveBeenCalled();
    expect(archiveMock).not.toHaveBeenCalled();
    expect(result.current.repositories).toHaveLength(1);
    expect(result.current.repositories[0]?.cards).toHaveLength(1);
  });

  it('reads each visible checkout status exactly once per invalidation generation', async () => {
    const { rerender, result } = renderHook(() => useWorktreeMap(INPUT));
    await waitFor(() => expect(result.current.statusByPath.get('/repo')?.kind).toBe('ready'));
    expect(checkoutStatusMock).toHaveBeenCalledTimes(1);
    expect(checkoutStatusMock).toHaveBeenCalledWith({ path: '/repo' });

    // A plain `rerender()` would only fail open now: `use-worktree-map.ts`'s
    // `load` and `use-worktree-checkout-status.ts`'s effect both defer their
    // setState calls behind a `Promise.resolve().then()` microtask (to
    // satisfy `react-hooks/set-state-in-effect`), so a synchronous assertion
    // immediately after `rerender()` would always see "not yet called"
    // regardless of whether a regression fired an extra read — the microtask
    // hasn't had a turn yet. `await act(async () => ...)` flushes it first,
    // restoring this assertion's ability to actually catch a regression.
    await act(async () => {
      rerender();
    });
    expect(checkoutStatusMock).toHaveBeenCalledTimes(1);

    act(() => {
      invalidationNonce = 1;
    });
    rerender();
    await waitFor(() => expect(checkoutStatusMock).toHaveBeenCalledTimes(2));
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  // PR #2671 review note 3: `refresh()` used to bump the nonce keying the load
  // effect AND await `load()` directly, so every manual refresh issued TWO
  // concurrent `worktrees.list()` calls — and the surface now has three
  // refresh call sites (adopt, archive, add-as-root). The awaited direct load
  // is the single list read; the nonce bump survives only to re-key the
  // per-card status reads.
  it('manual refresh issues exactly one additional list read and re-keys the statuses', async () => {
    const { result } = renderHook(() => useWorktreeMap(INPUT));
    await waitFor(() => expect(result.current.statusByPath.get('/repo')?.kind).toBe('ready'));
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(checkoutStatusMock).toHaveBeenCalledTimes(1);

    // `act` flushes the post-commit effect re-run that the old double-work
    // shape used as its second list read; without it a regression to two
    // reads would escape the assertion below.
    await act(async () => {
      await result.current.refresh();
    });

    expect(listMock).toHaveBeenCalledTimes(2);
    // Falsifier for the other half of the contract: the manual refresh must
    // still re-run `git status` per card, exactly once.
    await waitFor(() => expect(checkoutStatusMock).toHaveBeenCalledTimes(2));
    // Flush once more: `waitFor` resolves on the FIRST poll that sees 2, so a
    // regression firing a third generation a microtask later would otherwise
    // escape both assertions (PR #2673 review).
    await act(async () => {
      await Promise.resolve();
    });
    expect(checkoutStatusMock).toHaveBeenCalledTimes(2);
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  // PR #2673 review: dropping `manualNonce` from the load effect's key also
  // dropped the implicit cancellation of an in-flight effect-driven load, so
  // without a generation guard an older invalidation-driven `list()` read that
  // resolves AFTER a manual refresh would overwrite the fresher result — e.g.
  // an archived card reappearing until the next unrelated invalidation.
  it('a stale in-flight list read never clobbers a later manual refresh result', async () => {
    const { rerender, result } = renderHook(() => useWorktreeMap(INPUT));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.repositories).toHaveLength(1);

    // Invalidation-driven read B: held open, reading the PRE-archive world.
    let resolveStale: (value: unknown) => void = () => undefined;
    listMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStale = resolve;
        })
    );
    act(() => {
      invalidationNonce = 1;
    });
    rerender();
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));

    // Manual refresh A resolves first with the POST-archive (empty) list.
    listMock.mockResolvedValueOnce({ ok: true, value: [] });
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.repositories).toEqual([]);

    // B resolves last, carrying the stale pre-archive entry: it must be
    // discarded, not applied last-writer-wins.
    await act(async () => {
      resolveStale({ ok: true, value: [entry()] });
    });
    expect(result.current.repositories).toEqual([]);
  });

  // PR #2671 review finding: a mount's `addRootDirectoryByPath` resolving does
  // NOT mean the `roots` row exists — the row is written later by the
  // fire-and-forget mid-session registration (`performRootRegistration`), so a
  // surface-level refresh right after the mount promise races the write and
  // usually re-reads `rootId: null`. The deterministic signal is the canonical
  // adapter→DB mapping publication: `RootIdentityProvider` re-memoizes its
  // context value only when a NEW pair lands (after `reconcileRoots` wrote the
  // row), so the hook re-reads exactly when the row provably exists.
  it('re-reads the list when a root registration publishes a new canonical identity', async () => {
    rootIdentityValue = { resolveAdapterRootId: () => null, workspaceDbRootIds: [] };
    const { rerender, result } = renderHook(() => useWorktreeMap(INPUT));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(listMock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(checkoutStatusMock).toHaveBeenCalledTimes(1));

    act(() => {
      rootIdentityValue = {
        resolveAdapterRootId: () => 'adapter-1',
        workspaceDbRootIds: ['db-root-1'],
      };
    });
    rerender();

    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
    // Falsifier: the identity-driven reload must stay CHEAP — the status
    // effect keys on path CONTENT + the invalidation nonce, neither of which
    // changed, so no extra `git status` per card is spawned.
    expect(checkoutStatusMock).toHaveBeenCalledTimes(1);
  });

  it('does not re-read the list when the identity value is unchanged', async () => {
    rootIdentityValue = { resolveAdapterRootId: () => null, workspaceDbRootIds: [] };
    const { rerender, result } = renderHook(() => useWorktreeMap(INPUT));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(listMock).toHaveBeenCalledTimes(1);

    // Same flush rationale as the invalidation-generation test above: the
    // load defers behind a microtask, so a synchronous assertion would fail
    // open without the act() flush.
    await act(async () => {
      rerender();
    });
    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it('reports a list failure as an error and never as an empty map', async () => {
    listMock.mockResolvedValue({ error: 'The worktree service is not available.', ok: false });

    const { result } = renderHook(() => useWorktreeMap(INPUT));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('The worktree service is not available.');
    expect(result.current.repositories).toEqual([]);
  });

  it('reports a per-card status failure as a stated reason, not as a clean checkout', async () => {
    checkoutStatusMock.mockResolvedValue({ error: 'fatal: not a git repository', ok: false });

    const { result } = renderHook(() => useWorktreeMap(INPUT));

    await waitFor(() => expect(result.current.statusByPath.get('/repo')?.kind).toBe('error'));
    expect(result.current.statusByPath.get('/repo')).toEqual({
      kind: 'error',
      message: 'fatal: not a git repository',
    });
  });
});
