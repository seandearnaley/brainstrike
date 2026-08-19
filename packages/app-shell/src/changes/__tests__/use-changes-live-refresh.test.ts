import { createLogger } from '@brainstrike/logging';
import { createFileExplorerRefreshEvent } from '@brainstrike/file-explorer-ui/shell';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChangesBridge, ChangesInvalidationEvent } from '../changes-bridge';
import {
  CROSS_SOURCE_REPOSITORY_REFRESH_COALESCE_MS,
  selectGitScopeRefreshNonce,
  useChangesLiveRefreshStore,
} from '../changes-live-refresh-store';
import { acquireChangesLiveRefreshSubscription } from '../use-changes-live-refresh';

function stubBridge(onInvalidated: ChangesBridge['onInvalidated']): {
  readonly listeners: ((event: ChangesInvalidationEvent) => void)[];
} {
  const listeners: ((event: ChangesInvalidationEvent) => void)[] = [];
  (window as unknown as { changes?: ChangesBridge }).changes = {
    applyRewind: vi.fn(),
    fileDiff: vi.fn(),
    finalizeRewinds: vi.fn(),
    inventory: vi.fn(),
    onInvalidated,
    redoRewind: vi.fn(),
    resolveView: vi.fn(),
    rewindPreview: vi.fn(),
  };
  return { listeners };
}

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(window as unknown as { changes?: unknown }, 'changes');
  useChangesLiveRefreshStore.getState().reset();
  vi.restoreAllMocks();
});

