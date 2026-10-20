/**
 * Fake-`watchDirectory` UNIT coverage for `git-inventory-watcher.ts`'s
 * `createGitInventoryWatchers`: the INTERESTING-path regex, the trailing
 * debounce, stray-late-lock coalescing, `sync()`'s subscribe-new/dispose-
 * removed/retry-dead semantics, dead-watcher visibility, and idempotent
 * disposal with no leaked subscriptions. A real repo + real parcel watcher
 * is covered separately in `git-inventory-watcher.integration.test.ts`.
 */
import path from 'node:path';
import { ParcelWatchRetirementError } from '@brainstrike/file-system/native-watch';
import type { FileSystemChange, FileSystemWatchSignal } from '@brainstrike/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loggerErrorSpy = vi.hoisted(() => vi.fn());
const loggerDebugSpy = vi.hoisted(() => vi.fn());
vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: (...args: Parameters<typeof actual.createLogger>) => {
      const real = actual.createLogger(...args);
      return { ...real, debug: loggerDebugSpy, error: loggerErrorSpy };
    },
  };
});

import {
  createGitInventoryWatchers,
  GIT_INVENTORY_WATCH_BATCH_MS,
  GIT_INVENTORY_WATCH_MAX_BATCH_MS,
  type GitInventoryWatcherDeps,
  type WatchGitCommonDir,
} from '../../assistant-server/git-inventory-watcher';

interface FakeSubscriptionRecord {
  readonly commonDir: string;
  disposeCallCount: number;
  readonly fireChanges: (changes: FileSystemChange[]) => void;
  readonly fireSignal: (signal: FileSystemWatchSignal) => void;
  readonly options: { readonly ignorePatterns?: readonly string[] } | undefined;
}

/**
 * Fake `watchDirectory`, matching the real electron-adapter shape but
 * resolving synchronously (queueMicrotask-free) so unit tests can drive it
 * deterministically. `reject` lets one test force a setup failure.
 */
function createFakeWatchDirectory(): {
  readonly records: FakeSubscriptionRecord[];
  readonly rejectNextWith: (error: Error) => void;
  readonly watchDirectory: WatchGitCommonDir;
} {
  const records: FakeSubscriptionRecord[] = [];
  let rejectNext: Error | null = null;

  const watchDirectory: WatchGitCommonDir = (commonDir, callback, onSignal, options) => {
    if (rejectNext) {
      const error = rejectNext;
      rejectNext = null;
      return Promise.reject(error);
    }
    const record: FakeSubscriptionRecord = {
      commonDir,
      disposeCallCount: 0,
      fireChanges: (changes) => callback(changes),
      fireSignal: (signal) => onSignal?.(signal),
      options,
    };
    records.push(record);
    return Promise.resolve(() => {
      record.disposeCallCount += 1;
      return Promise.resolve();
    });
  };

  return {
    records,
    rejectNextWith: (error) => {
      rejectNext = error;
    },
    watchDirectory,
  };
}

function change(commonDir: string, relativePosixPath: string): FileSystemChange {
  return {
    kind: 'file',
    path: path.join(commonDir, ...relativePosixPath.split('/')),
    type: 'modified',
  };
}

function makeDeps(
  overrides: Partial<GitInventoryWatcherDeps> & { watchDirectory: WatchGitCommonDir }
): GitInventoryWatcherDeps {
  return {
    onInvalidate: vi.fn(),
    realpath: (targetPath: string) => Promise.resolve(targetPath),
    ...overrides,
  };
}

function flushMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Observes whether `promise` has settled, without consuming its rejection. */
function trackSettlement(promise: Promise<void>): {
  readonly promise: Promise<void>;
  readonly settled: () => boolean;
} {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  return { promise, settled: () => settled };
}

function requireCallback<TArgs extends unknown[]>(
  callback: ((...args: TArgs) => void) | null,
  description: string
): (...args: TArgs) => void {
  if (!callback) {
    throw new Error(`expected ${description}`);
  }
  return callback;
}

