/**
 * BST-1115 smoke round 2, defect 2: after a files-mode rewind the Explorer had
 * no way to learn what changed — the bulk unlink burst can kill the watcher
 * outright (health `failed` ⇒ the root stays connected but UNWATCHED, with no
 * auto-restart), leaving a tree full of nodes for files that no longer exist.
 *
 * These pin the two recoveries and, just as importantly, their LIMITS: the
 * refresh goes through the EXISTING overflow-shaped pipeline (one event, not a
 * second channel), and the retry fires ONLY for a genuinely dead watch.
 */
import type { AssistantRewindRootOutcome } from '@brainstrike/assistant-contract';
import { AdaptersProvider } from '@brainstrike/file-explorer-hooks';
import {
  FILE_EXPLORER_REFRESH_EVENT,
  type FileExplorerRefreshEvent,
} from '@brainstrike/file-explorer-ui/shell';
import type { FileSystemAdapter, WatcherRootHealthEvent } from '@brainstrike/types';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRewindExplorerRecovery } from '../use-rewind-explorer-recovery';

const ROOT_A = 'root-a';
const ROOT_B = 'root-b';
const PATH_A = '/roots/a';
const PATH_B = '/roots/b';

function rootOutcome(
  rootId: string,
  rootPath: string | null,
  overrides: Partial<AssistantRewindRootOutcome> = {}
): AssistantRewindRootOutcome {
  return {
    attempted: 1,
    conflicts: 0,
    failed: 0,
    reverted: 1,
    rootId,
    rootLabel: `Root ${rootId}`,
    rootPath,
    ...overrides,
  };
}

function healthEvent(
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

interface Harness {
  readonly pushHealth: (event: WatcherRootHealthEvent) => void;
  readonly retryWatcher: ReturnType<typeof vi.fn>;
  readonly wrapper: ({ children }: { children: ReactNode }) => ReactNode;
}

function createHarness(): Harness {
  let push: ((event: WatcherRootHealthEvent) => void) | null = null;
  const retryWatcher = vi.fn(async () => ({ retried: true as const }));
  const adapter: Partial<FileSystemAdapter> = {
    onWatcherHealth: (callback) => {
      push = callback;
      return () => undefined;
    },
    platform: 'electron',
    retryWatcher,
  };
  const storageAdapter = {
    clear: vi.fn(),
    getAllKeys: vi.fn(),
    getItem: vi.fn(),
    removeItem: vi.fn(),
    setItem: vi.fn(),
  };
  return {
    pushHealth: (event) => {
      act(() => {
        push?.(event);
      });
    },
    retryWatcher,
    wrapper: ({ children }: { children: ReactNode }) => (
      <AdaptersProvider
        fileSystemAdapter={adapter as FileSystemAdapter}
        storageAdapter={storageAdapter as never}
      >
        {children}
      </AdaptersProvider>
    ),
  };
}

let refreshEvents: FileExplorerRefreshEvent['detail'][] = [];

function captureRefreshEvent(event: Event): void {
  refreshEvents.push((event as FileExplorerRefreshEvent).detail);
}

beforeEach(() => {
  refreshEvents = [];
  window.addEventListener(FILE_EXPLORER_REFRESH_EVENT, captureRefreshEvent);
});

afterEach(() => {
  window.removeEventListener(FILE_EXPLORER_REFRESH_EVENT, captureRefreshEvent);
  vi.restoreAllMocks();
});

describe('useRewindExplorerRecovery', () => {
  it('dispatches ONE overflow-shaped full refresh naming every connected root', async () => {
    const harness = createHarness();
    const { result } = renderHook(() => useRewindExplorerRecovery(), {
      wrapper: harness.wrapper,
    });

    await act(async () => {
      await result.current([rootOutcome(ROOT_A, PATH_A), rootOutcome(ROOT_B, PATH_B)]);
    });

    expect(refreshEvents).toHaveLength(1);
    // `source: 'watcher'` + `scope: 'full'` is the OVERFLOW path, and that is
    // the point: unlike `manual`, every provider reacts — including the outer
    // refresh-authority one a single-root workspace is made of.
    expect(refreshEvents[0]).toEqual({
      roots: [
        { changes: [], rootId: ROOT_A, rootPath: PATH_A },
        { changes: [], rootId: ROOT_B, rootPath: PATH_B },
      ],
      scope: 'full',
      source: 'watcher',
    });
  });

  it('retries ONLY a root whose watcher is failed', async () => {
    const harness = createHarness();
    const { result } = renderHook(() => useRewindExplorerRecovery(), {
      wrapper: harness.wrapper,
    });
    // Root A's watch is dead; root B is degraded, which keeps a LIVE
    // subscription that recovers itself — retrying it would tear down a
    // working watch.
    harness.pushHealth(healthEvent(PATH_A, 'failed'));
    harness.pushHealth(healthEvent(PATH_B, 'degraded'));

    await act(async () => {
      await result.current([rootOutcome(ROOT_A, PATH_A), rootOutcome(ROOT_B, PATH_B)]);
    });

    expect(harness.retryWatcher).toHaveBeenCalledTimes(1);
    expect(harness.retryWatcher).toHaveBeenCalledWith(PATH_A);
  });

  it('never retries a healthy watcher', async () => {
    const harness = createHarness();
    const { result } = renderHook(() => useRewindExplorerRecovery(), {
      wrapper: harness.wrapper,
    });
    harness.pushHealth(healthEvent(PATH_A, 'healthy'));

    await act(async () => {
      await result.current([rootOutcome(ROOT_A, PATH_A)]);
    });

    expect(refreshEvents).toHaveLength(1);
    expect(harness.retryWatcher).not.toHaveBeenCalled();
  });

  it('skips a disconnected root instead of dispatching a pathless entry', async () => {
    const harness = createHarness();
    const { result } = renderHook(() => useRewindExplorerRecovery(), {
      wrapper: harness.wrapper,
    });
    harness.pushHealth(healthEvent(PATH_A, 'failed'));

    await act(async () => {
      // `rootPath: null` is the MULTI-ROOT BAR's "reported but not connected":
      // nothing was written there, so there is no tree to refresh and no watch
      // to retry.
      await result.current([rootOutcome(ROOT_A, PATH_A), rootOutcome(ROOT_B, null)]);
    });

    expect(refreshEvents[0]?.roots).toEqual([{ changes: [], rootId: ROOT_A, rootPath: PATH_A }]);
    expect(harness.retryWatcher).toHaveBeenCalledExactlyOnceWith(PATH_A);
  });

  it('dispatches nothing for a rewind that touched no root', async () => {
    const harness = createHarness();
    const { result } = renderHook(() => useRewindExplorerRecovery(), {
      wrapper: harness.wrapper,
    });

    // `conversation-only` returns an empty `rootOutcomes` — no file reached
    // disk, so a full re-enumeration of anything would be pure noise.
    await act(async () => {
      await result.current([]);
    });

    expect(refreshEvents).toHaveLength(0);
    expect(harness.retryWatcher).not.toHaveBeenCalled();
  });

  it('survives a retry that rejects, having already dispatched the refresh', async () => {
    const harness = createHarness();
    harness.retryWatcher.mockRejectedValueOnce(new Error('watch-retry channel gone'));
    const { result } = renderHook(() => useRewindExplorerRecovery(), {
      wrapper: harness.wrapper,
    });
    harness.pushHealth(healthEvent(PATH_A, 'failed'));

    await act(async () => {
      await expect(result.current([rootOutcome(ROOT_A, PATH_A)])).resolves.toBeUndefined();
    });

    expect(refreshEvents).toHaveLength(1);
  });
});
