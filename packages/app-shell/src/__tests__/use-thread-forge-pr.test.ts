import type { ForgePrStatus } from '@brainstrike/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useThreadForgePr } from '../hooks/use-thread-forge-pr';

const prStatus: ForgePrStatus = {
  kind: 'pr',
  observedAt: '2026-08-24T00:00:00.000Z',
  pullRequest: {
    checks: [],
    checksRollup: 'none',
    headSha: 'sha',
    isDraft: false,
    number: 7,
    reviewDecision: null,
    state: 'open',
    title: 't',
    url: 'https://example.test/pull/7',
  },
};

function installBridge(overrides: Record<string, unknown> = {}) {
  const listeners: ((event: unknown) => void)[] = [];
  const bridge = {
    cacheSnapshot: async () => ({ ok: true as const, value: [] }),
    identity: vi.fn(),
    onPrUpdated: vi.fn((callback: (event: unknown) => void) => {
      listeners.push(callback);
      return () => {
        listeners.splice(listeners.indexOf(callback), 1);
      };
    }),
    prStatus: vi.fn(async () => ({ ok: true, value: prStatus })),
    refresh: vi.fn(async () => ({ ok: true, value: prStatus })),
    ...overrides,
  };
  Object.defineProperty(window, 'forge', { configurable: true, value: bridge, writable: true });
  return { bridge, listeners };
}

afterEach(() => {
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'forge');
  vi.restoreAllMocks();
});

