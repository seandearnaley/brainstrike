/**
 * UNIT coverage for `git-inventory-service.ts`'s `createGitInventoryService`
 * — the stateful wrapper (TTL + dirty-flag cache, in-flight build
 * coalescing, and watcher lifecycle) added around Task 2's
 * `buildInventorySnapshot` (BST-1112, Task 4).
 *
 * Exercises the REAL `buildInventorySnapshot` (fake `InventoryFs` + spy
 * `run`, same pattern as `git-inventory-service.test.ts`) and the REAL
 * `createGitInventoryWatchers` (fake `watchDirectory`, same pattern as
 * `git-inventory-watcher.test.ts`) — nothing in the dependency chain under
 * test is stubbed to throw; every scenario drives the wrapper through its
 * real collaborators so a targeted mutation of `createGitInventoryService`
 * itself is what each assertion is falsifiable against.
 */
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

import { GIT_INVENTORY_SNAPSHOT_TTL_MS } from '../../assistant-server/git-inventory-service';
import {
  GIT_INVENTORY_WATCH_BATCH_MS,
  type WatchGitCommonDir,
} from '../../assistant-server/git-inventory-watcher';
import {
  cleanupTempDirs,
  createFakeWatchDirectory,
  makeService,
  makeSingleRepoRoot,
  makeWorktreeListRunner,
  requireRelease,
} from './git-inventory-service-test-support';

afterEach(async () => {
  await cleanupTempDirs();
});

