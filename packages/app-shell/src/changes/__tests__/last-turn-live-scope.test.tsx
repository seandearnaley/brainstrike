/**
 * Integration coverage for "Last Turn" as a live STANDING scope (BST-1115
 * smoke feedback). Unlike `changes-navigation-store.test.ts` (which asserts
 * the store's `activeChangeset` object updates), this file combines the REAL
 * store with the REAL `useChangeset` hook so the assertion is the thing the
 * user actually sees: the Changes surface's resolved VIEW reloads for the
 * new run — proving `useChangeset`'s own generation-guarded reload fires,
 * not just that the store produced a new object.
 */
import type { Changeset, ChangesetView, GitResult } from '@brainstrike/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChangesBridge } from '../changes-bridge';
import { useChangesNavigationStore } from '../changes-navigation-store';
import { useRewindStore } from '../rewind-store';
import { useChangeset } from '../use-changeset';

function stubBridge(resolveView: ChangesBridge['resolveView']): void {
  (window as unknown as { changes?: ChangesBridge }).changes = {
    fileDiff: vi.fn(),
    inventory: vi.fn(),
    onInvalidated: vi.fn(() => () => {}),
    resolveView,
  };
}

function viewForRun(runId: string): ChangesetView {
  return {
    changeset: { kind: 'agent-run', runId, threadId: 'thread-1' },
    files: [
      {
        additions: null,
        deletions: null,
        path: `${runId}.ts`,
        repositoryRoot: null,
        revertible: true,
        rootId: 'root-1',
        status: 'modified',
        worktreePath: null,
      },
    ],
    totalAdditions: null,
    totalDeletions: null,
  };
}

/** Mirrors what `ChangesSurface` does: read the store's active changeset, resolve its view. */
function useSurfaceUnderTest() {
  const activeChangeset = useChangesNavigationStore((state) => state.activeChangeset);
  return useChangeset('root-1', activeChangeset);
}

afterEach(() => {
  Reflect.deleteProperty(window as unknown as { changes?: unknown }, 'changes');
  useChangesNavigationStore.getState().reset();
  useRewindStore.getState().reset();
});

describe('Last Turn live retargeting', () => {
  it('reloads the view for the NEW runId when a run finishes while the surface is on Last Turn', async () => {
    const resolveView = vi.fn(
      async (_rootId: string, changeset: Changeset): Promise<GitResult<ChangesetView>> => {
        if (changeset.kind !== 'agent-run') {
          throw new Error('expected an agent-run changeset');
        }
        return { ok: true, value: viewForRun(changeset.runId) };
      }
    );
    stubBridge(resolveView);

    useChangesNavigationStore.setState({
      activeThreadIdentity: { latestRunId: 'run-1', threadId: 'thread-1' },
    });
    act(() => {
      useChangesNavigationStore.getState().selectLastTurn();
    });

    const { result } = renderHook(() => useSurfaceUnderTest());

    await waitFor(() => {
      expect(result.current.view?.files[0]?.path).toBe('run-1.ts');
    });

    // A new run finishes while the user is still on Last Turn — the
    // wrapper's `handleRunFinished` publishes the new identity.
    act(() => {
      useChangesNavigationStore
        .getState()
        .setActiveThreadIdentity({ latestRunId: 'run-2', threadId: 'thread-1' });
    });

    await waitFor(() => {
      expect(result.current.view?.files[0]?.path).toBe('run-2.ts');
    });
    expect(resolveView).toHaveBeenLastCalledWith('root-1', {
      kind: 'agent-run',
      runId: 'run-2',
      threadId: 'thread-1',
    });
  });

  it('does NOT reload the view when a git scope is pinned, even as a new run finishes', async () => {
    const resolveView = vi.fn(
      async (_rootId: string, changeset: Changeset): Promise<GitResult<ChangesetView>> => ({
        ok: true,
        value: { changeset, files: [], totalAdditions: 0, totalDeletions: 0 },
      })
    );
    stubBridge(resolveView);

    const gitScope: Changeset = {
      kind: 'git-scope',
      repositoryRoot: '/repo',
      scope: { kind: 'uncommitted' },
      worktreePath: '/repo',
    };
    useChangesNavigationStore.setState({
      activeThreadIdentity: { latestRunId: 'run-1', threadId: 'thread-1' },
    });
    act(() => {
      useChangesNavigationStore.getState().selectLastTurn();
      useChangesNavigationStore.getState().requestChangeset(gitScope);
    });

    renderHook(() => useSurfaceUnderTest());

    await waitFor(() => {
      expect(resolveView).toHaveBeenCalledWith('root-1', gitScope);
    });
    const callsBeforeRunFinished = resolveView.mock.calls.length;

    act(() => {
      useChangesNavigationStore
        .getState()
        .setActiveThreadIdentity({ latestRunId: 'run-2', threadId: 'thread-1' });
    });

    // Give any wrongly-triggered async reload a tick to (not) happen.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolveView).toHaveBeenCalledTimes(callsBeforeRunFinished);
    expect(useChangesNavigationStore.getState().activeChangeset).toEqual(gitScope);
  });

  it('does NOT reload the view for an explicitly re-pinned specific run, even if it matches the new latestRunId', async () => {
    const resolveView = vi.fn(
      async (_rootId: string, changeset: Changeset): Promise<GitResult<ChangesetView>> => {
        if (changeset.kind !== 'agent-run') {
          throw new Error('expected an agent-run changeset');
        }
        return { ok: true, value: viewForRun(changeset.runId) };
      }
    );
    stubBridge(resolveView);

    const pinnedRun: Changeset = { kind: 'agent-run', runId: 'run-1', threadId: 'thread-1' };
    useChangesNavigationStore.setState({
      activeThreadIdentity: { latestRunId: 'run-1', threadId: 'thread-1' },
    });
    act(() => {
      // A plain requestChangeset (e.g. re-picking the same run explicitly)
      // never sets isOnLastTurn, unlike selectLastTurn.
      useChangesNavigationStore.getState().requestChangeset(pinnedRun);
    });

    const { result } = renderHook(() => useSurfaceUnderTest());

    await waitFor(() => {
      expect(result.current.view?.files[0]?.path).toBe('run-1.ts');
    });

    act(() => {
      useChangesNavigationStore
        .getState()
        .setActiveThreadIdentity({ latestRunId: 'run-2', threadId: 'thread-1' });
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result.current.view?.files[0]?.path).toBe('run-1.ts');
    expect(useChangesNavigationStore.getState().activeChangeset).toEqual(pinnedRun);
  });
});
