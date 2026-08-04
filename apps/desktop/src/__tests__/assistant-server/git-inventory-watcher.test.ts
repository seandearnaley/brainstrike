/**
 * Fake-`watchDirectory` UNIT coverage for `git-inventory-watcher.ts`'s
 * `createGitInventoryWatchers`: the INTERESTING-path regex, the trailing
 * debounce, stray-late-lock coalescing, `sync()`'s subscribe-new/dispose-
 * removed/retry-dead semantics, dead-watcher visibility, and idempotent
 * disposal with no leaked subscriptions. A real repo + real parcel watcher
 * is covered separately in `git-inventory-watcher.integration.test.ts`.
 */
import path from 'node:path';
import type { FileSystemChange, FileSystemWatchSignal } from '@brainstrike/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loggerErrorSpy = vi.hoisted(() => vi.fn());
vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: (...args: Parameters<typeof actual.createLogger>) => {
      const real = actual.createLogger(...args);
      return { ...real, error: loggerErrorSpy };
    },
  };
});

import {
  createGitInventoryWatchers,
  GIT_INVENTORY_WATCH_BATCH_MS,
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

describe('createGitInventoryWatchers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    loggerErrorSpy.mockClear();
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
      onInvalidate: ReturnType<typeof vi.fn>,
      fake: ReturnType<typeof createFakeWatchDirectory>,
      relativePosixPath: string
    ): Promise<void> {
      fake.records[0]?.fireChanges([change(commonDir, relativePosixPath)]);
      await vi.advanceTimersByTimeAsync(GIT_INVENTORY_WATCH_BATCH_MS);
      void onInvalidate;
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
    ])('%s -> invalidate=%s', async (relativePosixPath, shouldInvalidate) => {
      const fake = createFakeWatchDirectory();
      const onInvalidate = vi.fn();
      const watchers = createGitInventoryWatchers(
        makeDeps({ onInvalidate, watchDirectory: fake.watchDirectory })
      );
      await watchers.sync([commonDir]);

      await fireAndSettle(onInvalidate, fake, relativePosixPath);

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

    it('disposes a subscription whose watchDirectory() Promise resolves AFTER disposeAll() already removed it', async () => {
      // Real timers for this test: we need a genuinely-pending watchDirectory()
      // promise plus a real macrotask flush to let subscribe() get past its
      // `await realpath()` and reach `await deps.watchDirectory()` BEFORE
      // disposeAll() runs — fake timers don't advance microtask-driven awaits.
      vi.useRealTimers();
      let resolveWatch: ((dispose: () => void) => void) | null = null;
      let disposeCallCount = 0;
      const watchDirectory: WatchGitCommonDir = () =>
        new Promise((resolve) => {
          resolveWatch = resolve;
        });
      const watchers = createGitInventoryWatchers(makeDeps({ watchDirectory }));

      const syncPromise = watchers.sync(['/repo/.git']);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(resolveWatch).not.toBeNull();

      // disposeAll() runs while watchDirectory() is still pending: it can only
      // dispose the stub `() => {}` placeholder immediately (the map entry is
      // removed synchronously), since the REAL disposer doesn't exist yet.
      await watchers.disposeAll();

      // The real disposer arrives LATE. subscribe()'s stale-identity check
      // must notice the Subscription it holds is no longer the one tracked
      // (disposeAll already deleted it) and invoke this real disposer too —
      // otherwise the underlying native watch would leak forever.
      resolveWatch?.(() => {
        disposeCallCount += 1;
      });
      await syncPromise;
      expect(disposeCallCount).toBe(1);
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
});
