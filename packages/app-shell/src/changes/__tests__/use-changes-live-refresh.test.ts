import {
  createFileExplorerRefreshEvent,
  type FileExplorerRefreshEventDetail,
} from '@brainstrike/file-explorer-ui/shell';
import { createLogger } from '@brainstrike/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChangesBridge, ChangesInvalidationEvent } from '../changes-bridge';
import {
  REPOSITORY_REFRESH_BATCH_MS,
  REPOSITORY_REFRESH_MAX_WAIT_MS,
  selectGitScopeRefreshNonce,
  useChangesLiveRefreshStore,
} from '../changes-live-refresh-store';
import {
  acquireChangesLiveRefreshSubscription,
  normalizeRefreshPath,
} from '../use-changes-live-refresh';

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
  Reflect.deleteProperty(window as unknown as { changes?: unknown }, 'changes');
  useChangesLiveRefreshStore.getState().reset();
  vi.useRealTimers();
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

  it('maps filtered-boundary evidence only to intersecting repositories in the named root', () => {
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
    const releaseOtherRoot = acquireChangesLiveRefreshSubscription({
      repositoryRoot: '/other/repo',
      rootId: 'root-2',
      worktreePath: '/other/repo',
    });

    try {
      const detail = {
        roots: [
          {
            changes: [
              {
                kind: 'file',
                path: '/workspace/repo-a/src/also-visible.ts',
                type: 'modified',
              },
            ],
            filteredChangeBoundaries: ['repo-a/dist'],
            rootId: 'root-1',
            rootPath: '/workspace',
          },
        ],
        scope: 'incremental',
        source: 'watcher',
      } satisfies FileExplorerRefreshEventDetail;
      window.dispatchEvent(createFileExplorerRefreshEvent(detail));
      vi.runAllTimers();

      const state = useChangesLiveRefreshStore.getState();
      expect(selectGitScopeRefreshNonce(state, '/workspace/repo-a')).toBe(1);
      expect(selectGitScopeRefreshNonce(state, '/workspace/repo-b')).toBe(0);
      expect(selectGitScopeRefreshNonce(state, '/other/repo')).toBe(0);
      expect(state.anyInvalidationNonce).toBe(0);
    } finally {
      releaseA();
      releaseB();
      releaseOtherRoot();
    }
  });

  it('fails open within only the named root when filtered-boundary evidence overflows', () => {
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
    const releaseOtherRoot = acquireChangesLiveRefreshSubscription({
      repositoryRoot: '/other/repo',
      rootId: 'root-2',
      worktreePath: '/other/repo',
    });

    try {
      const detail = {
        roots: [
          {
            changes: [],
            filteredChangeBoundaries: Array.from(
              { length: 64 },
              (_, index) => `unknown-${index}/dist`
            ),
            filteredChangeBoundariesOverflow: true,
            rootId: 'root-1',
            rootPath: '/workspace',
          },
        ],
        scope: 'incremental',
        source: 'watcher',
      } satisfies FileExplorerRefreshEventDetail;
      window.dispatchEvent(createFileExplorerRefreshEvent(detail));
      vi.runAllTimers();

      const state = useChangesLiveRefreshStore.getState();
      expect(selectGitScopeRefreshNonce(state, '/workspace/repo-a')).toBe(1);
      expect(selectGitScopeRefreshNonce(state, '/workspace/repo-b')).toBe(1);
      expect(selectGitScopeRefreshNonce(state, '/other/repo')).toBe(0);
      expect(state.anyInvalidationNonce).toBe(0);
    } finally {
      releaseA();
      releaseB();
      releaseOtherRoot();
    }
  });

  it('normalizes each changed path once when equivalent registrations share one repository scan', () => {
    vi.useFakeTimers();
    stubBridge(vi.fn(() => () => {}));
    const releaseChangesSurface = acquireChangesLiveRefreshSubscription({
      repositoryRoot: '/workspace/repo',
      rootId: 'root-1',
      worktreePath: '/workspace/repo',
    });
    const releaseGitPanel = acquireChangesLiveRefreshSubscription({
      repositoryRoot: '/workspace/repo/',
      rootId: 'root-1',
      worktreePath: '/workspace/repo/',
    });
    let pathReads = 0;
    const changes = Array.from({ length: 128 }, (_, index) => ({
      kind: 'file' as const,
      get path(): string {
        pathReads += 1;
        return index === 127
          ? '/workspace/repo/src/changed.ts'
          : `/workspace/sibling/generated-${index}.ts`;
      },
      type: 'modified' as const,
    }));

    try {
      window.dispatchEvent(
        createFileExplorerRefreshEvent({
          roots: [{ changes, rootId: 'root-1', rootPath: '/workspace' }],
          scope: 'incremental',
          source: 'watcher',
        })
      );
      vi.runAllTimers();

      expect(pathReads).toBe(changes.length);
      expect(
        selectGitScopeRefreshNonce(useChangesLiveRefreshStore.getState(), '/workspace/repo')
      ).toBe(1);
      expect(
        selectGitScopeRefreshNonce(useChangesLiveRefreshStore.getState(), '/workspace/repo/')
      ).toBe(1);
    } finally {
      releaseChangesSurface();
      releaseGitPanel();
    }
  });

  it('keeps full refreshes root-scoped and honors the canonical manual all-roots broadcast', () => {
    vi.useFakeTimers();
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
      vi.runAllTimers();
      let state = useChangesLiveRefreshStore.getState();
      expect(selectGitScopeRefreshNonce(state, '/repo-a')).toBe(1);
      expect(selectGitScopeRefreshNonce(state, '/repo-b')).toBe(0);

      window.dispatchEvent(
        createFileExplorerRefreshEvent({ roots: [], scope: 'full', source: 'manual' })
      );
      vi.runAllTimers();
      state = useChangesLiveRefreshStore.getState();
      expect(selectGitScopeRefreshNonce(state, '/repo-a')).toBe(2);
      expect(selectGitScopeRefreshNonce(state, '/repo-b')).toBe(1);
      expect(state.anyInvalidationNonce).toBe(0);
    } finally {
      releaseA();
      releaseB();
    }
  });

  it('batches nearby working-tree and git-metadata evidence into one repository notification while still invalidating inventory', () => {
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
      expect(selectGitScopeRefreshNonce(state, '/repo')).toBe(2);
    } finally {
      release();
    }
  });

  it('batches at the upstream debounce boundary without discarding a third working-tree edit', () => {
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
      vi.setSystemTime(REPOSITORY_REFRESH_BATCH_MS);
      stub.listeners[0]?.({
        generation: 1,
        gitCommonDir: '/repo/.git',
        repositoryRoot: '/repo',
      });

      let state = useChangesLiveRefreshStore.getState();
      expect(state.anyInvalidationNonce).toBe(1);
      expect(selectGitScopeRefreshNonce(state, '/repo')).toBe(0);

      // A third signal is distinct evidence. It joins the same trailing batch
      // and is all visible in the one post-latest-signal notification.
      window.dispatchEvent(workingTreeEvent);
      vi.runAllTimers();
      state = useChangesLiveRefreshStore.getState();
      expect(selectGitScopeRefreshNonce(state, '/repo')).toBe(3);

      vi.setSystemTime(REPOSITORY_REFRESH_BATCH_MS + REPOSITORY_REFRESH_MAX_WAIT_MS + 1);
      stub.listeners[0]?.({
        generation: 2,
        gitCommonDir: '/repo/.git',
        repositoryRoot: '/repo',
      });
      vi.runAllTimers();
      state = useChangesLiveRefreshStore.getState();
      expect(state.anyInvalidationNonce).toBe(2);
      expect(selectGitScopeRefreshNonce(state, '/repo')).toBe(4);
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

  it('fails open within the durable root when presentation and canonical path vocabularies cannot intersect lexically', () => {
    vi.useFakeTimers();
    stubBridge(vi.fn(() => () => {}));
    const release = acquireChangesLiveRefreshSubscription({
      repositoryRoot: '/real/workspace/repo',
      rootId: 'root-1',
      worktreePath: '/real/workspace/repo',
    });

    try {
      window.dispatchEvent(
        createFileExplorerRefreshEvent({
          roots: [
            {
              changes: [
                {
                  kind: 'file',
                  path: '/presentation/workspace/repo/src/live.ts',
                  type: 'modified',
                },
              ],
              rootId: 'root-1',
              rootPath: '/presentation/workspace/repo',
            },
          ],
          scope: 'incremental',
          source: 'watcher',
        })
      );
      vi.runAllTimers();

      expect(
        selectGitScopeRefreshNonce(useChangesLiveRefreshStore.getState(), '/real/workspace/repo')
      ).toBe(1);
    } finally {
      release();
    }
  });

  it('keeps working-tree keys separate from metadata-known keys so a later canonical event refreshes a presentation-path consumer', () => {
    vi.useFakeTimers();
    const stub = stubBridge(
      vi.fn((listener: (event: ChangesInvalidationEvent) => void) => {
        stub.listeners.push(listener);
        return () => {};
      })
    );
    const release = acquireChangesLiveRefreshSubscription({
      repositoryRoot: '/presentation/repo',
      rootId: 'root-1',
      worktreePath: '/presentation/repo',
    });

    try {
      window.dispatchEvent(
        createFileExplorerRefreshEvent({
          roots: [
            {
              changes: [{ kind: 'file', path: '/presentation/repo/file.ts', type: 'modified' }],
              rootId: 'root-1',
              rootPath: '/presentation/repo',
            },
          ],
          scope: 'incremental',
          source: 'watcher',
        })
      );
      vi.runAllTimers();
      expect(
        selectGitScopeRefreshNonce(useChangesLiveRefreshStore.getState(), '/presentation/repo')
      ).toBe(1);

      vi.advanceTimersByTime(1001);
      stub.listeners[0]?.({
        generation: 1,
        gitCommonDir: '/real/repo/.git',
        repositoryRoot: '/real/repo',
      });
      expect(
        selectGitScopeRefreshNonce(useChangesLiveRefreshStore.getState(), '/presentation/repo')
      ).toBe(2);
    } finally {
      release();
    }
  });

  it('losslessly batches working-tree, metadata, then working-tree evidence into one trailing repository notification', () => {
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
    const refreshEvent = createFileExplorerRefreshEvent({
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
    let previous = selectGitScopeRefreshNonce(useChangesLiveRefreshStore.getState(), '/repo');
    const observed: number[] = [];
    const unsubscribe = useChangesLiveRefreshStore.subscribe((state) => {
      const next = selectGitScopeRefreshNonce(state, '/repo');
      if (next !== previous) {
        observed.push(next);
        previous = next;
      }
    });

    try {
      window.dispatchEvent(refreshEvent);
      stub.listeners[0]?.({
        generation: 1,
        gitCommonDir: '/repo/.git',
        repositoryRoot: '/repo',
      });
      window.dispatchEvent(refreshEvent);
      vi.runAllTimers();

      expect(selectGitScopeRefreshNonce(useChangesLiveRefreshStore.getState(), '/repo')).toBe(3);
      expect(observed).toEqual([3]);
    } finally {
      unsubscribe();
      release();
    }
  });

  it('flushes a continuously re-armed repository batch at the 1s starvation bound', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    stubBridge(vi.fn(() => () => {}));
    const release = acquireChangesLiveRefreshSubscription({
      repositoryRoot: '/repo',
      rootId: 'root-1',
      worktreePath: '/repo',
    });
    const refreshEvent = createFileExplorerRefreshEvent({
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
      window.dispatchEvent(refreshEvent);
      const rearmStep = REPOSITORY_REFRESH_BATCH_MS - 1;
      for (let index = 0; index < 3; index += 1) {
        vi.advanceTimersByTime(rearmStep);
        window.dispatchEvent(refreshEvent);
      }
      expect(selectGitScopeRefreshNonce(useChangesLiveRefreshStore.getState(), '/repo')).toBe(0);

      const remainingBeforeMaxWait = REPOSITORY_REFRESH_MAX_WAIT_MS - rearmStep * 3;
      vi.advanceTimersByTime(remainingBeforeMaxWait - 1);
      expect(selectGitScopeRefreshNonce(useChangesLiveRefreshStore.getState(), '/repo')).toBe(0);
      vi.advanceTimersByTime(1);
      expect(selectGitScopeRefreshNonce(useChangesLiveRefreshStore.getState(), '/repo')).toBe(4);
    } finally {
      release();
    }
  });

  it('preserves a Windows drive root during renderer path normalization', () => {
    expect(normalizeRefreshPath('C:\\')).toBe('C:/');
    expect(normalizeRefreshPath('C:/')).toBe('C:/');
  });
});