describe('acquireChangesLiveRefreshSubscription (refcounting, PR #2288 review)', () => {
  it('two concurrent holders share ONE bridge subscription; the LAST release unsubscribes; a re-acquire re-subscribes', () => {
    const unsubscribe = vi.fn();
    const onInvalidated = vi.fn(() => unsubscribe);
    stubBridge(onInvalidated);

    const releaseA = acquireChangesLiveRefreshSubscription();
    const releaseB = acquireChangesLiveRefreshSubscription();
    expect(onInvalidated).toHaveBeenCalledTimes(1);

    releaseA();
    expect(unsubscribe).not.toHaveBeenCalled();
    releaseB();
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    const releaseC = acquireChangesLiveRefreshSubscription();
    expect(onInvalidated).toHaveBeenCalledTimes(2);
    releaseC();
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });

  it('a release function is idempotent — double-calling cannot underflow the count', () => {
    const unsubscribe = vi.fn();
    stubBridge(vi.fn(() => unsubscribe));

    const releaseA = acquireChangesLiveRefreshSubscription();
    const releaseB = acquireChangesLiveRefreshSubscription();
    releaseA();
    releaseA();
    // B is still mounted — a double release of A must not have unsubscribed.
    expect(unsubscribe).not.toHaveBeenCalled();
    releaseB();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('delivered events reach the store through the shared listener', () => {
    const stub = stubBridge(
      vi.fn((listener: (event: ChangesInvalidationEvent) => void) => {
        stub.listeners.push(listener);
        return () => {};
      })
    );

    const release = acquireChangesLiveRefreshSubscription();
    stub.listeners[0]?.({ generation: 1, gitCommonDir: '/r/.git', repositoryRoot: '/r' });
    expect(useChangesLiveRefreshStore.getState().anyInvalidationNonce).toBe(1);
    release();
  });

  it('maps a working-tree refresh to only the repository whose worktree contains the changed path, without invalidating inventory', () => {
    vi.useFakeTimers();
    stubBridge(vi.fn(() => () => {}));

    const releaseA = acquireChangesLiveRefreshSubscription({
      repositoryRoot: '/workspace/repo-a',
      rootId: 'root-1',
      worktreePath: '/workspace/repo-a',
    });
    const releaseB = acquireChangesLiveRefreshSubscription({
      repositoryRoot: '/workspace/repo-b',
      rootId: 'root-1',
      worktreePath: '/workspace/repo-b',
    });

    try {
      // Give unknown-key selectors a non-zero conservative baseline. The
      // working-tree signal must advance A from that baseline without moving
      // inventory or B, and without permanently making B a "known" key (its
      // future canonical/symlink metadata guard remains intact).
      useChangesLiveRefreshStore.getState().ingestInvalidation({
        generation: 1,
        gitCommonDir: '/workspace/repo-c/.git',
        repositoryRoot: '/workspace/repo-c',
      });
      expect(
        selectGitScopeRefreshNonce(useChangesLiveRefreshStore.getState(), '/workspace/repo-b')
      ).toBe(1);

      window.dispatchEvent(
        createFileExplorerRefreshEvent({
          roots: [
            {
              changes: [
                {
                  kind: 'file',
                  path: '/workspace/repo-a/src/changed.ts',
                  type: 'modified',
                },
              ],
              rootId: 'root-1',
              rootPath: '/workspace',
            },
          ],
          scope: 'incremental',
          source: 'watcher',
        })
      );
      vi.runAllTimers();

      const state = useChangesLiveRefreshStore.getState();
      expect(state.anyInvalidationNonce).toBe(1);
      expect(selectGitScopeRefreshNonce(state, '/workspace/repo-a')).toBe(2);
      expect(selectGitScopeRefreshNonce(state, '/workspace/repo-b')).toBe(1);
    } finally {
      releaseA();
      releaseB();
    }
  });

  it('keeps full refreshes root-scoped and honors the canonical manual all-roots broadcast', () => {
    stubBridge(vi.fn(() => () => {}));
    const releaseA = acquireChangesLiveRefreshSubscription({
      repositoryRoot: '/repo-a',
      rootId: 'root-a',
      worktreePath: '/repo-a',
    });
    const releaseB = acquireChangesLiveRefreshSubscription({
      repositoryRoot: '/repo-b',
      rootId: 'root-b',
      worktreePath: '/repo-b',
    });

    try {
      window.dispatchEvent(
        createFileExplorerRefreshEvent({
          roots: [{ changes: [], rootId: 'root-a', rootPath: '/repo-a' }],
          scope: 'full',
          source: 'watcher',
        })
      );
      let state = useChangesLiveRefreshStore.getState();
      expect(selectGitScopeRefreshNonce(state, '/repo-a')).toBe(1);
      expect(selectGitScopeRefreshNonce(state, '/repo-b')).toBe(0);

      window.dispatchEvent(
        createFileExplorerRefreshEvent({ roots: [], scope: 'full', source: 'manual' })
      );
      state = useChangesLiveRefreshStore.getState();
      expect(selectGitScopeRefreshNonce(state, '/repo-a')).toBe(2);
      expect(selectGitScopeRefreshNonce(state, '/repo-b')).toBe(1);
      expect(state.anyInvalidationNonce).toBe(0);
    } finally {
      releaseA();
      releaseB();
    }
  });

  it('coalesces nearby working-tree and git-metadata signals into one repository refetch while still invalidating inventory', () => {
    vi.useFakeTimers();
    const stub = stubBridge(
      vi.fn((listener: (event: ChangesInvalidationEvent) => void) => {
        stub.listeners.push(listener);
        return () => {};
      })
    );
    const release = acquireChangesLiveRefreshSubscription({
      repositoryRoot: '/repo',
      rootId: 'root-1',
      worktreePath: '/repo',
    });

    try {
      window.dispatchEvent(
        createFileExplorerRefreshEvent({
          roots: [
            {
              changes: [{ kind: 'file', path: '/repo/file.ts', type: 'modified' }],
              rootId: 'root-1',
              rootPath: '/repo',
            },
          ],
          scope: 'incremental',
          source: 'watcher',
        })
      );
      stub.listeners[0]?.({
        generation: 1,
        gitCommonDir: '/repo/.git',
        repositoryRoot: '/repo',
      });
      vi.runAllTimers();

      const state = useChangesLiveRefreshStore.getState();
      expect(state.anyInvalidationNonce).toBe(1);
      expect(selectGitScopeRefreshNonce(state, '/repo')).toBe(1);
    } finally {
      release();
    }
  });

  it('coalesces at the upstream debounce boundary exactly once, then preserves a third working-tree edit', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const stub = stubBridge(
      vi.fn((listener: (event: ChangesInvalidationEvent) => void) => {
        stub.listeners.push(listener);
        return () => {};
      })
    );
    const release = acquireChangesLiveRefreshSubscription({
      repositoryRoot: '/repo',
      rootId: 'root-1',
      worktreePath: '/repo',
    });
    const workingTreeEvent = createFileExplorerRefreshEvent({
      roots: [
        {
          changes: [{ kind: 'file', path: '/repo/file.ts', type: 'modified' }],
          rootId: 'root-1',
          rootPath: '/repo',
        },
      ],
      scope: 'incremental',
      source: 'watcher',
    });

    try {
      window.dispatchEvent(workingTreeEvent);
      vi.advanceTimersByTime(CROSS_SOURCE_REPOSITORY_REFRESH_COALESCE_MS);
      stub.listeners[0]?.({
        generation: 1,
        gitCommonDir: '/repo/.git',
        repositoryRoot: '/repo',
      });

      let state = useChangesLiveRefreshStore.getState();
      expect(state.anyInvalidationNonce).toBe(1);
      expect(selectGitScopeRefreshNonce(state, '/repo')).toBe(1);

      // The cross-source pair consumed its marker. A third signal is a new
      // working-tree edit, even at the same timestamp, and must stay visible.
      window.dispatchEvent(workingTreeEvent);
      state = useChangesLiveRefreshStore.getState();
      expect(selectGitScopeRefreshNonce(state, '/repo')).toBe(2);

      vi.advanceTimersByTime(CROSS_SOURCE_REPOSITORY_REFRESH_COALESCE_MS + 1);
      stub.listeners[0]?.({
        generation: 2,
        gitCommonDir: '/repo/.git',
        repositoryRoot: '/repo',
      });
      state = useChangesLiveRefreshStore.getState();
      expect(state.anyInvalidationNonce).toBe(2);
      expect(selectGitScopeRefreshNonce(state, '/repo')).toBe(3);
    } finally {
      release();
    }
  });

  it('a THROWING bridge subscribe is logged and does not wedge the channel: after every holder releases, the next acquire retries', () => {
    const logger = createLogger('ChangesLiveRefresh');
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    let attempts = 0;
    const unsubscribe = vi.fn();
    const onInvalidated = vi.fn(() => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('ipcRenderer.on exploded');
      }
      return unsubscribe;
    });
    stubBridge(onInvalidated);

    // First acquire: subscribe throws — must be LOUD, and must not escape
    // (an exception out of a useEffect body would skip React's cleanup).
    const releaseA = acquireChangesLiveRefreshSubscription();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    releaseA();

    // Back at zero holders: the next acquire attempts a fresh subscribe
    // instead of treating the failed one as live forever.
    const releaseB = acquireChangesLiveRefreshSubscription();
    expect(onInvalidated).toHaveBeenCalledTimes(2);
    releaseB();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
