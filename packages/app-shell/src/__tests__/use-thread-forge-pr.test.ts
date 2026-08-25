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

  it('re-reads on a forge:prUpdated push for the same repository', async () => {
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
