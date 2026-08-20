import { createFileExplorerRefreshEvent } from '@brainstrike/file-explorer-ui/shell';
import type {
  Changeset,
  ChangesetView,
  ChangesInvalidationEvent,
  GitResult,
  StructuredFileDiff,
} from '@brainstrike/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChangesBridge } from '../changes-bridge';
import {
  REPOSITORY_REFRESH_BATCH_MS,
  useChangesLiveRefreshStore,
} from '../changes-live-refresh-store';
import { useChangesNavigationStore } from '../changes-navigation-store';
import { useRewindStore } from '../rewind-store';
import { RESOLVE_VIEW_TIMEOUT_MS, useChangeset } from '../use-changeset';

const CHANGESET: Changeset = { kind: 'agent-run', runId: 'run-1', threadId: 'thread-1' };

function viewFixture(overrides: Partial<ChangesetView> = {}): ChangesetView {
  return {
    changeset: CHANGESET,
    files: [],
    totalAdditions: null,
    totalDeletions: null,
    ...overrides,
  };
}

/**
 * Accepts the changeset-diff half of the bridge and fills in the rewind half
 * (BST-1115) with inert mocks — these tests exercise `useChangeset`, which
 * never calls them, but `resolveChangesBridge` requires a FULLY formed bridge.
 */
function stubBridge(
  bridge: Pick<ChangesBridge, 'fileDiff' | 'inventory' | 'resolveView'> &
    Partial<Pick<ChangesBridge, 'onInvalidated'>>
): void {
  (window as unknown as { changes?: ChangesBridge }).changes = {
    applyRewind: vi.fn(),
    finalizeRewinds: vi.fn(),
    onInvalidated: vi.fn(() => () => {}),
    redoRewind: vi.fn(),
    rewindPreview: vi.fn(),
    ...bridge,
  };
}

afterEach(() => {
  Reflect.deleteProperty(window as unknown as { changes?: unknown }, 'changes');
  useRewindStore.getState().reset();
  useChangesNavigationStore.getState().reset();
  useChangesLiveRefreshStore.getState().reset();
  vi.useRealTimers();
});

