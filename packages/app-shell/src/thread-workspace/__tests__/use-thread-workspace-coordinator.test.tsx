import type { ThreadWorkspaceRepository, WorkspaceSnapshotV1 } from '@brainstrike/assistant-data';
import {
  EMPTY_WORKSPACE_SNAPSHOT,
  ThreadWorkspaceUnavailableError,
} from '@brainstrike/assistant-data';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadWorkspaceNavigation } from '../thread-workspace-navigation';
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
    editorState: {} as WorkspaceSnapshotV1['editors'][string],
    expandedPaths: new Set<string>(),
    explorerScrollTop: undefined as number | undefined,
    focusedRootId: null as string | null,
    openAppIds: ['context-explorer'] as readonly string[],
    selection: { appId: 'context-explorer', kind: 'app' } as const as
      | { kind: 'app'; appId: string }
      | { kind: 'file'; tabId: string }
      | { kind: 'empty' },
    tabs: [] as Array<{ compositeKey: string; path: string }>,
    visibleRootIds: null as readonly string[] | null,
  };
  const applied: string[] = [];
  const facade: WorkspaceStateFacade = {
    applyApps: vi.fn((openAppIds, selection) => {
      state.openAppIds = openAppIds;
      state.selection = selection;
      applied.push('apps');
    }),
    applyEditorState: vi.fn((_compositeKey, editor) => {
      state.editorState = editor;
    }),
    applyExpandedPaths: vi.fn((paths) => {
      state.expandedPaths = paths;
    }),
    applyExplorerScrollTop: vi.fn((scrollTop) => {
      state.explorerScrollTop = scrollTop;
    }),
    applyFileTabs: vi.fn((tabs, activeTabId) => {
      state.tabs = [...tabs];
      state.activeTabId = activeTabId;
      applied.push('fileTabs');
    }),
    applyPanes: vi.fn(),
    applyRootViews: vi.fn((focusedRootId, visibleRootIds) => {
      state.focusedRootId = focusedRootId;
      state.visibleRootIds = visibleRootIds;
    }),
    getEditorState: vi.fn(() => state.editorState),
    getExpandedDirectoryPaths: vi.fn(() => state.expandedPaths),
    getExplorerScrollTop: vi.fn(() => state.explorerScrollTop),
    getFileTabs: vi.fn(() => ({ activeTabId: state.activeTabId, tabs: state.tabs })),
    getFocusedRootId: vi.fn(() => state.focusedRootId),
    getOpenAppIds: vi.fn(() => state.openAppIds),
    getRootDescriptors: vi.fn(() => ({})),
    getSelection: vi.fn(() => state.selection),
    getVisibleRootIds: vi.fn(() => state.visibleRootIds),
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
  const navigation = new ThreadWorkspaceNavigation({
    activateThread: vi.fn(),
    openApp: (appId) => {
      state.openAppIds = [...state.openAppIds, appId];
      state.selection = { appId, kind: 'app' };
      notify();
    },
    reportError: vi.fn(),
  });
  return { applied, facade, navigation, notify, repository, rows, state, subscribe };
}

const SNAPSHOT_B: WorkspaceSnapshotV1 = {
  ...EMPTY_WORKSPACE_SNAPSHOT,
  apps: { openAppIds: ['changes'], selection: { appId: 'changes', kind: 'app' } },
  fileTabs: { activeTabId: 'kb', tabs: [{ compositeKey: 'kb', path: 'b.ts' }] },
};

const OPEN_PANE_SNAPSHOT: WorkspaceSnapshotV1 = {
  ...EMPTY_WORKSPACE_SNAPSHOT,
  editors: { kb: { pane: { open: true } } },
  fileTabs: { activeTabId: 'kb', tabs: [{ compositeKey: 'kb', path: 'b.ts' }] },
};

const CLOSED_PANE_SNAPSHOT: WorkspaceSnapshotV1 = {
  ...OPEN_PANE_SNAPSHOT,
  editors: { kb: { pane: { open: false } } },
};

describe('useThreadWorkspaceCoordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  it('does not save another root child into the outgoing workspace while switching', async () => {
    const harness = createHarness();
    harness.rows.set('thread-b', SNAPSHOT_B);
    const { rerender } = render(harness, 'thread-a');
    await waitFor(() => expect(harness.rows.has('thread-a')).toBe(true));
    act(() => {
      harness.navigation.open('brainstrike:workspace', 'thread-b', 'child-b');
    });
    rerender({ activeThreadId: 'thread-b', openThreadIds: ['thread-a', 'thread-b'] });
    await waitFor(() => expect(harness.state.selection).toEqual({ appId: 'child-b', kind: 'app' }));
    expect(harness.rows.get('thread-a')?.apps.openAppIds).not.toContain('child-b');
    expect(harness.rows.get('thread-b')?.apps.openAppIds).toEqual(['changes', 'child-b']);
  });

  it('waits for delayed incoming hydration and discards a superseded child navigation', async () => {
    const harness = createHarness();
    const pending = Promise.withResolvers<WorkspaceSnapshotV1 | null>();
    const { rerender } = render(harness, 'thread-a');
    await waitFor(() => expect(harness.rows.has('thread-a')).toBe(true));
    vi.mocked(harness.repository.getThreadWorkspace).mockImplementation(async (id) =>
      id === 'thread-b' ? pending.promise : null
    );
    act(() => harness.navigation.open('brainstrike:workspace', 'thread-b', 'child-b'));
    rerender({ activeThreadId: 'thread-b', openThreadIds: ['thread-a', 'thread-b'] });
    expect(harness.state.openAppIds).not.toContain('child-b');
    rerender({ activeThreadId: 'thread-c', openThreadIds: ['thread-a', 'thread-b', 'thread-c'] });
    await act(async () => {
      pending.resolve(SNAPSHOT_B);
    });
    expect(harness.state.openAppIds).not.toContain('child-b');
    expect(harness.rows.get('thread-a')?.apps.openAppIds).not.toContain('child-b');
  });

  it('rejects a child navigation while storage is unavailable without replaying it on boot', async () => {
    const harness = createHarness();
    harness.rows.set('thread-a', SNAPSHOT_B);
    const { rerender } = renderHook(
      ({ repository }: { repository: ThreadWorkspaceRepository | null }) =>
        useThreadWorkspaceCoordinator({
          activeThreadId: 'thread-a',
          facade: harness.facade,
          navigation: harness.navigation,
          openThreadIds: ['thread-a'],
          repository,
          resourceId: 'brainstrike:workspace',
          subscribe: harness.subscribe,
        }),
      { initialProps: { repository: null as ThreadWorkspaceRepository | null } }
    );
    const failed = vi.spyOn(harness.navigation, 'failed');
    act(() => harness.navigation.open('brainstrike:workspace', 'thread-a', 'child-a'));
    expect(failed).toHaveBeenCalledWith('brainstrike:workspace', 'thread-a', expect.any(Error));
    expect(harness.navigation.hasPending('brainstrike:workspace', 'thread-a')).toBe(false);
    rerender({ repository: harness.repository });
    await waitFor(() => expect(harness.state.openAppIds).toEqual(['changes']));
    act(() => harness.navigation.open('brainstrike:workspace', 'thread-a', 'child-a'));
    expect(harness.state.openAppIds).toEqual(['changes', 'child-a']);
  });

  it('allows an explicit navigation retry after incoming hydration fails', async () => {
    const harness = createHarness();
    const { rerender } = render(harness, 'thread-a');
    await waitFor(() => expect(harness.rows.has('thread-a')).toBe(true));
    vi.mocked(harness.repository.getThreadWorkspace).mockRejectedValueOnce(
      new Error('Read unavailable')
    );
    act(() => harness.navigation.open('brainstrike:workspace', 'thread-b', 'child-b'));
    rerender({ activeThreadId: 'thread-b', openThreadIds: ['thread-a', 'thread-b'] });
    await waitFor(() =>
      expect(harness.repository.getThreadWorkspace).toHaveBeenCalledWith('thread-b')
    );
    await act(async () => undefined);
    expect(harness.state.openAppIds).not.toContain('child-b');
    vi.mocked(harness.repository.getThreadWorkspace).mockResolvedValueOnce(SNAPSHOT_B);
    act(() => harness.navigation.open('brainstrike:workspace', 'thread-b', 'child-b'));
    await waitFor(() => expect(harness.state.selection).toEqual({ appId: 'child-b', kind: 'app' }));
    expect(harness.rows.get('thread-a')?.apps.openAppIds).not.toContain('child-b');
  });

  function render(harness: ReturnType<typeof createHarness>, initialThread: string | null) {
    return renderHook(
      ({ activeThreadId, openThreadIds }) =>
        useThreadWorkspaceCoordinator({
          activeThreadId,
          debounceMs: 50,
          facade: harness.facade,
          navigation: harness.navigation,
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

  it.each([
    {
      action: 'open',
      apps: {
        openAppIds: ['context-explorer', 'delegated-child'],
        selection: { appId: 'delegated-child', kind: 'app' as const },
      },
    },
    {
      action: 'close',
      apps: {
        openAppIds: ['context-explorer'],
        selection: { appId: 'context-explorer', kind: 'app' as const },
      },
    },
    {
      action: 'select',
      apps: {
        openAppIds: ['context-explorer', 'delegated-child'],
        selection: { appId: 'context-explorer', kind: 'app' as const },
      },
    },
  ])('publishes app $action before a reload can discard the debounce timer', async ({ apps }) => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const harness = createHarness();
    harness.state.openAppIds = ['context-explorer', 'delegated-child'];
    harness.state.selection = { appId: 'delegated-child', kind: 'app' };
    // Opening starts with a closed child; close/selection start with it open.
    if (apps.openAppIds.length === 2 && apps.selection.appId === 'delegated-child') {
      harness.state.openAppIds = ['context-explorer'];
      harness.state.selection = { appId: 'context-explorer', kind: 'app' };
    }
    await act(async () => {
      render(harness, 'thread-a');
    });
    expect(harness.rows.has('thread-a')).toBe(true);
    vi.mocked(harness.repository.setThreadWorkspace).mockClear();

    act(() => {
      harness.state.openAppIds = apps.openAppIds;
      harness.state.selection = apps.selection;
      harness.notify();
    });

    // No clock advance and no unmount flush: publication must happen on the
    // live store change so a document reload cannot drop the pending save.
    expect(harness.repository.setThreadWorkspace).toHaveBeenCalledTimes(1);
    expect(harness.rows.get('thread-a')?.apps).toEqual(apps);
  });

  it('keeps scroll and editor updates debounced when app state is unchanged', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const harness = createHarness();
    harness.state.activeTabId = 'ka';
    harness.state.tabs = [{ compositeKey: 'ka', path: 'a.ts' }];
    await act(async () => {
      render(harness, 'thread-a');
    });
    expect(harness.rows.has('thread-a')).toBe(true);
    vi.mocked(harness.repository.setThreadWorkspace).mockClear();

    act(() => {
      harness.state.explorerScrollTop = 120;
      harness.notify();
      harness.state.editorState = { mode: 'source', scrollTop: 45 };
      harness.notify();
    });
    expect(harness.repository.setThreadWorkspace).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(49);
    });
    expect(harness.repository.setThreadWorkspace).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(harness.repository.setThreadWorkspace).toHaveBeenCalledTimes(1);
    expect(harness.rows.get('thread-a')?.explorer.scrollTop).toBe(120);
    expect(harness.rows.get('thread-a')?.editors['ka']).toEqual({ mode: 'source', scrollTop: 45 });
  });

  it('reports the exact active owner when a workspace save is rejected', async () => {
    const harness = createHarness();
    render(harness, 'thread-a');
    await waitFor(() => expect(harness.rows.has('thread-a')).toBe(true));
    const failed = vi.spyOn(harness.navigation, 'failed');
    const pending = Promise.withResolvers<void>();
    vi.mocked(harness.repository.setThreadWorkspace).mockImplementationOnce(() => pending.promise);
    act(() => {
      harness.state.openAppIds = ['changes'];
      harness.notify();
    });
    const error = new ThreadWorkspaceUnavailableError('thread-a');
    await act(async () => pending.reject(error));
    expect(failed).toHaveBeenCalledExactlyOnceWith('brainstrike:workspace', 'thread-a', error);
  });

  it('preserves the replacement coordinator readiness when an unmounted owner save rejects', async () => {
    const harness = createHarness();
    harness.rows.set('thread-b', SNAPSHOT_B);
    const old = render(harness, 'thread-a');
    await waitFor(() => expect(harness.rows.has('thread-a')).toBe(true));
    const outgoing = Promise.withResolvers<void>();
    vi.mocked(harness.repository.setThreadWorkspace).mockImplementationOnce(() => outgoing.promise);
    act(() => {
      harness.state.openAppIds = ['changes'];
      harness.notify();
    });
    old.unmount();
    render(harness, 'thread-b');
    await waitFor(() => expect(harness.state.tabs).toEqual(SNAPSHOT_B.fileTabs.tabs));
    // New owner's edits are still within its ordinary debounce window.
    act(() => {
      harness.state.tabs = [{ compositeKey: 'pending', path: 'pending.ts' }];
      harness.notify();
    });
    await act(async () => outgoing.reject(new ThreadWorkspaceUnavailableError('thread-a')));
    act(() => {
      harness.navigation.open('brainstrike:workspace', 'thread-b', 'child-b');
      expect(harness.navigation.hasPending('brainstrike:workspace', 'thread-b')).toBe(false);
    });
    expect(harness.state.openAppIds).toContain('child-b');
    expect(harness.state.tabs).toEqual([{ compositeKey: 'pending', path: 'pending.ts' }]);
  });

  it('evicts an outgoing snapshot rejected after its native thread was deleted', async () => {
    const harness = createHarness();
    harness.rows.set('thread-b', SNAPSHOT_B);
    const { rerender } = render(harness, 'thread-a');
    await waitFor(() => expect(harness.rows.has('thread-a')).toBe(true));
    const outgoing = Promise.withResolvers<void>();
    vi.mocked(harness.repository.setThreadWorkspace).mockImplementationOnce(() => outgoing.promise);
    rerender({ activeThreadId: 'thread-b', openThreadIds: ['thread-b'] });
    await waitFor(() => expect(harness.state.tabs).toEqual(SNAPSHOT_B.fileTabs.tabs));
    harness.rows.delete('thread-a');
    await act(async () => outgoing.reject(new ThreadWorkspaceUnavailableError('thread-a')));
    vi.mocked(harness.repository.getThreadWorkspace).mockClear();
    // Even an obsolete restored address must read storage again, never hydrate
    // the outgoing snapshot cached immediately before the rejected save.
    rerender({ activeThreadId: 'thread-a', openThreadIds: ['thread-a', 'thread-b'] });
    await waitFor(() =>
      expect(harness.repository.getThreadWorkspace).toHaveBeenCalledWith('thread-a')
    );
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

  it('hydrates on boot when the repository arrives AFTER the active thread id (BST-1269)', async () => {
    // Reload reality: activeThreadId restores from localStorage instantly
    // while PGlite takes seconds. The switch effect first runs with a null
    // repository; when the repository arrives, previousThreadIdRef already
    // equals activeThreadId — hydration must still happen.
    const harness = createHarness();
    harness.rows.set('thread-a', SNAPSHOT_B);
    const { rerender } = renderHook(
      ({ repository }: { repository: ThreadWorkspaceRepository | null }) =>
        useThreadWorkspaceCoordinator({
          activeThreadId: 'thread-a',
          debounceMs: 50,
          facade: harness.facade,
          openThreadIds: ['thread-a'],
          repository,
          resourceId: 'brainstrike:workspace',
          subscribe: harness.subscribe,
        }),
      { initialProps: { repository: null as ThreadWorkspaceRepository | null } }
    );

    expect(harness.facade.applyFileTabs).not.toHaveBeenCalled();

    rerender({ repository: harness.repository });

    await waitFor(() => {
      expect(harness.facade.applyFileTabs).toHaveBeenCalledWith(
        [{ compositeKey: 'kb', path: 'b.ts' }],
        'kb'
      );
    });
    // The deferred pass must NOT flush the boot state as "outgoing" — that
    // would overwrite the saved row and hydrate the empty flush back.
    expect(harness.rows.get('thread-a')).toBe(SNAPSHOT_B);
  });

  it('does not persist live boot state before initial hydration resolves', async () => {
    const harness = createHarness();
    let resolveHydration: ((snapshot: WorkspaceSnapshotV1 | null) => void) | undefined;
    vi.mocked(harness.repository.getThreadWorkspace).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveHydration = resolve;
        })
    );

    render(harness, 'thread-a');
    act(() => {
      harness.notify();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(80);
    });

    expect(harness.repository.setThreadWorkspace).not.toHaveBeenCalled();

    await act(async () => {
      resolveHydration?.(CLOSED_PANE_SNAPSHOT);
      await Promise.resolve();
    });
    expect(harness.facade.applyPanes).toHaveBeenCalledWith({ kb: { open: false } });
  });

  it('preserves an explicit live pane edit made during initial hydration', async () => {
    const harness = createHarness();
    harness.state.activeTabId = 'kb';
    harness.state.tabs = [{ compositeKey: 'kb', path: 'b.ts' }];
    vi.mocked(harness.facade.getEditorState).mockReturnValue({ pane: { open: true } });
    let resolveHydration: ((snapshot: WorkspaceSnapshotV1 | null) => void) | undefined;
    vi.mocked(harness.repository.getThreadWorkspace).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveHydration = resolve;
        })
    );

    render(harness, 'thread-a');
    act(() => {
      vi.mocked(harness.facade.getEditorState).mockReturnValue({ pane: { open: false } });
      harness.notify();
    });
    await act(async () => {
      resolveHydration?.(OPEN_PANE_SNAPSHOT);
      await Promise.resolve();
    });

    expect(harness.facade.applyPanes).toHaveBeenCalledWith({ kb: { open: false } });
    expect(harness.rows.get('thread-a')?.editors).toEqual({ kb: { pane: { open: false } } });
  });

  it('preserves non-pane live edits made during initial hydration', async () => {
    const harness = createHarness();
    harness.state.activeTabId = 'kb';
    harness.state.editorState = { mode: 'preview', pane: { open: true }, scrollTop: 1 };
    harness.state.expandedPaths = new Set(['/root/old']);
    harness.state.explorerScrollTop = 2;
    harness.state.focusedRootId = 'root-old';
    harness.state.tabs = [{ compositeKey: 'kb', path: 'b.ts' }];
    harness.state.visibleRootIds = ['root-old'];
    const loaded: WorkspaceSnapshotV1 = {
      ...OPEN_PANE_SNAPSHOT,
      apps: { openAppIds: ['changes'], selection: { appId: 'changes', kind: 'app' } },
      editors: { kb: { mode: 'preview', pane: { open: true }, scrollTop: 20 } },
      explorer: { byRoot: { 'root-loaded': { expandedPaths: ['/root/loaded'] } }, scrollTop: 30 },
      roots: { focusedRootId: 'root-loaded', visibleRootIds: ['root-loaded'] },
    };
    let resolveHydration: ((snapshot: WorkspaceSnapshotV1 | null) => void) | undefined;
    vi.mocked(harness.repository.getThreadWorkspace).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveHydration = resolve;
        })
    );

    render(harness, 'thread-a');
    act(() => {
      harness.state.editorState = { mode: 'source', pane: { open: true }, scrollTop: 9 };
      harness.state.expandedPaths = new Set(['/root/user']);
      harness.state.explorerScrollTop = 8;
      harness.state.focusedRootId = 'root-user';
      harness.state.openAppIds = ['database'];
      harness.state.selection = { appId: 'database', kind: 'app' };
      harness.state.visibleRootIds = ['root-user'];
      harness.notify();
    });
    await act(async () => {
      resolveHydration?.(loaded);
      await Promise.resolve();
    });

    expect(harness.rows.get('thread-a')).toEqual({
      ...loaded,
      apps: { openAppIds: ['database'], selection: { appId: 'database', kind: 'app' } },
      editors: { kb: { mode: 'source', pane: { open: true }, scrollTop: 9 } },
      explorer: { byRoot: { '': { expandedPaths: ['/root/user'] } }, scrollTop: 8 },
      roots: { focusedRootId: 'root-user', visibleRootIds: ['root-user'] },
    });
  });

  it('preserves a live file-tab change atomically with its editor state', async () => {
    const harness = createHarness();
    harness.state.activeTabId = 'ka';
    harness.state.editorState = { mode: 'preview', scrollTop: 1 };
    harness.state.tabs = [{ compositeKey: 'ka', path: 'a.ts' }];
    let resolveHydration: ((snapshot: WorkspaceSnapshotV1 | null) => void) | undefined;
    vi.mocked(harness.repository.getThreadWorkspace).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveHydration = resolve;
        })
    );

    render(harness, 'thread-a');
    act(() => {
      harness.state.activeTabId = 'kc';
      harness.state.editorState = { mode: 'source', pane: { open: false }, scrollTop: 7 };
      harness.state.tabs = [{ compositeKey: 'kc', path: 'c.ts' }];
      harness.notify();
    });
    await act(async () => {
      resolveHydration?.(OPEN_PANE_SNAPSHOT);
      await Promise.resolve();
    });

    expect(harness.rows.get('thread-a')?.fileTabs).toEqual({
      activeTabId: 'kc',
      tabs: [{ compositeKey: 'kc', path: 'c.ts' }],
    });
    expect(harness.rows.get('thread-a')?.editors).toEqual({
      kc: { mode: 'source', pane: { open: false }, scrollTop: 7 },
    });
  });

  it('persists pending live edits when initial hydration rejects', async () => {
    const harness = createHarness();
    let rejectHydration: ((error: Error) => void) | undefined;
    vi.mocked(harness.repository.getThreadWorkspace).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectHydration = reject;
        })
    );

    render(harness, 'thread-a');
    act(() => {
      harness.state.activeTabId = 'ka';
      harness.state.editorState = { mode: 'source', scrollTop: 12 };
      harness.state.tabs = [{ compositeKey: 'ka', path: 'a.ts' }];
      harness.notify();
    });
    await act(async () => {
      rejectHydration?.(new Error('database read failed'));
      await Promise.resolve();
    });

    expect(harness.rows.get('thread-a')?.fileTabs).toEqual({
      activeTabId: 'ka',
      tabs: [{ compositeKey: 'ka', path: 'a.ts' }],
    });
    expect(harness.rows.get('thread-a')?.editors).toEqual({
      ka: { mode: 'source', scrollTop: 12 },
    });
  });

  it('does not merge a boot pane edit for a tab absent from the loaded snapshot', async () => {
    const harness = createHarness();
    harness.state.activeTabId = 'ka';
    harness.state.tabs = [{ compositeKey: 'ka', path: 'a.ts' }];
    vi.mocked(harness.facade.getEditorState).mockReturnValue({ pane: { open: true } });
    let resolveHydration: ((snapshot: WorkspaceSnapshotV1 | null) => void) | undefined;
    vi.mocked(harness.repository.getThreadWorkspace).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveHydration = resolve;
        })
    );

    render(harness, 'thread-a');
    act(() => {
      vi.mocked(harness.facade.getEditorState).mockReturnValue({ pane: { open: false } });
      harness.notify();
    });
    await act(async () => {
      resolveHydration?.(OPEN_PANE_SNAPSHOT);
      await Promise.resolve();
    });

    expect(harness.facade.applyPanes).toHaveBeenCalledWith({ kb: { open: true } });
    expect(harness.rows.get('thread-a')).toBeUndefined();
    expect(
      vi
        .mocked(harness.repository.setThreadWorkspace)
        .mock.calls.filter(([threadId]) => threadId === 'thread-a')
    ).toHaveLength(0);
  });

  it('does not leak a prior thread pane through a null transition', async () => {
    const harness = createHarness();
    const { rerender } = render(harness, 'thread-a');

    await waitFor(() => {
      expect(harness.rows.has('thread-a')).toBe(true);
    });
    harness.state.activeTabId = 'ka';
    harness.state.tabs = [{ compositeKey: 'ka', path: 'a.ts' }];
    vi.mocked(harness.facade.getEditorState).mockReturnValue({ pane: { open: true } });

    rerender({ activeThreadId: null, openThreadIds: [] });
    let resolveHydration: ((snapshot: WorkspaceSnapshotV1 | null) => void) | undefined;
    vi.mocked(harness.repository.getThreadWorkspace).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveHydration = resolve;
        })
    );
    vi.mocked(harness.facade.applyPanes).mockClear();
    rerender({ activeThreadId: 'thread-b', openThreadIds: ['thread-b'] });

    act(() => {
      vi.mocked(harness.facade.getEditorState).mockReturnValue({ pane: { open: false } });
      harness.notify();
    });
    await act(async () => {
      resolveHydration?.(OPEN_PANE_SNAPSHOT);
      await Promise.resolve();
    });

    expect(harness.facade.applyPanes).toHaveBeenCalledWith({ kb: { open: true } });
    expect(harness.rows.get('thread-b')).toBeUndefined();
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