describe('useThreadForgePr', () => {
  it('is inert with no bridge (web)', async () => {
    const { result } = renderHook(() => useThreadForgePr('root-1'));
    await waitFor(() => expect(result.current.status).toBeNull());
    expect(result.current.diagnostic).toBeNull();
  });

  it('is inert with no root', async () => {
    const { bridge } = installBridge();
    renderHook(() => useThreadForgePr(null));
    await waitFor(() => expect(bridge.refresh).not.toHaveBeenCalled());
  });

  it('refreshes with reason "window" on mount and exposes the status', async () => {
    const { bridge } = installBridge();
    const { result } = renderHook(() => useThreadForgePr('root-1'));
    await waitFor(() => expect(result.current.status).toEqual(prStatus));
    expect(bridge.refresh).toHaveBeenCalledWith('root-1', { reason: 'window' });
  });

  it('exposes an unavailable failure as the BranchChip diagnostic', async () => {
    const unavailable: ForgePrStatus = {
      failure: { detail: 'GitHub CLI (gh) was not found on PATH.', reason: 'gh-missing' },
      kind: 'unavailable',
    };
    installBridge({ refresh: vi.fn(async () => ({ ok: true, value: unavailable })) });
    const { result } = renderHook(() => useThreadForgePr('root-1'));
    await waitFor(() =>
      expect(result.current.diagnostic).toBe('GitHub CLI (gh) was not found on PATH.')
    );
  });

  it('surfaces a bridge error as a diagnostic instead of an empty chip', async () => {
    installBridge({ refresh: vi.fn(async () => ({ error: 'roots unavailable', ok: false })) });
    const { result } = renderHook(() => useThreadForgePr('root-1'));
    await waitFor(() => expect(result.current.diagnostic).toBe('roots unavailable'));
    expect(result.current.status).toBeNull();
  });

  // BST-1391 fix round (L2): renamed from "...for the same repository" — the
  // hook never inspects `repoCommonDir`, so it re-reads on ANY push for ANY
  // repository, not just the one it is scoped to. Per-repo filtering would
  // need its own identity call (main only tells the renderer a branch name +
  // repoCommonDir, not which `dbRootId` that maps to) and is deliberately
  // deferred — this test documents the current, honest behavior rather than
  // the narrower one its old name implied.
  it('re-reads on any forge:prUpdated push (no per-repo filtering yet)', async () => {
    const { bridge, listeners } = installBridge();
    const { result } = renderHook(() => useThreadForgePr('root-1'));
    await waitFor(() => expect(result.current.status).toEqual(prStatus));
    const before = bridge.prStatus.mock.calls.length;
    act(() => {
      for (const listener of listeners) {
        listener({
          branch: 'b',
          generation: 1,
          pullRequest: null,
          repoCommonDir: '/r',
          transitions: [],
        });
      }
    });
    await waitFor(() => expect(bridge.prStatus.mock.calls.length).toBeGreaterThan(before));
  });

  // BST-1391 fix round (F1): reproduces the loop shape the cumulative-nonce
  // implementation had — after one user Refresh, `userNonce` never returns to
  // 0, so the OLD code read every later push as "userNonce > 0" and called
  // `refresh(reason:'user')` (no floor) again instead of the cheap
  // `prStatus` read a push should trigger. That refresh's own PR-updated push
  // would feed right back into `onPrUpdated`, making it unbounded in
  // production. This asserts the push after a user refresh reads the cache
  // exactly once and never triggers a second `refresh` call.
  it('does not loop: a push after a user refresh reads the cache instead of refreshing again', async () => {
    const { bridge, listeners } = installBridge();
    const { result } = renderHook(() => useThreadForgePr('root-1'));
    await waitFor(() => expect(result.current.status).toEqual(prStatus));
    expect(bridge.refresh).toHaveBeenCalledTimes(1); // mount

    act(() => {
      result.current.refresh();
    });
    await waitFor(() => expect(bridge.refresh).toHaveBeenCalledTimes(2)); // user refresh
    expect(bridge.refresh).toHaveBeenNthCalledWith(2, 'root-1', { reason: 'user' });

    const refreshCallsBeforePush = bridge.refresh.mock.calls.length;
    const prStatusCallsBeforePush = bridge.prStatus.mock.calls.length;
    act(() => {
      for (const listener of listeners) {
        listener({
          branch: 'b',
          generation: 1,
          pullRequest: null,
          repoCommonDir: '/r',
          transitions: [],
        });
      }
    });
    await waitFor(() =>
      expect(bridge.prStatus.mock.calls.length).toBe(prStatusCallsBeforePush + 1)
    );
    // The push must NOT have provoked a second refresh — this is the assertion
    // that falsifies the loop.
    expect(bridge.refresh).toHaveBeenCalledTimes(refreshCallsBeforePush);
  });

  // BST-1391 fix round (F1b): the OLD cumulative test also meant a focus
  // AFTER a user refresh kept reading `userNonce > 0` as true forever, so
  // every later focus also refreshed with reason 'user' (no floor) instead
  // of 'window' (60 s floor). This is the second half of the same bug.
  it('a focus after a user refresh uses reason "window" — the floor applies again', async () => {
    const { bridge } = installBridge();
    const { result } = renderHook(() => useThreadForgePr('root-1'));
    await waitFor(() => expect(result.current.status).toEqual(prStatus));

    act(() => {
      result.current.refresh();
    });
    await waitFor(() =>
      expect(bridge.refresh).toHaveBeenLastCalledWith('root-1', { reason: 'user' })
    );

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() =>
      expect(bridge.refresh).toHaveBeenLastCalledWith('root-1', { reason: 'window' })
    );
  });

  // BST-1391 fix round (F1c / opus M1): a root change must drive its own
  // refresh(reason:'window') — never a `prStatus` cache read (that would
  // show a stale status under the new root's identity) and never a carried
  // over 'user' reason from a refresh the PRIOR root triggered.
  it('a root change is its own trigger: refresh(reason: "window"), never a carried-over reason', async () => {
    const { bridge } = installBridge();
    const { rerender, result } = renderHook(({ rootId }) => useThreadForgePr(rootId), {
      initialProps: { rootId: 'root-1' as string | null },
    });
    await waitFor(() => expect(result.current.status).toEqual(prStatus));
    expect(bridge.refresh).toHaveBeenNthCalledWith(1, 'root-1', { reason: 'window' });

    act(() => {
      result.current.refresh();
    });
    await waitFor(() =>
      expect(bridge.refresh).toHaveBeenNthCalledWith(2, 'root-1', { reason: 'user' })
    );

    rerender({ rootId: 'root-2' });
    await waitFor(() =>
      expect(bridge.refresh).toHaveBeenNthCalledWith(3, 'root-2', { reason: 'window' })
    );
    expect(bridge.prStatus).not.toHaveBeenCalled();
  });

  // BST-1391 fix round (F2): the reviewer's fix — a `stale` observation whose
  // last-known `pullRequest` is `null` has nothing for the PR chip to render,
  // so the failure that produced it is the only thing left to explain.
  it('a stale observation with no last-known pull request still carries the diagnostic', async () => {
    const staleWithNull: ForgePrStatus = {
      failure: { detail: 'gh-unauthenticated: run `gh auth login`.', reason: 'gh-unauthenticated' },
      kind: 'stale',
      observedAt: '2026-08-24T00:00:00.000Z',
      pullRequest: null,
    };
    installBridge({ refresh: vi.fn(async () => ({ ok: true, value: staleWithNull })) });
    const { result } = renderHook(() => useThreadForgePr('root-1'));
    await waitFor(() =>
      expect(result.current.diagnostic).toBe('gh-unauthenticated: run `gh auth login`.')
    );
    expect(result.current.status).toEqual(staleWithNull);
  });

  it('refresh() asks with reason "user"', async () => {
    const { bridge } = installBridge();
    const { result } = renderHook(() => useThreadForgePr('root-1'));
    await waitFor(() => expect(result.current.status).toEqual(prStatus));
    act(() => {
      result.current.refresh();
    });
    await waitFor(() => expect(bridge.refresh).toHaveBeenCalledWith('root-1', { reason: 'user' }));
  });

  it('never renders one root’s status under another', async () => {
    installBridge();
    const { rerender, result } = renderHook(({ rootId }) => useThreadForgePr(rootId), {
      initialProps: { rootId: 'root-1' as string | null },
    });
    await waitFor(() => expect(result.current.status).toEqual(prStatus));
    rerender({ rootId: 'root-2' });
    expect(result.current.status).toBeNull();
  });
});