describe('useChangeset', () => {
  it('reports a typed error (never silent loading) with the bridge absent and a changeset selected', async () => {
    const { result } = renderHook(() => useChangeset('root-1', CHANGESET));

    await waitFor(() => {
      expect(result.current.available).toBe(false);
    });
    expect(result.current.view).toBeNull();
    // NO ETERNAL LOADING: `ChangesSurface` reads "no view and no error" as
    // "still loading", so an inert hook WITH a selection must say why.
    await waitFor(() => {
      expect(result.current.error).toBe(
        'changeset-unavailable: the changes service is not available in this build.'
      );
    });

    const diff = await result.current.fileDiff('src/file.ts');
    expect(diff).toEqual({
      error: 'changeset-unavailable: no active bridge, root, or changeset',
      ok: false,
    });
  });

  it('reports a typed error when no root can resolve the selected changeset', async () => {
    const resolveView = vi.fn();
    stubBridge({ fileDiff: vi.fn(), inventory: vi.fn(), resolveView });
    const { result } = renderHook(() => useChangeset(null, CHANGESET));

    await waitFor(() => {
      expect(result.current.error).toBe(
        'changeset-unresolvable: no workspace root can resolve this changeset. For a Git scope, the worktree is outside every mounted root.'
      );
    });
    expect(result.current.view).toBeNull();
    expect(resolveView).not.toHaveBeenCalled();
  });

  it('times out a resolveView that never answers, into an error the surface can retry', async () => {
    vi.useFakeTimers();
    const resolveView = vi.fn(() => new Promise<GitResult<ChangesetView>>(() => undefined));
    stubBridge({ fileDiff: vi.fn(), inventory: vi.fn(), resolveView });

    const { result } = renderHook(() => useChangeset('root-1', CHANGESET));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(resolveView).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();
    expect(result.current.view).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RESOLVE_VIEW_TIMEOUT_MS);
    });

    expect(result.current.view).toBeNull();
    expect(result.current.error).toContain('changeset-resolve-timeout:');
  });

  it('re-resolves the active changeset when the live Last Turn nonce is bumped', async () => {
    const resolveView = vi.fn(
      async (): Promise<GitResult<ChangesetView>> => ({ ok: true, value: viewFixture() })
    );
    stubBridge({ fileDiff: vi.fn(), inventory: vi.fn(), resolveView });
    act(() => {
      useChangesNavigationStore.getState().selectLastTurn();
      useChangesNavigationStore.getState().setActiveThreadIdentity({
        latestRunId: 'run-1',
        threadId: 'thread-1',
      });
      useChangesNavigationStore.getState().selectLastTurn();
    });

    renderHook(() => useChangeset('root-1', CHANGESET));
    await waitFor(() => expect(resolveView).toHaveBeenCalledTimes(1));

    act(() => {
      useChangesNavigationStore.getState().requestLiveLastTurnRefresh('thread-1');
    });
    await waitFor(() => expect(resolveView).toHaveBeenCalledTimes(2));

    // A bump for a DIFFERENT thread is a no-op, so nothing refetches.
    act(() => {
      useChangesNavigationStore.getState().requestLiveLastTurnRefresh('thread-other');
    });
    await waitFor(() => expect(resolveView).toHaveBeenCalledTimes(2));
  });

  describe('live git invalidation push (BST-1161)', () => {
    const GIT_CHANGESET: Changeset = {
      kind: 'git-scope',
      repositoryRoot: '/repo-a',
      scope: { kind: 'uncommitted' },
      worktreePath: '/repo-a',
    };

    function stubBridgeWithInvalidations(resolveView: ChangesBridge['resolveView']): {
      readonly emit: (event: ChangesInvalidationEvent) => void;
      readonly onInvalidated: ReturnType<typeof vi.fn>;
      readonly unsubscribe: ReturnType<typeof vi.fn>;
    } {
      const listeners: ((event: ChangesInvalidationEvent) => void)[] = [];
      const unsubscribe = vi.fn();
      const onInvalidated = vi.fn((listener: (event: ChangesInvalidationEvent) => void) => {
        listeners.push(listener);
        return unsubscribe;
      });
      stubBridge({ fileDiff: vi.fn(), inventory: vi.fn(), onInvalidated, resolveView });
      return {
        emit: (event) => {
          for (const listener of listeners) {
            listener(event);
          }
        },
        onInvalidated,
        unsubscribe,
      };
    }

    it('subscribes once, re-resolves a git-scope changeset when ITS repository is invalidated, and unsubscribes on unmount', async () => {
      const resolveView = vi.fn(
        async (): Promise<GitResult<ChangesetView>> => ({
          ok: true,
          value: viewFixture({ changeset: GIT_CHANGESET }),
        })
      );
      const pushed = stubBridgeWithInvalidations(resolveView);

      const { unmount } = renderHook(() => useChangeset('root-1', GIT_CHANGESET));
      await waitFor(() => expect(resolveView).toHaveBeenCalledTimes(1));
      expect(pushed.onInvalidated).toHaveBeenCalledTimes(1);

      act(() => {
        pushed.emit({ generation: 1, gitCommonDir: '/repo-a/.git', repositoryRoot: '/repo-a' });
      });
      await waitFor(() => expect(resolveView).toHaveBeenCalledTimes(2));

      // Another repo's activity must NOT churn this view.
      act(() => {
        pushed.emit({ generation: 2, gitCommonDir: '/repo-b/.git', repositoryRoot: '/repo-b' });
      });
      expect(resolveView).toHaveBeenCalledTimes(2);

      // An UNMAPPED invalidation conservatively refetches every git scope.
      act(() => {
        pushed.emit({ generation: 3, gitCommonDir: '/mystery/.git', repositoryRoot: null });
      });
      await waitFor(() => expect(resolveView).toHaveBeenCalledTimes(3));

      unmount();
      expect(pushed.unsubscribe).toHaveBeenCalledTimes(1);
    });

    it('never re-resolves a snapshot-sourced (agent-run) changeset on git invalidation', async () => {
      const resolveView = vi.fn(
        async (): Promise<GitResult<ChangesetView>> => ({ ok: true, value: viewFixture() })
      );
      const pushed = stubBridgeWithInvalidations(resolveView);

      renderHook(() => useChangeset('root-1', CHANGESET));
      await waitFor(() => expect(resolveView).toHaveBeenCalledTimes(1));

      act(() => {
        pushed.emit({ generation: 1, gitCommonDir: '/repo-a/.git', repositoryRoot: '/repo-a' });
        pushed.emit({ generation: 2, gitCommonDir: '/mystery/.git', repositoryRoot: null });
      });
      expect(resolveView).toHaveBeenCalledTimes(1);
    });

    it('re-resolves a git-scope changeset on a canonical working-tree refresh for its root, but not another root', async () => {
      vi.useFakeTimers();
      const pendingResolves: Array<(result: GitResult<ChangesetView>) => void> = [];
      const resolveView = vi.fn(
        () =>
          new Promise<GitResult<ChangesetView>>((resolve) => {
            pendingResolves.push(resolve);
          })
      );
      stubBridgeWithInvalidations(resolveView);

      const { unmount } = renderHook(() => useChangeset('root-1', GIT_CHANGESET));
      expect(resolveView).toHaveBeenCalledTimes(1);
      await act(async () => {
        pendingResolves[0]?.({
          ok: true,
          value: viewFixture({ changeset: GIT_CHANGESET }),
        });
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      await act(async () => {
        window.dispatchEvent(
          createFileExplorerRefreshEvent({
            roots: [
              {
                changes: [{ kind: 'file', path: '/repo-a/src/live.ts', type: 'modified' }],
                rootId: 'root-1',
                rootPath: '/repo-a',
              },
            ],
            scope: 'incremental',
            source: 'watcher',
          })
        );
        await vi.advanceTimersByTimeAsync(REPOSITORY_REFRESH_BATCH_MS);
      });
      expect(resolveView).toHaveBeenCalledTimes(2);
      await act(async () => {
        pendingResolves[1]?.({
          ok: true,
          value: viewFixture({ changeset: GIT_CHANGESET }),
        });
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      act(() => {
        window.dispatchEvent(
          createFileExplorerRefreshEvent({
            roots: [
              {
                changes: [{ kind: 'file', path: '/other-repo/src/unrelated.ts', type: 'modified' }],
                rootId: 'root-2',
                rootPath: '/other-repo',
              },
            ],
            scope: 'incremental',
            source: 'watcher',
          })
        );
      });
      expect(resolveView).toHaveBeenCalledTimes(2);
      unmount();
    });
  });

  it('is inert with a null changeset even when the bridge is present', async () => {
    const resolveView = vi.fn();
    stubBridge({ fileDiff: vi.fn(), inventory: vi.fn(), resolveView });
    const { result } = renderHook(() => useChangeset('root-1', null));

    await waitFor(() => {
      expect(result.current.available).toBe(true);
    });
    expect(result.current.view).toBeNull();
    expect(resolveView).not.toHaveBeenCalled();
  });

  it('loads the changeset view through the bridge on mount', async () => {
    const view = viewFixture({
      files: [
        {
          additions: null,
          deletions: null,
          path: 'src/file.ts',
          repositoryRoot: null,
          revertible: true,
          rootId: 'root-1',
          status: 'modified',
          worktreePath: null,
        },
      ],
    });
    const resolveView = vi.fn(
      async (): Promise<GitResult<ChangesetView>> => ({ ok: true, value: view })
    );
    stubBridge({ fileDiff: vi.fn(), inventory: vi.fn(), resolveView });
    const { result } = renderHook(() => useChangeset('root-1', CHANGESET));

    await waitFor(() => {
      expect(result.current.view).toEqual(view);
    });
    expect(resolveView).toHaveBeenCalledWith('root-1', CHANGESET);
    expect(result.current.error).toBeNull();
  });

  it('surfaces a failed load with its stable error prefix, and clears the view', async () => {
    const resolveView = vi.fn(
      async (): Promise<GitResult<ChangesetView>> => ({
        error: 'changeset-snapshot-missing: no snapshot covers this turn',
        ok: false,
      })
    );
    stubBridge({ fileDiff: vi.fn(), inventory: vi.fn(), resolveView });
    const { result } = renderHook(() => useChangeset('root-1', CHANGESET));

    await waitFor(() => {
      expect(result.current.error).toBe('changeset-snapshot-missing: no snapshot covers this turn');
    });
    expect(result.current.view).toBeNull();
  });

  it('delegates fileDiff to the bridge and returns the result to the caller', async () => {
    const diffResult: GitResult<StructuredFileDiff> = {
      ok: true,
      value: {
        additions: null,
        content: { kind: 'binary' },
        deletions: null,
        hunks: [],
        path: 'src/file.ts',
        status: 'modified',
      },
    };
    const fileDiff = vi.fn(async () => diffResult);
    const resolveView = vi.fn(
      async (): Promise<GitResult<ChangesetView>> => ({ ok: true, value: viewFixture() })
    );
    stubBridge({ fileDiff, inventory: vi.fn(), resolveView });
    const { result } = renderHook(() => useChangeset('root-1', CHANGESET));

    await waitFor(() => {
      expect(result.current.view).not.toBeNull();
    });
    const returned = await result.current.fileDiff('src/file.ts');
    expect(returned).toEqual(diffResult);
    expect(fileDiff).toHaveBeenCalledWith('root-1', CHANGESET, 'src/file.ts');
  });

  // A multi-root `agent-run` turn can edit more than one workspace root in a
  // single run — the per-file caller passes the ENTRY's own rootId, which
  // must win over the hook's own `rootId` (the surface's focused root).
  it('uses the entry-supplied rootId over the hook rootId when both are present', async () => {
    const diffResult: GitResult<StructuredFileDiff> = {
      ok: true,
      value: {
        additions: null,
        content: { kind: 'binary' },
        deletions: null,
        hunks: [],
        path: 'src/file.ts',
        status: 'modified',
      },
    };
    const fileDiff = vi.fn(async () => diffResult);
    const resolveView = vi.fn(
      async (): Promise<GitResult<ChangesetView>> => ({ ok: true, value: viewFixture() })
    );
    stubBridge({ fileDiff, inventory: vi.fn(), resolveView });
    const { result } = renderHook(() => useChangeset('root-focused', CHANGESET));

    await waitFor(() => {
      expect(result.current.view).not.toBeNull();
    });
    await result.current.fileDiff('src/file.ts', 'root-entry');
    expect(fileDiff).toHaveBeenCalledWith('root-entry', CHANGESET, 'src/file.ts');
  });

  it('ignores a stale refresh resolving after a newer one (generation guard)', async () => {
    const deferred: Array<(result: GitResult<ChangesetView>) => void> = [];
    const resolveView = vi.fn(
      () =>
        new Promise<GitResult<ChangesetView>>((resolve) => {
          deferred.push(resolve);
        })
    );
    stubBridge({ fileDiff: vi.fn(), inventory: vi.fn(), resolveView });
    const { result } = renderHook(() => useChangeset('root-1', CHANGESET));

    await waitFor(() => {
      expect(deferred.length).toBeGreaterThan(0);
    });

    await act(async () => {
      const older = result.current.refresh();
      const newer = result.current.refresh();
      // Resolve the NEWEST call first, then every earlier (stale) one —
      // including the mount-triggered load still in flight.
      const staleFixture = viewFixture({
        files: [
          {
            additions: null,
            deletions: null,
            path: 'stale.ts',
            repositoryRoot: null,
            revertible: false,
            rootId: 'root-1',
            status: 'modified',
            worktreePath: null,
          },
        ],
      });
      const freshFixture = viewFixture({
        files: [
          {
            additions: null,
            deletions: null,
            path: 'fresh.ts',
            repositoryRoot: null,
            revertible: false,
            rootId: 'root-1',
            status: 'modified',
            worktreePath: null,
          },
        ],
      });
      deferred.at(-1)?.({ ok: true, value: freshFixture });
      for (const resolve of deferred.slice(0, -1)) {
        resolve({ ok: true, value: staleFixture });
      }
      await Promise.all([older, newer]);
    });

    expect(result.current.view?.files.map((file) => file.path)).toEqual(['fresh.ts']);
  });

  it('a rerender with a NEW literal of EQUAL structure does not re-fetch (review finding: identity loop)', async () => {
    const resolveView = vi.fn(
      async (): Promise<GitResult<ChangesetView>> => ({ ok: true, value: viewFixture() })
    );
    stubBridge({ fileDiff: vi.fn(), inventory: vi.fn(), resolveView });
    // Every render builds a BRAND NEW object literal — the natural way a
    // consumer would call this hook (e.g. `{ kind: 'agent-run', runId,
    // threadId }` inline) — never the SAME `CHANGESET` reference other tests
    // in this file pass.
    const { rerender } = renderHook(
      ({ runId }: { runId: string }) =>
        useChangeset('root-1', { kind: 'agent-run', runId, threadId: 'thread-1' }),
      { initialProps: { runId: 'run-1' } }
    );

    await waitFor(() => {
      expect(resolveView).toHaveBeenCalledTimes(1);
    });

    // Rerender with a structurally IDENTICAL (but referentially NEW) literal.
    rerender({ runId: 'run-1' });
    rerender({ runId: 'run-1' });

    // Give any runaway effect loop a chance to fire before asserting it didn't.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resolveView).toHaveBeenCalledTimes(1);

    // A genuinely DIFFERENT changeset (new runId) still triggers a fresh load.
    rerender({ runId: 'run-2' });
    await waitFor(() => {
      expect(resolveView).toHaveBeenCalledTimes(2);
    });
    expect(resolveView).toHaveBeenLastCalledWith('root-1', {
      kind: 'agent-run',
      runId: 'run-2',
      threadId: 'thread-1',
    });
  });
});

/**
 * A rewind reverts the very files an open changeset describes, so after one the
 * SAME `Changeset` value names a different resolved view (BST-1115). Before
 * this, the Changes surface behind the confirm modal kept listing files the
 * rewind had already put back — symptom 3 of the live smoke.
 */
describe('useChangeset — rewind invalidation', () => {
  it('re-resolves the view when a rewind applies or is undone', async () => {
    const resolveView = vi.fn(
      async (): Promise<GitResult<ChangesetView>> => ({ ok: true, value: viewFixture() })
    );
    stubBridge({ fileDiff: vi.fn(), inventory: vi.fn(), resolveView });
    renderHook(() => useChangeset('root-1', CHANGESET));

    await waitFor(() => expect(resolveView).toHaveBeenCalledTimes(1));

    act(() => useRewindStore.getState().markRewindApplied());
    await waitFor(() => expect(resolveView).toHaveBeenCalledTimes(2));

    // The redo is another durable change, not a special case.
    act(() => useRewindStore.getState().markRewindApplied());
    await waitFor(() => expect(resolveView).toHaveBeenCalledTimes(3));
  });

  it('does not re-resolve while the rewind modal is merely opened and closed', async () => {
    const resolveView = vi.fn(
      async (): Promise<GitResult<ChangesetView>> => ({ ok: true, value: viewFixture() })
    );
    stubBridge({ fileDiff: vi.fn(), inventory: vi.fn(), resolveView });
    renderHook(() => useChangeset('root-1', CHANGESET));

    await waitFor(() => expect(resolveView).toHaveBeenCalledTimes(1));

    act(() => {
      useRewindStore
        .getState()
        .openRewind({ composerText: null, target: { messageId: 'msg-1', threadId: 'thread-1' } });
      useRewindStore.getState().closeRewind();
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resolveView).toHaveBeenCalledTimes(1);
  });
});
