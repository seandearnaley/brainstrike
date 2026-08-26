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

    rerender();
    expect(checkoutStatusMock).toHaveBeenCalledTimes(1);

    act(() => {
      invalidationNonce = 1;
    });
    rerender();
    await waitFor(() => expect(checkoutStatusMock).toHaveBeenCalledTimes(2));
    expect(listMock).toHaveBeenCalledTimes(2);
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