describe('createGitInventoryService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    loggerErrorSpy.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('TTL cache', () => {
    it('serves the cached snapshot within the TTL, and rebuilds once the TTL has elapsed', async () => {
      const loadRootsSpy = vi.fn(() => Promise.resolve([]));
      const fake = createFakeWatchDirectory();
      const service = makeService({ loadRootsSpy, watchDirectory: fake.watchDirectory });

      await service.getSnapshot();
      expect(loadRootsSpy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(GIT_INVENTORY_SNAPSHOT_TTL_MS - 1);
      await service.getSnapshot();
      expect(loadRootsSpy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2);
      await service.getSnapshot();
      expect(loadRootsSpy).toHaveBeenCalledTimes(2);
    });

    it('honors a caller-supplied maxAgeMs override', async () => {
      const loadRootsSpy = vi.fn(() => Promise.resolve([]));
      const fake = createFakeWatchDirectory();
      const service = makeService({ loadRootsSpy, watchDirectory: fake.watchDirectory });

      await service.getSnapshot({ maxAgeMs: 100 });
      expect(loadRootsSpy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(150);
      await service.getSnapshot({ maxAgeMs: 100 });
      expect(loadRootsSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('dirty flag beats TTL', () => {
    it('rebuilds on the next getSnapshot() after a watcher invalidation, well inside the TTL window', async () => {
      const { commonDir, fs, rootDir, rootId } = await makeSingleRepoRoot(
        'brainstrike-git-inv-svc-dirty-'
      );
      const loadRootsSpy = vi.fn(() => Promise.resolve([{ id: rootId, path: rootDir }]));
      const fake = createFakeWatchDirectory();
      const service = makeService({
        fs,
        loadRootsSpy,
        run: makeWorktreeListRunner(),
        watchDirectory: fake.watchDirectory,
      });

      service.start();
      const first = await service.getSnapshot();
      expect(loadRootsSpy).toHaveBeenCalledTimes(1);
      expect(first.repositories).toHaveLength(1);

      const sub = fake.subscriptionsByCommonDir.get(commonDir);
      expect(sub).toBeDefined();
      sub?.fireInterestingChange();
      // The watcher's own trailing debounce (Task 3) must elapse before
      // onInvalidate() fires and marks the cache dirty.
      await vi.advanceTimersByTimeAsync(GIT_INVENTORY_WATCH_BATCH_MS);

      // Still well inside the 5000ms TTL (only GIT_INVENTORY_WATCH_BATCH_MS
      // has elapsed) — a TTL-only cache would serve the stale snapshot here.
      await service.getSnapshot();
      expect(loadRootsSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('in-flight build coalescing', () => {
    it('shares ONE build across concurrent getSnapshot() calls and resolves both to the same snapshot object', async () => {
      const loadRootsSpy = vi.fn(() => Promise.resolve([]));
      const fake = createFakeWatchDirectory();
      const service = makeService({ loadRootsSpy, watchDirectory: fake.watchDirectory });

      const [a, b] = await Promise.all([service.getSnapshot(), service.getSnapshot()]);

      // The call-count assertion is the actual coalescing proof. `toEqual`
      // (not `toBe`) deliberately: `withLiveHealthErrors` is free to return a
      // fresh object even for two calls served by the same build (e.g. if it
      // stopped short-circuiting the empty-health-errors case) without that
      // being a coalescing regression — an identity assertion here would
      // couple this test to that unrelated implementation detail.
      expect(loadRootsSpy).toHaveBeenCalledTimes(1);
      expect(a).toEqual(b);
    });
  });

  describe('stop()', () => {
    it('disposes every live watcher and drops the cache, so getSnapshot() no longer serves stale data — it rejects instead (BST-1112 review Blocker 1)', async () => {
      const { commonDir, fs, rootDir, rootId } = await makeSingleRepoRoot(
        'brainstrike-git-inv-svc-stop-'
      );
      const loadRootsSpy = vi.fn(() => Promise.resolve([{ id: rootId, path: rootDir }]));
      const fake = createFakeWatchDirectory();
      const service = makeService({
        fs,
        loadRootsSpy,
        run: makeWorktreeListRunner(),
        watchDirectory: fake.watchDirectory,
      });

      service.start();
      await service.getSnapshot();
      expect(loadRootsSpy).toHaveBeenCalledTimes(1);
      const sub = fake.subscriptionsByCommonDir.get(commonDir);
      expect(sub?.disposeCallCount).toBe(0);

      await service.stop();
      expect(sub?.disposeCallCount).toBe(1);

      // A getSnapshot() after stop() no longer rebuilds at all — it rejects,
      // so there is no "stale data" left to serve in the first place.
      await expect(service.getSnapshot()).rejects.toMatchObject({ code: 'inventory-stopped' });
      expect(loadRootsSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('watcher sync argument', () => {
    it('subscribes exactly the common dir the rebuild produced', async () => {
      const { commonDir, fs, rootDir, rootId } = await makeSingleRepoRoot(
        'brainstrike-git-inv-svc-sync-'
      );
      const loadRootsSpy = vi.fn(() => Promise.resolve([{ id: rootId, path: rootDir }]));
      const fake = createFakeWatchDirectory();
      const service = makeService({
        fs,
        loadRootsSpy,
        run: makeWorktreeListRunner(),
        watchDirectory: fake.watchDirectory,
      });

      service.start();
      await service.getSnapshot();

      expect(fake.watchDirectorySpy).toHaveBeenCalledTimes(1);
      expect(fake.watchDirectorySpy.mock.calls[0]?.[0]).toBe(commonDir);
    });
  });

  describe('start() error visibility', () => {
    it('surfaces an initial-build failure in snapshot.errors instead of an unhandled rejection', async () => {
      const fake = createFakeWatchDirectory();
      const service = makeService({
        loadRootsSpy: vi.fn(() => Promise.reject(new Error('db not ready'))),
        watchDirectory: fake.watchDirectory,
      });

      service.start();
      const snapshot = await service.getSnapshot();

      expect(snapshot.repositories).toEqual([]);
      expect(snapshot.errors).toHaveLength(1);
      expect(snapshot.errors[0]).toContain('db not ready');
    });
  });

  describe('dead-watcher errors', () => {
    it('surfaces a watcher that dies AFTER the last rebuild on the very next (cache-served) getSnapshot() call', async () => {
      const { commonDir, fs, rootDir, rootId } = await makeSingleRepoRoot(
        'brainstrike-git-inv-svc-dead-'
      );
      const loadRootsSpy = vi.fn(() => Promise.resolve([{ id: rootId, path: rootDir }]));
      const fake = createFakeWatchDirectory();
      const service = makeService({
        fs,
        loadRootsSpy,
        run: makeWorktreeListRunner(),
        watchDirectory: fake.watchDirectory,
      });

      service.start();
      const first = await service.getSnapshot();
      expect(first.errors).toEqual([]);

      const sub = fake.subscriptionsByCommonDir.get(commonDir);
      sub?.fireErrorSignal('watcher process crashed');

      // Still well inside the TTL, and the change above never fired an
      // interesting-path event, so the cache is NOT dirty — this call must
      // be served from cache, yet still reflect the dead watcher.
      const second = await service.getSnapshot();
      expect(loadRootsSpy).toHaveBeenCalledTimes(1);
      expect(second.errors).toHaveLength(1);
      expect(second.errors[0]).toContain('watcher process crashed');
    });
  });

  describe('restart after stop', () => {
    it('supports start() again after stop(), creating a fresh watcher subscription', async () => {
      const { fs, rootDir, rootId } = await makeSingleRepoRoot('brainstrike-git-inv-svc-restart-');
      const loadRootsSpy = vi.fn(() => Promise.resolve([{ id: rootId, path: rootDir }]));
      const fake = createFakeWatchDirectory();
      const service = makeService({
        fs,
        loadRootsSpy,
        run: makeWorktreeListRunner(),
        watchDirectory: fake.watchDirectory,
      });

      service.start();
      await service.getSnapshot();
      expect(fake.watchDirectorySpy).toHaveBeenCalledTimes(1);

      await service.stop();

      service.start();
      await service.getSnapshot();
      expect(fake.watchDirectorySpy).toHaveBeenCalledTimes(2);
    });

    it('throws when start() is called twice without an intervening stop()', async () => {
      const fake = createFakeWatchDirectory();
      const service = makeService({
        loadRootsSpy: vi.fn(() => Promise.resolve([])),
        watchDirectory: fake.watchDirectory,
      });

      service.start();
      await service.getSnapshot();
      expect(() => service.start()).toThrow(/already started/);
    });
  });

  describe('stop() drains an in-flight build (BST-1112 review Blocker 2)', () => {
    it('does not resolve until the pending build it is draining has settled', async () => {
      const { fs, rootDir, rootId } = await makeSingleRepoRoot(
        'brainstrike-git-inv-svc-stop-drain-'
      );
      let releaseLoadRoots: (() => void) | null = null;
      const loadRootsSpy = vi.fn(
        () =>
          new Promise<{ id: string; path: string }[]>((resolve) => {
            releaseLoadRoots = () => resolve([{ id: rootId, path: rootDir }]);
          })
      );
      const fake = createFakeWatchDirectory();
      const service = makeService({
        fs,
        loadRootsSpy,
        run: makeWorktreeListRunner(),
        watchDirectory: fake.watchDirectory,
      });

      service.start();
      expect(loadRootsSpy).toHaveBeenCalledTimes(1);

      let stopResolved = false;
      const stopPromise = service.stop().then(() => {
        stopResolved = true;
      });

      // Many microtask ticks — generous slack for anything stop() itself
      // legitimately awaits (e.g. disposing zero watcher subscriptions,
      // which still costs a few microtask hops via Promise.all([]) plus the
      // async-function wrapping) — but the build's `loadRoots()` gate is
      // still held, and nothing but calling `releaseLoadRoots()` can ever
      // unblock it, so stop() must not have resolved yet regardless of how
      // many microtask ticks elapse.
      let ticksRemaining = 50;
      while (ticksRemaining > 0) {
        await Promise.resolve();
        ticksRemaining -= 1;
      }
      expect(stopResolved).toBe(false);

      requireRelease(releaseLoadRoots, 'load-roots release')();
      await stopPromise;
      expect(stopResolved).toBe(true);
    });

    it('rejects a getSnapshot() call after stop() instead of rebuilding from the drained pre-stop build (BST-1112 review Blocker 1, 3712384894)', async () => {
      const { fs, rootDir, rootId } = await makeSingleRepoRoot(
        'brainstrike-git-inv-svc-stop-fresh-'
      );
      let releaseFirstLoadRoots: (() => void) | null = null;
      let loadRootsCallCount = 0;
      const loadRootsSpy = vi.fn(() => {
        loadRootsCallCount += 1;
        if (loadRootsCallCount === 1) {
          return new Promise<{ id: string; path: string }[]>((resolve) => {
            releaseFirstLoadRoots = () => resolve([{ id: rootId, path: rootDir }]);
          });
        }
        return Promise.resolve([{ id: rootId, path: rootDir }]);
      });
      const fake = createFakeWatchDirectory();
      const service = makeService({
        fs,
        loadRootsSpy,
        run: makeWorktreeListRunner(),
        watchDirectory: fake.watchDirectory,
      });

      service.start();
      const stopPromise = service.stop();
      requireRelease(releaseFirstLoadRoots, 'first load-roots release')();
      await stopPromise;

      // stop() no longer lets a post-stop getSnapshot() rebuild at all — it
      // rejects immediately with the typed `inventory-stopped` error. A
      // second loadRoots() call would mean a NEW build started against a
      // service that just tore itself down for shutdown.
      await expect(service.getSnapshot()).rejects.toMatchObject({ code: 'inventory-stopped' });
      expect(loadRootsCallCount).toBe(1);
    });

    it('runs a build for the NEW lifecycle after restarting while the pre-stop build was still draining, instead of coalescing onto the stale in-flight promise', async () => {
      const { fs, rootDir, rootId } = await makeSingleRepoRoot(
        'brainstrike-git-inv-svc-restart-race-'
      );
      let releaseFirstLoadRoots: (() => void) | null = null;
      let loadRootsCallCount = 0;
      const loadRootsSpy = vi.fn(() => {
        loadRootsCallCount += 1;
        if (loadRootsCallCount === 1) {
          return new Promise<{ id: string; path: string }[]>((resolve) => {
            releaseFirstLoadRoots = () => resolve([{ id: rootId, path: rootDir }]);
          });
        }
        return Promise.resolve([{ id: rootId, path: rootDir }]);
      });
      const fake = createFakeWatchDirectory();
      const service = makeService({
        fs,
        loadRootsSpy,
        run: makeWorktreeListRunner(),
        watchDirectory: fake.watchDirectory,
      });

      service.start();
      expect(loadRootsCallCount).toBe(1);

      // stop() clears `inFlightBuild` SYNCHRONOUSLY, before its first await —
      // this next line runs before any microtask from the still-pending
      // build A has a chance to fire, so the restart below cannot observe a
      // stale (but not-yet-nulled) in-flight promise from build A.
      const stopPromise = service.stop();
      service.start();
      requireRelease(releaseFirstLoadRoots, 'first load-roots release')();

      await service.getSnapshot();
      // A build ran for the new lifecycle (a second, distinct loadRoots()
      // call) rather than being short-circuited onto build A's promise.
      expect(loadRootsCallCount).toBe(2);

      await stopPromise;
    });

    it("does not let a stale, pre-stop build sync a NEW lifecycle's watcher set, even though that watcher instance is non-null", async () => {
      const { rootDir, rootId } = await makeSingleRepoRoot(
        'brainstrike-git-inv-svc-generation-sync-'
      );
      let releaseFirstLoadRoots: (() => void) | null = null;
      let loadRootsCallCount = 0;
      const loadRootsSpy = vi.fn(() => {
        loadRootsCallCount += 1;
        if (loadRootsCallCount === 1) {
          // Build A (generation 0, blocked): reports ONE repo.
          return new Promise<{ id: string; path: string }[]>((resolve) => {
            releaseFirstLoadRoots = () => resolve([{ id: rootId, path: rootDir }]);
          });
        }
        // Every later build (the new lifecycle) reports ZERO repos.
        return Promise.resolve([]);
      });
      const fake = createFakeWatchDirectory();
      const service = makeService({
        loadRootsSpy,
        run: makeWorktreeListRunner(),
        watchDirectory: fake.watchDirectory,
      });

      service.start(); // build A begins, blocked
      const stopPromise = service.stop(); // generation -> 1, watchers -> null synchronously
      service.start(); // NEW watchers instance for generation 1

      const fresh = await service.getSnapshot();
      expect(loadRootsCallCount).toBe(2);
      expect(fresh.repositories).toEqual([]);
      // The new lifecycle's own (empty) build subscribed nothing.
      expect(fake.watchDirectorySpy).toHaveBeenCalledTimes(0);

      // Now let build A (generation 0, ONE repo) finish. Without a generation
      // check gating the sync() call specifically (not just the cache write),
      // build A would call `watchers.sync([commonDir])` on the CURRENT
      // (generation-1, non-null) watchers instance and subscribe a repo the
      // new lifecycle's own build said does not exist.
      requireRelease(releaseFirstLoadRoots, 'first load-roots release')();
      await stopPromise;

      expect(fake.watchDirectorySpy).toHaveBeenCalledTimes(0);
    });
  });

  describe('a failed build leaves the cache dirty (BST-1112 review Should-fix 3)', () => {
    it('retries loadRoots() on the very next call instead of serving the empty failure snapshot for the rest of the TTL', async () => {
      let shouldFail = true;
      const loadRootsSpy = vi.fn(() =>
        shouldFail ? Promise.reject(new Error('db not ready')) : Promise.resolve([])
      );
      const fake = createFakeWatchDirectory();
      const service = makeService({ loadRootsSpy, watchDirectory: fake.watchDirectory });

      const first = await service.getSnapshot();
      expect(loadRootsSpy).toHaveBeenCalledTimes(1);
      expect(first.errors).toHaveLength(1);

      shouldFail = false;
      // Well inside the TTL — a `dirty=false`-on-failure cache would serve
      // the same empty failure snapshot for the rest of this window instead
      // of retrying.
      await vi.advanceTimersByTimeAsync(100);
      const second = await service.getSnapshot();
      expect(loadRootsSpy).toHaveBeenCalledTimes(2);
      expect(second.errors).toEqual([]);
    });
  });

  describe("start()'s initial build is pinned (BST-1112 review Should-fix 4)", () => {
    it('performs the initial build and watcher sync on its own, with no explicit getSnapshot() call', async () => {
      const { commonDir, fs, rootDir, rootId } = await makeSingleRepoRoot(
        'brainstrike-git-inv-svc-eager-'
      );
      const loadRootsSpy = vi.fn(() => Promise.resolve([{ id: rootId, path: rootDir }]));
      const fake = createFakeWatchDirectory();
      const service = makeService({
        fs,
        loadRootsSpy,
        run: makeWorktreeListRunner(),
        watchDirectory: fake.watchDirectory,
      });

      // Real timers for this test only: waiting for start()'s fire-and-forget
      // build to complete goes through real fs I/O (makeSingleRepoRoot's
      // temp dir), not just microtasks, so fake timers would stall it.
      vi.useRealTimers();
      service.start();

      await vi.waitFor(() => {
        expect(fake.watchDirectorySpy).toHaveBeenCalledTimes(1);
      });
      expect(fake.watchDirectorySpy.mock.calls[0]?.[0]).toBe(commonDir);
      expect(loadRootsSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('watcher-sync failure is a reachable, visible error (BST-1112 review Should-fix 5)', () => {
    it('surfaces a throwing disposer as a "watcher sync failed" error instead of dropping it', async () => {
      const { fs, rootDir, rootId } = await makeSingleRepoRoot(
        'brainstrike-git-inv-svc-sync-throw-'
      );
      let rootsPresent = true;
      const loadRootsSpy = vi.fn(() =>
        Promise.resolve(rootsPresent ? [{ id: rootId, path: rootDir }] : [])
      );
      const watchDirectorySpy = vi.fn(
        () =>
          Promise.resolve(() => {
            throw new Error('disposer failed: native handle already closed');
          }) as ReturnType<WatchGitCommonDir>
      );
      const watchDirectory = watchDirectorySpy as unknown as WatchGitCommonDir;
      const service = makeService({
        fs,
        loadRootsSpy,
        run: makeWorktreeListRunner(),
        watchDirectory,
      });

      service.start();
      const first = await service.getSnapshot();
      expect(first.errors).toEqual([]);

      // The repo disappears from the workspace roots, so the next rebuild's
      // watchers.sync() disposes the (throwing) subscription.
      rootsPresent = false;
      const second = await service.getSnapshot({ maxAgeMs: 0 });

      expect(second.errors).toHaveLength(1);
      expect(second.errors[0]).toContain('watcher sync failed');
      expect(second.errors[0]).toContain('disposer failed');
    });
  });

  describe('mid-build invalidation is not lost to the rebuild (BST-1112 review Should-fix 6)', () => {
    it('re-dirties for the next call when an invalidation arrives WHILE a rebuild is in flight', async () => {
      const { commonDir, fs, rootDir, rootId } = await makeSingleRepoRoot(
        'brainstrike-git-inv-svc-midbuild-'
      );
      let releaseSecondLoadRoots: (() => void) | null = null;
      let loadRootsCallCount = 0;
      const loadRootsSpy = vi.fn(() => {
        loadRootsCallCount += 1;
        if (loadRootsCallCount === 2) {
          return new Promise<{ id: string; path: string }[]>((resolve) => {
            releaseSecondLoadRoots = () => resolve([{ id: rootId, path: rootDir }]);
          });
        }
        return Promise.resolve([{ id: rootId, path: rootDir }]);
      });
      const fake = createFakeWatchDirectory();
      const service = makeService({
        fs,
        loadRootsSpy,
        run: makeWorktreeListRunner(),
        watchDirectory: fake.watchDirectory,
      });

      service.start();
      await service.getSnapshot();
      expect(loadRootsCallCount).toBe(1);

      // Force a second rebuild (bypassing the TTL); it hangs inside
      // loadRoots() until released below. The synchronous prologue of
      // getSnapshot()/rebuild()/buildInventorySnapshot already calls
      // loadRoots() before this line returns, so the count below is
      // observable with no extra awaits.
      const secondSnapshotPromise = service.getSnapshot({ maxAgeMs: 0 });
      expect(loadRootsCallCount).toBe(2);

      // The invalidation arrives WHILE the second rebuild is in flight.
      const sub = fake.subscriptionsByCommonDir.get(commonDir);
      expect(sub).toBeDefined();
      sub?.fireInterestingChange();
      await vi.advanceTimersByTimeAsync(GIT_INVENTORY_WATCH_BATCH_MS);

      requireRelease(releaseSecondLoadRoots, 'second load-roots release')();
      await secondSnapshotPromise;
      expect(loadRootsCallCount).toBe(2);

      // Still well inside the TTL of the second build's capturedAt — a THIRD
      // rebuild proves the mid-flight invalidation survived the second
      // build's own completion instead of being silently overwritten by it.
      await service.getSnapshot();
      expect(loadRootsCallCount).toBe(3);
    });
  });

  describe('getSnapshot() maxAgeMs validation (BST-1112 review Minor 8)', () => {
    it.each([Number.NaN, -1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
      'throws for invalid maxAgeMs %p instead of silently coercing it',
      async (maxAgeMs) => {
        const fake = createFakeWatchDirectory();
        const service = makeService({
          loadRootsSpy: vi.fn(() => Promise.resolve([])),
          watchDirectory: fake.watchDirectory,
        });

        await expect(service.getSnapshot({ maxAgeMs })).rejects.toThrow(/invalid maxAgeMs/);
      }
    );

    it('still treats maxAgeMs: 0 as a valid "force rebuild" value, not an invalid one', async () => {
      const loadRootsSpy = vi.fn(() => Promise.resolve([]));
      const fake = createFakeWatchDirectory();
      const service = makeService({ loadRootsSpy, watchDirectory: fake.watchDirectory });

      await service.getSnapshot();
      expect(loadRootsSpy).toHaveBeenCalledTimes(1);
      // Well inside the TTL, and the cache is clean — a forced call rebuilds
      // anyway. (Case (b) of the BST-1397 forced-refresh contract.)
      await service.getSnapshot({ maxAgeMs: 0 });
      expect(loadRootsSpy).toHaveBeenCalledTimes(2);
    });
  });

  // BST-1397: `maxAgeMs: 0` is the seam a caller that JUST wrote a `roots` row
  // uses to guarantee the inventory rebuild — and therefore the per-repository
  // watcher arming — sees it. Plain coalescing silently defeats that: the
  // in-flight build's `loadRoots()` already ran, so its result predates the
  // new row and the renderer's nudge is swallowed.
  describe('watcher health errors are folded exactly once (BST-1112 review Minor 9)', () => {
    it('does not double-count a persistently dead watcher across a forced rebuild', async () => {
      const { fs, rootDir, rootId } = await makeSingleRepoRoot(
        'brainstrike-git-inv-svc-double-count-'
      );
      const loadRootsSpy = vi.fn(() => Promise.resolve([{ id: rootId, path: rootDir }]));

      let subscribeCallCount = 0;
      let firstOnSignal: ((signal: FileSystemWatchSignal) => void) | undefined;
      const watchDirectorySpy = vi.fn(
        (
          _commonDir: string,
          _callback: (changes: FileSystemChange[]) => void,
          onSignal?: (signal: FileSystemWatchSignal) => void
        ) => {
          subscribeCallCount += 1;
          if (subscribeCallCount === 1) {
            firstOnSignal = onSignal;
            return Promise.resolve(() => {});
          }
          // The resubscribe (retry) attempt also fails, so the watcher stays
          // dead across the forced rebuild below.
          return Promise.reject(new Error('watcher backend still unavailable'));
        }
      );
      const watchDirectory = watchDirectorySpy as unknown as WatchGitCommonDir;
      const service = makeService({
        fs,
        loadRootsSpy,
        run: makeWorktreeListRunner(),
        watchDirectory,
      });

      service.start();
      await service.getSnapshot();
      firstOnSignal?.({ message: 'watcher process crashed', type: 'errored' });

      const forced = await service.getSnapshot({ maxAgeMs: 0 });

      // `rebuild()` must cache the RAW snapshot (no health-error folding);
      // only `getSnapshot()` folds health errors in, exactly once. Folding
      // twice (once inside rebuild() before caching, once again in
      // getSnapshot()) would duplicate this entry.
      expect(forced.errors).toHaveLength(1);
      expect(forced.errors[0]).toContain('watcher');
    });
  });

  describe('getSnapshot() while stopped can no longer leave a stale-fresh cache behind for start() to miss (BST-1112 review Blocker 1, 3712384894)', () => {
    it('rejects a getSnapshot() call made while stopped, then subscribes a NEW watcher instance on the next start()', async () => {
      const { fs, rootDir, rootId } = await makeSingleRepoRoot(
        'brainstrike-git-inv-svc-start-dirty-'
      );
      const loadRootsSpy = vi.fn(() => Promise.resolve([{ id: rootId, path: rootDir }]));
      const fake = createFakeWatchDirectory();
      const service = makeService({
        fs,
        loadRootsSpy,
        run: makeWorktreeListRunner(),
        watchDirectory: fake.watchDirectory,
      });

      service.start();
      await service.getSnapshot();
      expect(fake.watchDirectorySpy).toHaveBeenCalledTimes(1);

      await service.stop();

      // Previously "documented-supported": getSnapshot() after stop()
      // rebuilt from scratch, leaving a FRESH, non-dirty cache behind with no
      // live watchers — which is exactly the "new build after stop()" defect
      // the `stopped` flag closes. It now rejects instead, so no rebuild (and
      // therefore no such cache) happens at all.
      await expect(service.getSnapshot()).rejects.toMatchObject({ code: 'inventory-stopped' });
      expect(loadRootsSpy).toHaveBeenCalledTimes(1);

      service.start();
      await service.getSnapshot();
      // The freshly-created watcher instance from THIS start() must get its
      // own sync() call. If start() didn't force `dirty = true`, the
      // (now provably impossible) non-dirty cache from a stopped-state
      // getSnapshot() would make this getSnapshot() a cache hit that skips
      // rebuild() — and therefore skips subscribing the new watcher instance
      // to anything.
      expect(fake.watchDirectorySpy).toHaveBeenCalledTimes(2);
      expect(loadRootsSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('stopped flag blocks new builds after stop() (BST-1112 review Blocker 1, 3712384894)', () => {
    it('rejects getSnapshot() after stop() has resolved, with a typed inventory-stopped error', async () => {
      const fake = createFakeWatchDirectory();
      const service = makeService({
        loadRootsSpy: vi.fn(() => Promise.resolve([])),
        watchDirectory: fake.watchDirectory,
      });

      service.start();
      await service.getSnapshot();
      await service.stop();

      await expect(service.getSnapshot()).rejects.toMatchObject({ code: 'inventory-stopped' });
    });

    it('does not start a new build for a getSnapshot() call that lands while stop() is still draining the in-flight build', async () => {
      const { fs, rootDir, rootId } = await makeSingleRepoRoot(
        'brainstrike-git-inv-svc-stopped-drain-'
      );
      let releaseLoadRoots: (() => void) | null = null;
      const loadRootsSpy = vi.fn(
        () =>
          new Promise<{ id: string; path: string }[]>((resolve) => {
            releaseLoadRoots = () => resolve([{ id: rootId, path: rootDir }]);
          })
      );
      const fake = createFakeWatchDirectory();
      const service = makeService({
        fs,
        loadRootsSpy,
        run: makeWorktreeListRunner(),
        watchDirectory: fake.watchDirectory,
      });

      service.start();
      expect(loadRootsSpy).toHaveBeenCalledTimes(1);

      const stopPromise = service.stop();

      // stop() is now draining the in-flight build (still blocked on
      // loadRoots()). A getSnapshot() call that lands in this window must not
      // start a SECOND build — the `stopped` flag it set synchronously
      // BEFORE draining rejects it immediately instead of racing the drain.
      await expect(service.getSnapshot()).rejects.toMatchObject({ code: 'inventory-stopped' });
      expect(loadRootsSpy).toHaveBeenCalledTimes(1);

      requireRelease(releaseLoadRoots, 'load-roots release')();
      await stopPromise;
    });
  });
});
