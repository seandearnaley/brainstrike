// BST-568 slice 3: per-root watcher health state for Explorer UI.

import type { FileSystemAdapter, WatcherRootHealthEvent } from '@brainstrike/types';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AdaptersProvider } from '../adapters-context';
import { useWatcherHealth } from '../use-watcher-health';

function makeEvent(
  rootPath: string,
  state: WatcherRootHealthEvent['state']
): WatcherRootHealthEvent {
  return {
    backend: 'fs-events',
    rootPath,
    state,
    timestamp: 1,
    watchId: `watch-${rootPath}`,
  };
}

function createWrapper(adapter: Partial<FileSystemAdapter>) {
  const storageAdapter = {
    clear: vi.fn(),
    getAllKeys: vi.fn(),
    getItem: vi.fn(),
    removeItem: vi.fn(),
    setItem: vi.fn(),
  };
  return ({ children }: { children: ReactNode }) => (
    <AdaptersProvider
      fileSystemAdapter={adapter as FileSystemAdapter}
      storageAdapter={storageAdapter as never}
    >
      {children}
    </AdaptersProvider>
  );
}

describe('useWatcherHealth', () => {
  it('collects per-root health from the adapter capability', () => {
    let push: ((event: WatcherRootHealthEvent) => void) | null = null;
    const unsubscribe = vi.fn();
    const adapter: Partial<FileSystemAdapter> = {
      onWatcherHealth: (callback) => {
        push = callback;
        return unsubscribe;
      },
      platform: 'electron',
    };
    const { result, unmount } = renderHook(() => useWatcherHealth(), {
      wrapper: createWrapper(adapter),
    });

    expect(result.current.healthByRoot.size).toBe(0);
    act(() => {
      push?.(makeEvent('/roots/a', 'failed'));
      push?.(makeEvent('/roots/b', 'degraded'));
    });
    expect(result.current.healthByRoot.get('/roots/a')?.state).toBe('failed');
    expect(result.current.healthByRoot.get('/roots/b')?.state).toBe('degraded');

    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('no-ops on adapters without the capability (web)', () => {
    const { result } = renderHook(() => useWatcherHealth(), {
      wrapper: createWrapper({ platform: 'web' }),
    });
    expect(result.current.healthByRoot.size).toBe(0);
  });

  it('retry delegates to the adapter and reports unsupported without it', async () => {
    const retryWatcher = vi.fn().mockResolvedValue({ retried: true });
    const withCapability = renderHook(() => useWatcherHealth(), {
      wrapper: createWrapper({
        onWatcherHealth: () => () => undefined,
        platform: 'electron',
        retryWatcher,
      }),
    });
    await expect(withCapability.result.current.retry('/roots/a')).resolves.toEqual({
      retried: true,
    });
    expect(retryWatcher).toHaveBeenCalledWith('/roots/a');

    const withoutCapability = renderHook(() => useWatcherHealth(), {
      wrapper: createWrapper({ platform: 'web' }),
    });
    await expect(withoutCapability.result.current.retry('/roots/a')).resolves.toEqual({
      reason: 'unsupported',
      retried: false,
    });
  });
});