describe('createGitInventoryWatchers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    loggerErrorSpy.mockClear();
    loggerDebugSpy.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('sync semantics', () => {
    it('subscribes a new common dir, realpath-resolved, with ignorePatterns: []', async () => {
      const fake = createFakeWatchDirectory();
      const realpath = vi.fn((targetPath: string) => Promise.resolve(`/real${targetPath}`));
      const watchers = createGitInventoryWatchers(
        makeDeps({ realpath, watchDirectory: fake.watchDirectory })
      );

      await watchers.sync(['/symlinked/repo/.git']);

      expect(realpath).toHaveBeenCalledWith('/symlinked/repo/.git');
      expect(fake.records).toHaveLength(1);
      expect(fake.records[0]?.commonDir).toBe('/real/symlinked/repo/.git');
      expect(fake.records[0]?.options).toEqual({ ignorePatterns: [] });
    });

    it('invalidates using the ORIGINAL commonDir key, not the realpath-resolved watch root', async () => {
      const fake = createFakeWatchDirectory();
      const onInvalidate = vi.fn();
      const realpath = (targetPath: string) => Promise.resolve(`/real${targetPath}`);
      const watchers = createGitInventoryWatchers(
        makeDeps({ onInvalidate, realpath, watchDirectory: fake.watchDirectory })
      );

      await watchers.sync(['/symlinked/repo/.git']);
      fake.records[0]?.fireChanges([change('/real/symlinked/repo/.git', 'HEAD')]);
      await vi.advanceTimersByTimeAsync(GIT_INVENTORY_WATCH_BATCH_MS);

      expect(onInvalidate).toHaveBeenCalledExactlyOnceWith('/symlinked/repo/.git');
    });

    it('disposes only REMOVED common dirs and leaves untouched ones alone (no thrash)', async () => {
      const fake = createFakeWatchDirectory();
      const watchers = createGitInventoryWatchers(
        makeDeps({ watchDirectory: fake.watchDirectory })
      );

      await watchers.sync(['/repo-a/.git', '/repo-b/.git']);
      expect(fake.records).toHaveLength(2);

      await watchers.sync(['/repo-b/.git']);

      const repoA = fake.records.find((record) => record.commonDir === '/repo-a/.git');
      const repoB = fake.records.find((record) => record.commonDir === '/repo-b/.git');
      expect(repoA?.disposeCallCount).toBe(1);
      expect(repoB?.disposeCallCount).toBe(0);
      // repo-b must NOT have been torn down and resubscribed — still exactly one record for it.
      expect(fake.records.filter((record) => record.commonDir === '/repo-b/.git')).toHaveLength(1);
    });

    it('subscribes a newly-added common dir on a later sync without touching existing ones', async () => {
      const fake = createFakeWatchDirectory();
      const watchers = createGitInventoryWatchers(
        makeDeps({ watchDirectory: fake.watchDirectory })
      );

      await watchers.sync(['/repo-a/.git']);
      await watchers.sync(['/repo-a/.git', '/repo-b/.git']);

      expect(fake.records.map((record) => record.commonDir).sort()).toEqual([
        '/repo-a/.git',
        '/repo-b/.git',
      ]);
      expect(
        fake.records.find((record) => record.commonDir === '/repo-a/.git')?.disposeCallCount
      ).toBe(0);
    });
  });

  describe('INTERESTING git-metadata path filtering', () => {
    const commonDir = '/repo/.git';

    async function fireAndSettle(
      fake: ReturnType<typeof createFakeWatchDirectory>,
      relativePosixPath: string
    ): Promise<void> {
      fake.records[0]?.fireChanges([change(commonDir, relativePosixPath)]);
      await vi.advanceTimersByTimeAsync(GIT_INVENTORY_WATCH_BATCH_MS);
    }

    it.each([
      ['HEAD', true],
      ['ORIG_HEAD', true],
      ['index', true],
      ['packed-refs', true],
      ['refs/heads/main', true],
      ['refs/heads/feature/deep/branch', true],
      ['refs/remotes/origin/main', true],
      ['worktrees/agent-1', true],
      ['worktrees/agent-1/HEAD', true],
      ['worktrees/agent-1/ORIG_HEAD', true],
      ['worktrees/agent-1/index', true],
      ['worktrees/agent-1/locked', true],
      ['worktrees/agent-1/gitdir', true],
      ['index.lock', false],
      ['HEAD.lock', false],
      ['refs/heads/main.lock', false],
      ['packed-refs.lock', false],
      ['worktrees/agent-1/index.lock', false],
      ['objects/ab/cd1234deadbeef', false],
      ['objects/pack/pack-abc.pack', false],
      ['logs/HEAD', false],
      ['config', false],
      ['description', false],
      ['FETCH_HEAD', false],
      ['COMMIT_EDITMSG', false],
    ])('%s -> invalidate=%s', async (relativePosixPath, shouldInvalidate) => {
      const fake = createFakeWatchDirectory();
      const onInvalidate = vi.fn();
      const watchers = createGitInventoryWatchers(
        makeDeps({ onInvalidate, watchDirectory: fake.watchDirectory })
      );
      await watchers.sync([commonDir]);

      await fireAndSettle(fake, relativePosixPath);

      if (shouldInvalidate) {
        expect(onInvalidate).toHaveBeenCalledExactlyOnceWith(commonDir);
      } else {
        expect(onInvalidate).not.toHaveBeenCalled();
      }
    });
  });

  describe('trailing debounce', () => {
    it('fires ONCE ~300ms after the LAST event in a burst, not 300ms after the first', async () => {
      const fake = createFakeWatchDirectory();
      const onInvalidate = vi.fn();
      const watchers = createGitInventoryWatchers(
        makeDeps({ onInvalidate, watchDirectory: fake.watchDirectory })
      );
      await watchers.sync(['/repo/.git']);
      const record = fake.records[0];
      if (!record) {
        throw new Error('expected a subscription record');
      }

      record.fireChanges([change('/repo/.git', 'HEAD')]); // t=0
      await vi.advanceTimersByTimeAsync(100);
      record.fireChanges([change('/repo/.git', 'index')]); // t=100
      await vi.advanceTimersByTimeAsync(100);
      record.fireChanges([change('/repo/.git', 'refs/heads/main')]); // t=200

      // A FIXED window from t=0 would have fired at t=300; prove it has not.
      await vi.advanceTimersByTimeAsync(99); // t=299
      expect(onInvalidate).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1); // t=300 relative to first event, t=100 relative to last
      expect(onInvalidate).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(199); // t=499
      expect(onInvalidate).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1); // t=500 = 300ms after the LAST event at t=200
      expect(onInvalidate).toHaveBeenCalledTimes(1);
    });
  });

  describe('stray-late-lock coalescing', () => {
    it('does not fire a second invalidation for a lone late index.lock delete after a rebuild already ran', async () => {
      const fake = createFakeWatchDirectory();
      const onInvalidate = vi.fn();
      const watchers = createGitInventoryWatchers(
        makeDeps({ onInvalidate, watchDirectory: fake.watchDirectory })
      );
      await watchers.sync(['/repo/.git']);
      const record = fake.records[0];
      if (!record) {
        throw new Error('expected a subscription record');
      }

      record.fireChanges([change('/repo/.git', 'index')]);
      await vi.advanceTimersByTimeAsync(GIT_INVENTORY_WATCH_BATCH_MS);
      expect(onInvalidate).toHaveBeenCalledTimes(1);

      // Stray late lock delete, arriving after the rebuild already fired.
      record.fireChanges([change('/repo/.git', 'index.lock')]);
      await vi.advanceTimersByTimeAsync(GIT_INVENTORY_WATCH_BATCH_MS * 2);

      expect(onInvalidate).toHaveBeenCalledTimes(1);
    });
  });

  describe('health: overflow', () => {
    it('forces an immediate invalidation on overflow without marking the watcher dead', async () => {
      const fake = createFakeWatchDirectory();
      const onInvalidate = vi.fn();
      const watchers = createGitInventoryWatchers(
        makeDeps({ onInvalidate, watchDirectory: fake.watchDirectory })
      );
      await watchers.sync(['/repo/.git']);
      const record = fake.records[0];
      if (!record) {
        throw new Error('expected a subscription record');
      }

      record.fireSignal({ type: 'overflow' });

      expect(onInvalidate).toHaveBeenCalledExactlyOnceWith('/repo/.git');
      expect(watchers.getDeadCommonDirs().size).toBe(0);
    });
  });

  describe('health: errored (dead-watcher visibility)', () => {
    it('marks the watcher dead, logs, and surfaces it via getDeadCommonDirs/getHealthErrors', async () => {
      const fake = createFakeWatchDirectory();
      const watchers = createGitInventoryWatchers(
        makeDeps({ watchDirectory: fake.watchDirectory })
      );
      await watchers.sync(['/repo/.git']);
      const record = fake.records[0];
      if (!record) {
        throw new Error('expected a subscription record');
      }

      expect(watchers.getDeadCommonDirs().size).toBe(0);
      record.fireSignal({ message: 'ENOSPC: watch limit reached', type: 'errored' });

      expect(watchers.getDeadCommonDirs()).toEqual(new Set(['/repo/.git']));
      expect(watchers.getHealthErrors()).toHaveLength(1);
      expect(watchers.getHealthErrors()[0]).toContain('/repo/.git');
      expect(watchers.getHealthErrors()[0]).toContain('ENOSPC: watch limit reached');
      expect(loggerErrorSpy).toHaveBeenCalledTimes(1);
    });

    it('does not invalidate on an errored signal (no work to rebuild for a dead watcher)', async () => {
      const fake = createFakeWatchDirectory();
      const onInvalidate = vi.fn();
      const watchers = createGitInventoryWatchers(
        makeDeps({ onInvalidate, watchDirectory: fake.watchDirectory })
      );
      await watchers.sync(['/repo/.git']);
      fake.records[0]?.fireSignal({ message: 'dead', type: 'errored' });
      await vi.advanceTimersByTimeAsync(GIT_INVENTORY_WATCH_BATCH_MS * 2);

      expect(onInvalidate).not.toHaveBeenCalled();
    });

    it('retries a dead watcher only when an EXPLICIT sync() still lists its common dir', async () => {
      const fake = createFakeWatchDirectory();
      const watchers = createGitInventoryWatchers(
        makeDeps({ watchDirectory: fake.watchDirectory })
      );
      await watchers.sync(['/repo/.git']);
      fake.records[0]?.fireSignal({ message: 'dead', type: 'errored' });
      expect(watchers.getDeadCommonDirs().size).toBe(1);

      // No auto-restart: dead state persists with no further sync() call.
      expect(fake.records).toHaveLength(1);

      await watchers.sync(['/repo/.git']);

      expect(fake.records).toHaveLength(2); // old disposed + a fresh subscription
      expect(fake.records[0]?.disposeCallCount).toBe(1);
      expect(watchers.getDeadCommonDirs().size).toBe(0);
    });
  });

  describe('watchDirectory setup rejection', () => {
    it('marks the watcher dead visibly instead of throwing when watchDirectory rejects', async () => {
      const fake = createFakeWatchDirectory();
      fake.rejectNextWith(new Error('parcel binding missing'));
      const watchers = createGitInventoryWatchers(
        makeDeps({ watchDirectory: fake.watchDirectory })
      );

      await expect(watchers.sync(['/repo/.git'])).resolves.toBeUndefined();
      expect(watchers.getDeadCommonDirs()).toEqual(new Set(['/repo/.git']));
      expect(watchers.getHealthErrors()[0]).toContain('parcel binding missing');
    });
  });

  describe('disposeAll: idempotent, no leaked subscriptions', () => {
    it('disposes every live subscription exactly once; a second disposeAll() is a no-op', async () => {
      const fake = createFakeWatchDirectory();
      const watchers = createGitInventoryWatchers(
        makeDeps({ watchDirectory: fake.watchDirectory })
      );
      await watchers.sync(['/repo-a/.git', '/repo-b/.git', '/repo-c/.git']);
      expect(fake.records).toHaveLength(3);

      await watchers.disposeAll();
      for (const record of fake.records) {
        expect(record.disposeCallCount).toBe(1);
      }

      await watchers.disposeAll();
      for (const record of fake.records) {
        expect(record.disposeCallCount).toBe(1);
      }
    });

    it('joins a subscription whose watchDirectory() Promise resolves AFTER disposeAll() began, and retires it before resolving', async () => {
      // Real timers: a genuinely-pending watchDirectory() promise plus a real
      // macrotask flush lets subscribe() reach `await deps.watchDirectory()`
      // BEFORE disposeAll() runs — fake timers don't advance microtask awaits.
      vi.useRealTimers();
      const acquisition = Promise.withResolvers<() => Promise<void>>();
      const unsubscribe = Promise.withResolvers<void>();
      const dispose = vi.fn(() => unsubscribe.promise);
      const watchDirectory = vi.fn<WatchGitCommonDir>(() => acquisition.promise);
      const watchers = createGitInventoryWatchers(makeDeps({ watchDirectory }));

      const syncPromise = watchers.sync(['/repo/.git']);
      await vi.waitFor(() => expect(watchDirectory).toHaveBeenCalledOnce());

      // BST-2244: shutdown begins while the native subscribe is in flight. A
      // disposeAll() that resolved now would let Electron free Main's Node
      // environment under the subscribe, and its completion aborts Main.
      const disposing = trackSettlement(watchers.disposeAll());
      await flushMacrotask();
      expect(disposing.settled()).toBe(false);

      // The late subscription is retired, and disposeAll() still waits for
      // its native unsubscribe to settle.
      acquisition.resolve(dispose);
      await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
      await flushMacrotask();
      expect(disposing.settled()).toBe(false);

      unsubscribe.resolve();
      await disposing.promise;
      await syncPromise;
      expect(dispose).toHaveBeenCalledOnce();
    });

    it('does not resolve until every native unsubscribe has settled', async () => {
      vi.useRealTimers();
      const unsubscribe = Promise.withResolvers<void>();
      const dispose = vi.fn(() => unsubscribe.promise);
      const watchers = createGitInventoryWatchers(
        makeDeps({ watchDirectory: () => Promise.resolve(dispose) })
      );
      await watchers.sync(['/repo/.git']);

      const disposing = trackSettlement(watchers.disposeAll());
      await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
      await flushMacrotask();
      expect(disposing.settled()).toBe(false);

      unsubscribe.resolve();
      await disposing.promise;
    });

    it('rejects with a failed native unsubscribe after every other retirement settles', async () => {
      vi.useRealTimers();
      const failure = new Error('native unsubscribe failed');
      const failing = vi.fn(() => Promise.reject(failure));
      const healthy = Promise.withResolvers<void>();
      const healthyDispose = vi.fn(() => healthy.promise);
      const watchers = createGitInventoryWatchers(
        makeDeps({
          watchDirectory: (commonDir) =>
            Promise.resolve(commonDir === '/repo-a/.git' ? failing : healthyDispose),
        })
      );
      await watchers.sync(['/repo-a/.git', '/repo-b/.git']);

      const disposing = trackSettlement(watchers.disposeAll());
      await vi.waitFor(() => expect(healthyDispose).toHaveBeenCalledOnce());
      await flushMacrotask();
      expect(disposing.settled()).toBe(false);

      healthy.resolve();
      await expect(disposing.promise).rejects.toMatchObject({ errors: [failure] });
      expect(failing).toHaveBeenCalledOnce();
    });

    it('retires the native subscription a ParcelWatchRetirementError still owns', async () => {
      vi.useRealTimers();
      const retire = vi.fn(() => Promise.resolve());
      const watchers = createGitInventoryWatchers(
        makeDeps({
          watchDirectory: () =>
            Promise.reject(
              new ParcelWatchRetirementError(
                [new Error('start failed after acquisition'), new Error('unsubscribe failed')],
                retire
              )
            ),
        })
      );
      await watchers.sync(['/repo/.git']);
      expect(watchers.getDeadCommonDirs()).toEqual(new Set(['/repo/.git']));
      expect(retire).not.toHaveBeenCalled();

      await watchers.disposeAll();

      expect(retire).toHaveBeenCalledOnce();
    });

    it('never subscribes a common dir requested via sync() after disposeAll() already ran', async () => {
      const fake = createFakeWatchDirectory();
      const watchers = createGitInventoryWatchers(
        makeDeps({ watchDirectory: fake.watchDirectory })
      );
      await watchers.disposeAll();

      await watchers.sync(['/repo/.git']);

      expect(fake.records).toHaveLength(0);
    });
  });

  describe('BLOCKER: overlapping sync() calls for the same NEW common dir', () => {
    it('never leaks a live subscription when two sync() calls race to subscribe the same common dir', async () => {
      // Real timers + manually-resolvable realpath/watchDirectory promises so
      // the interleaving is fully controlled rather than timing-dependent:
      // the FIRST attempt is driven all the way to a completed, live
      // subscription (its real disposer assigned) BEFORE the SECOND
      // attempt's realpath() is even allowed to resolve — the exact
      // ordering the leak needs ("the first completes fully... before the
      // second's realpath resolves").
      vi.useRealTimers();
      const commonDir = '/repo/.git';

      const realpathResolvers: Array<(value: string) => void> = [];
      const realpath = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            realpathResolvers.push(resolve);
          })
      );

      const watchResolvers: Array<(dispose: () => Promise<void>) => void> = [];
      const watchDirectory: WatchGitCommonDir = () =>
        new Promise((resolve) => {
          watchResolvers.push(resolve);
        });

      const watchers = createGitInventoryWatchers(makeDeps({ realpath, watchDirectory }));
      const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

      const overlapPromise = Promise.all([watchers.sync([commonDir]), watchers.sync([commonDir])]);
      await flush();
      expect(realpathResolvers.length).toBeGreaterThanOrEqual(1);

      // Drive the FIRST attempt to full completion.
      const firstRecord = { disposeCallCount: 0 };
      realpathResolvers[0]?.(commonDir);
      await flush();
      expect(watchResolvers.length).toBeGreaterThanOrEqual(1);
      watchResolvers[0]?.(() => {
        firstRecord.disposeCallCount += 1;
        return Promise.resolve();
      });
      await flush();

      // ONLY NOW let the second attempt's realpath() resolve, if a second
      // attempt was even started (the fix prevents it from starting at all).
      const secondRecord = { disposeCallCount: 0 };
      realpathResolvers[1]?.(commonDir);
      await flush();
      if (watchResolvers.length > 1) {
        watchResolvers[1]?.(() => {
          secondRecord.disposeCallCount += 1;
          return Promise.resolve();
        });
        await flush();
      }
      await overlapPromise;

      await watchers.disposeAll();

      // No orphan: every watchDirectory() call that ever produced a real
      // disposer must have been disposed exactly once by disposeAll(). An
      // orphaned first subscription (leaked) would leave
      // firstRecord.disposeCallCount at 0 forever, since disposeAll() only
      // ever sees whatever is CURRENTLY in the map.
      expect(firstRecord.disposeCallCount).toBe(1);
      if (watchResolvers.length > 1) {
        expect(secondRecord.disposeCallCount).toBe(1);
      }
    });
  });

  describe('SHOULD-FIX: no invalidation or dead-state write after disposeAll() (post-teardown safety)', () => {
    it('does not arm a new timer or invalidate when an interesting change arrives after disposeAll()', async () => {
      const fake = createFakeWatchDirectory();
      const onInvalidate = vi.fn();
      const watchers = createGitInventoryWatchers(
        makeDeps({ onInvalidate, watchDirectory: fake.watchDirectory })
      );
      await watchers.sync(['/repo/.git']);
      const record = fake.records[0];
      if (!record) {
        throw new Error('expected a subscription record');
      }

      await watchers.disposeAll();
      record.fireChanges([change('/repo/.git', 'HEAD')]);
      await vi.advanceTimersByTimeAsync(GIT_INVENTORY_WATCH_BATCH_MS * 2);

      expect(onInvalidate).not.toHaveBeenCalled();
    });

    it('does not invalidate synchronously when an overflow signal arrives after disposeAll()', async () => {
      const fake = createFakeWatchDirectory();
      const onInvalidate = vi.fn();
      const watchers = createGitInventoryWatchers(
        makeDeps({ onInvalidate, watchDirectory: fake.watchDirectory })
      );
      await watchers.sync(['/repo/.git']);
      const record = fake.records[0];
      if (!record) {
        throw new Error('expected a subscription record');
      }

      await watchers.disposeAll();
      record.fireSignal({ type: 'overflow' });

      expect(onInvalidate).not.toHaveBeenCalled();
    });

    it('does not invalidate after disposeAll() cancels an in-flight debounce timer', async () => {
      const fake = createFakeWatchDirectory();
      const onInvalidate = vi.fn();
      const watchers = createGitInventoryWatchers(
        makeDeps({ onInvalidate, watchDirectory: fake.watchDirectory })
      );
      await watchers.sync(['/repo/.git']);
      const record = fake.records[0];
      if (!record) {
        throw new Error('expected a subscription record');
      }

      record.fireChanges([change('/repo/.git', 'HEAD')]);
      await vi.advanceTimersByTimeAsync(50);
      await watchers.disposeAll();
      await vi.advanceTimersByTimeAsync(500);

      expect(onInvalidate).not.toHaveBeenCalled();
    });
  });

  describe('SHOULD-FIX: no phantom dead state on a terminally-disposed instance', () => {
    it('does not mark a subscription dead when disposeAll() runs before a pending realpath() rejects', async () => {
      vi.useRealTimers();
      let rejectRealpath: ((error: Error) => void) | null = null;
      const realpath = () =>
        new Promise<string>((_resolve, reject) => {
          rejectRealpath = reject;
        });
      const fake = createFakeWatchDirectory();
      const watchers = createGitInventoryWatchers(
        makeDeps({ realpath, watchDirectory: fake.watchDirectory })
      );

      const syncPromise = watchers.sync(['/repo/.git']);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(rejectRealpath).not.toBeNull();

      // disposeAll() joins the in-flight attempt, so it settles only after
      // the pending realpath() does.
      const disposing = watchers.disposeAll();
      loggerErrorSpy.mockClear();
      requireCallback<[Error]>(
        rejectRealpath,
        'realpath rejecter'
      )(new Error('ENOENT: no such directory'));
      await syncPromise;
      await disposing;

      expect(watchers.getDeadCommonDirs().size).toBe(0);
      expect(watchers.getHealthErrors()).toHaveLength(0);
      expect(loggerErrorSpy).not.toHaveBeenCalled();
    });

    it('does not log a setup-rejected error when disposeAll() runs before a pending watchDirectory() rejects', async () => {
      vi.useRealTimers();
      let rejectWatch: ((error: Error) => void) | null = null;
      const watchDirectory: WatchGitCommonDir = () =>
        new Promise((_resolve, reject) => {
          rejectWatch = reject;
        });
      const watchers = createGitInventoryWatchers(makeDeps({ watchDirectory }));

      const syncPromise = watchers.sync(['/repo/.git']);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(rejectWatch).not.toBeNull();

      const disposing = watchers.disposeAll();
      loggerErrorSpy.mockClear();
      requireCallback<[Error]>(rejectWatch, 'watch rejecter')(new Error('parcel binding missing'));
      await syncPromise;
      await disposing;

      expect(watchers.getDeadCommonDirs().size).toBe(0);
      expect(watchers.getHealthErrors()).toHaveLength(0);
      expect(loggerErrorSpy).not.toHaveBeenCalled();
    });
  });

  describe('pre-watchDirectory stale guard', () => {
    it('never opens a real watch when disposeAll() tears the subscription down while realpath() is still pending', async () => {
      // Real timers + a manually-resolvable realpath() so disposeAll() can
      // be interleaved deterministically BETWEEN realpath() resolving and
      // watchDirectory() being called — the exact window the guard at
      // `subscribe()` ("checked BEFORE opening the real watch, not just
      // after") claims to cover. Without it, a torn-down attempt would still
      // open a real native watch (later retired by disposeAll(), so no leak —
      // but the watch really did open, which is the whole point of checking
      // before, not just after).
      vi.useRealTimers();
      let resolveRealpath: ((value: string) => void) | null = null;
      const realpath = () =>
        new Promise<string>((resolve) => {
          resolveRealpath = resolve;
        });
      const fake = createFakeWatchDirectory();
      const watchers = createGitInventoryWatchers(
        makeDeps({ realpath, watchDirectory: fake.watchDirectory })
      );

      const syncPromise = watchers.sync(['/repo/.git']);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(resolveRealpath).not.toBeNull();

      const disposing = watchers.disposeAll();
      requireCallback<[string]>(resolveRealpath, 'realpath resolver')('/repo/.git');
      await syncPromise;
      await disposing;

      expect(fake.records).toHaveLength(0);
    });
  });

  describe('max-wait cap on the trailing debounce', () => {
    it('forces an invalidation at the cap under sustained churn, even though events never stop', async () => {
      const fake = createFakeWatchDirectory();
      const onInvalidate = vi.fn();
      const watchers = createGitInventoryWatchers(
        makeDeps({ onInvalidate, watchDirectory: fake.watchDirectory })
      );
      await watchers.sync(['/repo/.git']);
      const record = fake.records[0];
      if (!record) {
        throw new Error('expected a subscription record');
      }

      // Sustained churn: an interesting event every 100ms, for LONGER than
      // the cap, with NO gap ever exceeding the 300ms trailing window. A
      // pure trailing debounce (no cap) re-arms on every one of these and
      // never goes quiet long enough to fire — across this entire window it
      // would produce ZERO invalidations. Deliberately does not stop right
      // at the cap (that would let a plain 300ms trailing timer, armed by
      // the last pre-loop event, fire by coincidence at roughly the same
      // time and pass even without the cap) — churn continues well past it.
      const churnDurationMs = GIT_INVENTORY_WATCH_MAX_BATCH_MS + 1000;
      for (let elapsed = 0; elapsed < churnDurationMs; elapsed += 100) {
        record.fireChanges([change('/repo/.git', 'HEAD')]);
        await vi.advanceTimersByTimeAsync(100);
      }

      // The cap must have forced exactly one fire partway through, even
      // though the churn never stopped.
      expect(onInvalidate).toHaveBeenCalledTimes(1);
    });
  });

  describe('batch seen-vs-interesting event counters (measurement seam for the ignorePatterns:[] tradeoff)', () => {
    it('logs the exact seen and interesting counts for the batch, attributed to the common dir', async () => {
      const fake = createFakeWatchDirectory();
      const watchers = createGitInventoryWatchers(
        makeDeps({ watchDirectory: fake.watchDirectory })
      );
      await watchers.sync(['/repo/.git']);
      const record = fake.records[0];
      if (!record) {
        throw new Error('expected a subscription record');
      }

      // First delivery: 1 interesting (HEAD), 1 noise (objects/**).
      record.fireChanges([change('/repo/.git', 'HEAD'), change('/repo/.git', 'objects/ab/cd1234')]);
      // Second delivery, same batch (before the debounce fires): 2
      // interesting (index, refs/heads/main), 1 noise (config).
      record.fireChanges([
        change('/repo/.git', 'index'),
        change('/repo/.git', 'refs/heads/main'),
        change('/repo/.git', 'config'),
      ]);
      await vi.advanceTimersByTimeAsync(GIT_INVENTORY_WATCH_BATCH_MS);

      // Total across the batch: 5 seen, 3 interesting. A mutation that
      // counts every seen event as interesting (or never counts at all)
      // fails this exact-value assertion.
      expect(loggerDebugSpy).toHaveBeenCalledExactlyOnceWith(
        'git inventory watcher batch: interesting/seen event counts',
        { commonDir: '/repo/.git', eventsInteresting: 3, eventsSeen: 5 }
      );
    });

    it('resets the counters after a batch closes, so the next batch logs only its own events', async () => {
      const fake = createFakeWatchDirectory();
      const watchers = createGitInventoryWatchers(
        makeDeps({ watchDirectory: fake.watchDirectory })
      );
      await watchers.sync(['/repo/.git']);
      const record = fake.records[0];
      if (!record) {
        throw new Error('expected a subscription record');
      }

      record.fireChanges([change('/repo/.git', 'HEAD')]);
      await vi.advanceTimersByTimeAsync(GIT_INVENTORY_WATCH_BATCH_MS);
      expect(loggerDebugSpy).toHaveBeenCalledTimes(1);

      record.fireChanges([change('/repo/.git', 'index')]);
      await vi.advanceTimersByTimeAsync(GIT_INVENTORY_WATCH_BATCH_MS);

      // If the counters were never reset after the first batch closed, this
      // second log would show the ACCUMULATED totals (2 seen, 2 interesting)
      // instead of just the second batch's own single event.
      expect(loggerDebugSpy).toHaveBeenCalledTimes(2);
      expect(loggerDebugSpy).toHaveBeenLastCalledWith(
        'git inventory watcher batch: interesting/seen event counts',
        { commonDir: '/repo/.git', eventsInteresting: 1, eventsSeen: 1 }
      );
    });

    it('logs accumulated counts and resets on a forced overflow fire too', async () => {
      const fake = createFakeWatchDirectory();
      const watchers = createGitInventoryWatchers(
        makeDeps({ watchDirectory: fake.watchDirectory })
      );
      await watchers.sync(['/repo/.git']);
      const record = fake.records[0];
      if (!record) {
        throw new Error('expected a subscription record');
      }

      // One noise-only delivery (0 interesting, 1 seen) still pending when
      // overflow forces the batch closed early.
      record.fireChanges([change('/repo/.git', 'objects/ab/cd1234')]);
      record.fireSignal({ type: 'overflow' });

      expect(loggerDebugSpy).toHaveBeenCalledExactlyOnceWith(
        'git inventory watcher batch: interesting/seen event counts',
        { commonDir: '/repo/.git', eventsInteresting: 0, eventsSeen: 1 }
      );
    });
  });

  describe('MINOR: additional coverage', () => {
    it('fires twice when interesting events are separated by MORE than the debounce window', async () => {
      const fake = createFakeWatchDirectory();
      const onInvalidate = vi.fn();
      const watchers = createGitInventoryWatchers(
        makeDeps({ onInvalidate, watchDirectory: fake.watchDirectory })
      );
      await watchers.sync(['/repo/.git']);
      const record = fake.records[0];
      if (!record) {
        throw new Error('expected a subscription record');
      }

      record.fireChanges([change('/repo/.git', 'HEAD')]);
      await vi.advanceTimersByTimeAsync(GIT_INVENTORY_WATCH_BATCH_MS);
      expect(onInvalidate).toHaveBeenCalledTimes(1);

      record.fireChanges([change('/repo/.git', 'index')]);
      await vi.advanceTimersByTimeAsync(GIT_INVENTORY_WATCH_BATCH_MS);
      expect(onInvalidate).toHaveBeenCalledTimes(2);
    });

    it('does not invalidate for a change path outside the subscription watch root', async () => {
      const fake = createFakeWatchDirectory();
      const onInvalidate = vi.fn();
      const watchers = createGitInventoryWatchers(
        makeDeps({ onInvalidate, watchDirectory: fake.watchDirectory })
      );
      await watchers.sync(['/repo/.git']);
      const record = fake.records[0];
      if (!record) {
        throw new Error('expected a subscription record');
      }

      record.fireChanges([change('/unrelated/other-repo/.git', 'HEAD')]);
      await vi.advanceTimersByTimeAsync(GIT_INVENTORY_WATCH_BATCH_MS * 2);

      expect(onInvalidate).not.toHaveBeenCalled();
    });
  });
});
