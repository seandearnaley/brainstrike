import type { Changeset, ChangesetView, GitResult, StructuredFileDiff } from '@brainstrike/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChangesBridge } from '../changes-bridge';
import { useRewindStore } from '../rewind-store';
import { useChangeset } from '../use-changeset';

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
function stubBridge(bridge: Pick<ChangesBridge, 'fileDiff' | 'inventory' | 'resolveView'>): void {
  (window as unknown as { changes?: ChangesBridge }).changes = {
    applyRewind: vi.fn(),
    finalizeRewinds: vi.fn(),
    redoRewind: vi.fn(),
    rewindPreview: vi.fn(),
    ...bridge,
  };
}

afterEach(() => {
  Reflect.deleteProperty(window as unknown as { changes?: unknown }, 'changes');
  useRewindStore.getState().reset();
});

describe('useChangeset', () => {
  it('is inert with the bridge absent: unavailable, no view, a typed fileDiff failure', async () => {
    const { result } = renderHook(() => useChangeset('root-1', CHANGESET));

    await waitFor(() => {
      expect(result.current.available).toBe(false);
    });
    expect(result.current.view).toBeNull();
    expect(result.current.error).toBeNull();

    const diff = await result.current.fileDiff('src/file.ts');
    expect(diff).toEqual({
      error: 'changeset-unavailable: no active bridge, root, or changeset',
      ok: false,
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
        error: 'journal-content-expired: before content is gone',
        ok: false,
      })
    );
    stubBridge({ fileDiff: vi.fn(), inventory: vi.fn(), resolveView });
    const { result } = renderHook(() => useChangeset('root-1', CHANGESET));

    await waitFor(() => {
      expect(result.current.error).toBe('journal-content-expired: before content is gone');
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
