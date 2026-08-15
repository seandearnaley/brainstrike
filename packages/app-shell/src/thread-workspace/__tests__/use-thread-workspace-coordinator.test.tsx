import type { ThreadWorkspaceRepository, WorkspaceSnapshotV1 } from '@brainstrike/assistant-data';
import { EMPTY_WORKSPACE_SNAPSHOT } from '@brainstrike/assistant-data';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useThreadWorkspaceCoordinator } from '../use-thread-workspace-coordinator';
import type { WorkspaceStateFacade } from '../workspace-snapshot-io';

/**
 * A minimal in-memory "live store": one mutable state bag the facade reads
 * and writes, plus a subscriber list the coordinator's aggregated
 * subscription taps.
 */
function createHarness() {
  const listeners = new Set<() => void>();
  const state = {
    activeTabId: null as string | null,
    openAppIds: ['context-explorer'] as readonly string[],
    selection: { appId: 'context-explorer', kind: 'app' } as const as
      | { kind: 'app'; appId: string }
      | { kind: 'file'; tabId: string }
      | { kind: 'empty' },
    tabs: [] as Array<{ compositeKey: string; path: string }>,
  };
  const applied: string[] = [];
  const facade: WorkspaceStateFacade = {
    applyApps: vi.fn((openAppIds, selection) => {
      state.openAppIds = openAppIds;
      state.selection = selection;
      applied.push('apps');
    }),
    applyEditorState: vi.fn(),
    applyExpandedPaths: vi.fn(),
    applyExplorerScrollTop: vi.fn(),
    applyFileTabs: vi.fn((tabs, activeTabId) => {
      state.tabs = [...tabs];
      state.activeTabId = activeTabId;
      applied.push('fileTabs');
    }),
    applyRootViews: vi.fn(),
    getEditorState: vi.fn(() => ({})),
    getExpandedDirectoryPaths: vi.fn(() => new Set<string>()),
    getExplorerScrollTop: vi.fn(() => undefined),
    getFileTabs: vi.fn(() => ({ activeTabId: state.activeTabId, tabs: state.tabs })),
    getFocusedRootId: vi.fn(() => null),
    getOpenAppIds: vi.fn(() => state.openAppIds),
    getRootDescriptors: vi.fn(() => ({})),
    getSelection: vi.fn(() => state.selection),
    getVisibleRootIds: vi.fn(() => null),
  };
  const rows = new Map<string, WorkspaceSnapshotV1>();
  const repository: ThreadWorkspaceRepository = {
    getThreadWorkspace: vi.fn(async (threadId: string) => rows.get(threadId) ?? null),
    getThreadWorkspaces: vi.fn(async (threadIds: readonly string[]) => {
      const map = new Map<string, WorkspaceSnapshotV1>();
      for (const id of threadIds) {
        const row = rows.get(id);
        if (row) {
          map.set(id, row);
        }
      }
      return map;
    }),
    setThreadWorkspace: vi.fn(async (threadId: string, _resourceId, snapshot) => {
      rows.set(threadId, snapshot);
    }),
  };
  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  return { applied, facade, notify, repository, rows, state, subscribe };
}

const SNAPSHOT_B: WorkspaceSnapshotV1 = {
  ...EMPTY_WORKSPACE_SNAPSHOT,
  apps: { openAppIds: ['changes'], selection: { appId: 'changes', kind: 'app' } },
  fileTabs: { activeTabId: 'kb', tabs: [{ compositeKey: 'kb', path: 'b.ts' }] },
};

describe('useThreadWorkspaceCoordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  function render(harness: ReturnType<typeof createHarness>, initialThread: string | null) {
    return renderHook(
      ({ activeThreadId, openThreadIds }) =>
        useThreadWorkspaceCoordinator({
          activeThreadId,
          debounceMs: 50,
          facade: harness.facade,
          openThreadIds,
          repository: harness.repository,
          resourceId: 'brainstrike:workspace',
          subscribe: harness.subscribe,
        }),
      {
        initialProps: {
          activeThreadId: initialThread,
          openThreadIds: ['thread-a'] as readonly string[],
        },
      }
    );
  }

  it('debounce-persists live store changes under the active thread', async () => {
    const harness = createHarness();
    render(harness, 'thread-a');

    // Mount performs the first-run INHERIT write for thread-a; wait it out
    // and count only the debounced saves that follow.
    await waitFor(() => {
      expect(harness.rows.has('thread-a')).toBe(true);
    });
    vi.mocked(harness.repository.setThreadWorkspace).mockClear();

    act(() => {
      harness.state.tabs = [{ compositeKey: 'ka', path: 'a.ts' }];
      harness.notify();
      harness.notify(); // multiple ticks collapse into one save
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(80);
    });

    expect(harness.repository.setThreadWorkspace).toHaveBeenCalledTimes(1);
    expect(harness.rows.get('thread-a')?.fileTabs.tabs).toEqual([
      { compositeKey: 'ka', path: 'a.ts' },
    ]);
  });

  it('on switch: flushes outgoing synchronously, hydrates incoming from the repository', async () => {
    const harness = createHarness();
    harness.rows.set('thread-b', SNAPSHOT_B);
    const { rerender } = render(harness, 'thread-a');

    act(() => {
      harness.state.tabs = [{ compositeKey: 'ka', path: 'a.ts' }];
      harness.notify();
    });

    rerender({ activeThreadId: 'thread-b', openThreadIds: ['thread-a', 'thread-b'] });

    // Outgoing thread-a persisted with its tabs, without waiting for debounce.
    expect(harness.rows.get('thread-a')?.fileTabs.tabs).toEqual([
      { compositeKey: 'ka', path: 'a.ts' },
    ]);
    // Incoming thread-b hydrates (async repository fetch).
    await waitFor(() => {
      expect(harness.facade.applyFileTabs).toHaveBeenCalledWith(
        [{ compositeKey: 'kb', path: 'b.ts' }],
        'kb'
      );
    });
    expect(harness.facade.applyApps).toHaveBeenCalledWith(['changes'], {
      appId: 'changes',
      kind: 'app',
    });
  });

  it('hydration never echoes back as a save under the incoming thread', async () => {
    const harness = createHarness();
    harness.rows.set('thread-b', SNAPSHOT_B);
    const { rerender } = render(harness, 'thread-a');

    rerender({ activeThreadId: 'thread-b', openThreadIds: ['thread-a', 'thread-b'] });
    await waitFor(() => {
      expect(harness.facade.applyFileTabs).toHaveBeenCalled();
    });
    const writesAfterHydrate = vi
      .mocked(harness.repository.setThreadWorkspace)
      .mock.calls.filter(([threadId]) => threadId === 'thread-b');
    // The only permissible thread-b write would be a LATER user edit; the
    // hydration apply itself (which fires store listeners) must not save.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });
    expect(
      vi
        .mocked(harness.repository.setThreadWorkspace)
        .mock.calls.filter(([threadId]) => threadId === 'thread-b').length
    ).toBe(writesAfterHydrate.length);
  });

  it('inherits the current workspace when the incoming thread has no row (create / first run)', async () => {
    const harness = createHarness();
    harness.state.tabs = [{ compositeKey: 'ka', path: 'a.ts' }];
    const { rerender } = render(harness, 'thread-a');

    rerender({ activeThreadId: 'thread-new', openThreadIds: ['thread-a', 'thread-new'] });

    await waitFor(() => {
      expect(harness.rows.get('thread-new')?.fileTabs.tabs).toEqual([
        { compositeKey: 'ka', path: 'a.ts' },
      ]);
    });
    // Inherit does NOT hydrate — the live stores already show this state.
    expect(harness.facade.applyFileTabs).not.toHaveBeenCalled();
  });

  it('preloads open-thread snapshots and hydrates from cache synchronously on switch', async () => {
    const harness = createHarness();
    harness.rows.set('thread-b', SNAPSHOT_B);
    const { rerender } = render(harness, 'thread-a');

    // Preload runs for open threads.
    rerender({ activeThreadId: 'thread-a', openThreadIds: ['thread-a', 'thread-b'] });
    await waitFor(() => {
      expect(harness.repository.getThreadWorkspaces).toHaveBeenCalled();
    });

    vi.mocked(harness.repository.getThreadWorkspace).mockClear();
    rerender({ activeThreadId: 'thread-b', openThreadIds: ['thread-a', 'thread-b'] });

    // Cache hit: hydrated without a per-thread fetch.
    expect(harness.repository.getThreadWorkspace).not.toHaveBeenCalled();
    expect(harness.facade.applyFileTabs).toHaveBeenCalledWith(
      [{ compositeKey: 'kb', path: 'b.ts' }],
      'kb'
    );
  });

  it('a superseding switch discards the stale fetch result', async () => {
    const harness = createHarness();
    let resolveB: ((s: WorkspaceSnapshotV1 | null) => void) | undefined;
    vi.mocked(harness.repository.getThreadWorkspace).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveB = resolve;
        })
    );
    harness.rows.set('thread-c', SNAPSHOT_B);
    const { rerender } = render(harness, 'thread-a');

    rerender({ activeThreadId: 'thread-b', openThreadIds: ['thread-a', 'thread-b', 'thread-c'] });
    rerender({ activeThreadId: 'thread-c', openThreadIds: ['thread-a', 'thread-b', 'thread-c'] });

    await waitFor(() => {
      expect(harness.facade.applyFileTabs).toHaveBeenCalled();
    });
    vi.mocked(harness.facade.applyFileTabs).mockClear();

    act(() => {
      resolveB?.({ ...EMPTY_WORKSPACE_SNAPSHOT });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    // The stale thread-b result must not clobber thread-c's hydrated state.
    expect(harness.facade.applyFileTabs).not.toHaveBeenCalled();
  });
});
