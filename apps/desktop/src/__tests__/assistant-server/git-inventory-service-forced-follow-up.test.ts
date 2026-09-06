/**
 * `GitInventoryService`'s forced (`maxAgeMs: 0`) follow-up mechanism
 * (BST-1397) and its interaction with `stop()` (BST-1400 item 10) — split
 * out of `git-inventory-service-lifecycle.test.ts`, which crossed Biome's
 * 1000-line cap once this file's own second review fold-in test landed.
 * Same harness and conventions as that file: exercises the REAL
 * `buildInventorySnapshot`/`createGitInventoryWatchers` collaborators via
 * fakes, nothing stubbed to throw.
 */
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
  GIT_INVENTORY_STOP_DRAIN_TIMEOUT_MS,
  GitInventoryStoppedError,
} from '../../assistant-server/git-inventory-service';
import type { GitCommandRun, GitCommandRunner } from '../../assistant-server/git-service';
import {
  cleanupTempDirs,
  createFakeWatchDirectory,
  makeService,
  makeSingleRepoRoot,
  makeWorktreeListRunner,
} from './git-inventory-service-test-support';

afterEach(async () => {
  await cleanupTempDirs();
});

/**
 * A `loadRoots` whose FIRST call resolves immediately (so an initial build
 * settles and a follow-up can PROMOTE off it), and every call from the
 * second onward never settles — models the follow-up's own promoted build
 * being the one `stop()` must abandon, not the build it originally waited
 * on.
 */
function makeLoadRootsSecondCallHangs(roots: { id: string; path: string }[]): {
  readonly loadRootsSpy: ReturnType<
    typeof vi.fn<() => Promise<readonly { id: string; path: string }[]>>
  >;
} {
  let calls = 0;
  const loadRootsSpy = vi.fn(async (): Promise<readonly { id: string; path: string }[]> => {
    calls += 1;
    if (calls >= 2) {
      return new Promise<readonly { id: string; path: string }[]>(() => {
        // Intentionally never settles.
      });
    }
    return [...roots];
  });
  return { loadRootsSpy };
}

describe('createGitInventoryService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    loggerErrorSpy.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('forced refresh guarantees a build that started after the call', () => {
    /**
     * A `loadRoots` whose FIRST call blocks until released, and which each
     * time reports whatever roots the test has registered by the moment it
     * ran — so "did this build see the late root?" is directly observable.
     */
    type LoadRootsSpy = ReturnType<
      typeof vi.fn<() => Promise<readonly { id: string; path: string }[]>>
    >;

    function makeGatedLoadRoots(roots: { id: string; path: string }[]): {
      readonly loadRootsSpy: LoadRootsSpy;
      readonly release: () => void;
    } {
      let release = (): void => undefined;
      const firstCallGate = new Promise<void>((resolve) => {
        release = () => resolve();
      });
      let calls = 0;
      const loadRootsSpy: LoadRootsSpy = vi.fn(
        async (): Promise<readonly { id: string; path: string }[]> => {
          calls += 1;
          const observed = [...roots];
          if (calls === 1) {
            await firstCallGate;
          }
          return observed;
        }
      );
      return { loadRootsSpy, release };
    }

    it('awaits the in-flight build and then runs exactly ONE more, returning the later snapshot', async () => {
      const { fs, rootDir, rootId } = await makeSingleRepoRoot('brainstrike-git-inv-svc-forced-');
      const roots: { id: string; path: string }[] = [];
      const { loadRootsSpy, release } = makeGatedLoadRoots(roots);
      const fake = createFakeWatchDirectory();
      const service = makeService({
        fs,
        loadRootsSpy,
        run: makeWorktreeListRunner(),
        watchDirectory: fake.watchDirectory,
      });

      const inFlight = service.getSnapshot();
      await vi.advanceTimersByTimeAsync(0);
      expect(loadRootsSpy).toHaveBeenCalledTimes(1);

      // The registration the forced call is reporting: it lands AFTER the
      // in-flight build read the roots table.
      roots.push({ id: rootId, path: rootDir });
      const forced = service.getSnapshot({ maxAgeMs: 0 });
      release();

      const [stale, fresh] = await Promise.all([inFlight, forced]);
      expect(loadRootsSpy).toHaveBeenCalledTimes(2);
      expect(stale.repositories).toHaveLength(0);
      expect(fresh.repositories).toHaveLength(1);
    });

    it('coalesces two concurrent forced calls onto ONE follow-up build', async () => {
      const roots: { id: string; path: string }[] = [];
      const { loadRootsSpy, release } = makeGatedLoadRoots(roots);
      const fake = createFakeWatchDirectory();
      const service = makeService({ loadRootsSpy, watchDirectory: fake.watchDirectory });

      const inFlight = service.getSnapshot();
      await vi.advanceTimersByTimeAsync(0);

      const forcedA = service.getSnapshot({ maxAgeMs: 0 });
      const forcedB = service.getSnapshot({ maxAgeMs: 0 });
      release();

      const [, a, b] = await Promise.all([inFlight, forcedA, forcedB]);
      // One initial build plus ONE follow-up — never one per forced caller.
      expect(loadRootsSpy).toHaveBeenCalledTimes(2);
      expect(a).toEqual(b);
    });

    it('leaves the plain coalescing path alone: an unforced call still shares the in-flight build', async () => {
      const roots: { id: string; path: string }[] = [];
      const { loadRootsSpy, release } = makeGatedLoadRoots(roots);
      const fake = createFakeWatchDirectory();
      const service = makeService({ loadRootsSpy, watchDirectory: fake.watchDirectory });

      const inFlight = service.getSnapshot();
      await vi.advanceTimersByTimeAsync(0);
      const joined = service.getSnapshot();
      release();

      await Promise.all([inFlight, joined]);
      expect(loadRootsSpy).toHaveBeenCalledTimes(1);
    });

    it('rejects a forced follow-up whose service was stopped while it waited, instead of building against a closed DB', async () => {
      const roots: { id: string; path: string }[] = [];
      const { loadRootsSpy, release } = makeGatedLoadRoots(roots);
      const fake = createFakeWatchDirectory();
      const service = makeService({ loadRootsSpy, watchDirectory: fake.watchDirectory });

      const inFlight = service.getSnapshot();
      await vi.advanceTimersByTimeAsync(0);
      const forced = service.getSnapshot({ maxAgeMs: 0 });
      const forcedSettled = expect(forced).rejects.toBeInstanceOf(GitInventoryStoppedError);

      const stopping = service.stop();
      release();
      await inFlight;
      await stopping;
      await forcedSettled;

      expect(loadRootsSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('stop() bounds its drain of a build that never settles (BST-1112 P1, codex 3712467640)', () => {
    it('aborts the build signal, resolves within GIT_INVENTORY_STOP_DRAIN_TIMEOUT_MS, and logs the abandonment', async () => {
      const { fs, rootDir, rootId } = await makeSingleRepoRoot(
        'brainstrike-git-inv-svc-drain-bound-'
      );
      const loadRootsSpy = vi.fn(() => Promise.resolve([{ id: rootId, path: rootDir }]));

      let resolveRunCalled: (() => void) | undefined;
      const runCalled = new Promise<void>((resolve) => {
        resolveRunCalled = resolve;
      });
      let capturedSignal: AbortSignal | undefined;
      // Never resolves — simulates a git child process that ignores the
      // abort signal (e.g. unresponsive/zombied), so this test proves
      // stop()'s own TIMEOUT bound protects the shutdown deadline, not the
      // abort mechanism itself (that wiring is asserted separately below via
      // `capturedSignal`).
      const run: GitCommandRunner = (params) => {
        capturedSignal = params.signal;
        resolveRunCalled?.();
        return new Promise<GitCommandRun>(() => {
          // Intentionally never settles.
        });
      };
      const fake = createFakeWatchDirectory();
      const service = makeService({
        fs,
        loadRootsSpy,
        run,
        watchDirectory: fake.watchDirectory,
      });

      service.start();
      // Real awaits (not fake-timer-dependent) until the build's git spawn —
      // resolveRoots()'s realpath and the FakeFs walk are all real
      // microtask/IO work, not timer-scheduled.
      await runCalled;
      expect(capturedSignal?.aborted).toBe(false);

      let stopResolved = false;
      const stopPromise = service.stop().then(() => {
        stopResolved = true;
      });

      // stop() aborts synchronously, before it ever awaits the drain race.
      expect(capturedSignal?.aborted).toBe(true);

      await vi.advanceTimersByTimeAsync(GIT_INVENTORY_STOP_DRAIN_TIMEOUT_MS - 1);
      expect(stopResolved).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await stopPromise;
      expect(stopResolved).toBe(true);
      expect(loggerErrorSpy).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining('abandoned'),
        expect.objectContaining({ drainTimeoutMs: GIT_INVENTORY_STOP_DRAIN_TIMEOUT_MS })
      );

      // The `stopped` flag (set synchronously, before this whole drain even
      // started) still rejects any post-stop getSnapshot() — the abandoned
      // build's eventual (here: never) settlement has no way back in.
      await expect(service.getSnapshot()).rejects.toMatchObject({ code: 'inventory-stopped' });
    });

    // BST-1400 item 10: a FORCED (maxAgeMs: 0) caller awaiting the build
    // stop() is about to abandon has, before this fix, no OTHER settle path —
    // its follow-up promise was a bare `.then()` chain off the abandoned
    // build, which (as this same suite's "never settles" run fakes above)
    // may never resolve. Without stop() explicitly rejecting it, the forced
    // caller hangs forever even though stop() itself already returned.
    it('rejects a forced follow-up caller instead of leaving it hanging on the build stop() abandons', async () => {
      const { fs, rootDir, rootId } = await makeSingleRepoRoot(
        'brainstrike-git-inv-svc-forced-abandon-'
      );
      const loadRootsSpy = vi.fn(() => Promise.resolve([{ id: rootId, path: rootDir }]));

      let resolveRunCalled: (() => void) | undefined;
      const runCalled = new Promise<void>((resolve) => {
        resolveRunCalled = resolve;
      });
      // Same "never settles" fake as the sibling test above — the forced
      // waiter's ONLY other settle path is chained off this build, so if
      // stop() did not settle it directly, the assertions below would hang
      // the test rather than fail it cleanly.
      const run: GitCommandRunner = () => {
        resolveRunCalled?.();
        return new Promise<GitCommandRun>(() => {
          // Intentionally never settles.
        });
      };
      const fake = createFakeWatchDirectory();
      const service = makeService({
        fs,
        loadRootsSpy,
        run,
        watchDirectory: fake.watchDirectory,
      });

      service.start();
      await runCalled;

      // Queues onto awaitForcedFollowUp(inFlightBuild) — the in-flight build
      // (start()'s own eager getSnapshot()) is the one that never settles.
      const forced = service.getSnapshot({ maxAgeMs: 0 });
      const forcedOutcome = forced.then(
        () => 'resolved' as const,
        (error: unknown) => ({ error, kind: 'rejected' as const })
      );

      const stopPromise = service.stop();
      await vi.advanceTimersByTimeAsync(GIT_INVENTORY_STOP_DRAIN_TIMEOUT_MS);
      await stopPromise;

      // Settles promptly — bounded by stop()'s own drain timeout, not left to
      // whatever "eventually, maybe never" the abandoned build does.
      const outcome = await forcedOutcome;
      expect(outcome).toMatchObject({ error: { code: 'inventory-stopped' }, kind: 'rejected' });
    });

    // PR #2685 review, item 10 fold-in #2: the sibling test above abandons
    // the build the forced caller ORIGINALLY waited on (start()'s own
    // eager build), which never settles — `forcedFollowUpWaiter` is still
    // populated when stop() runs. This test instead lets that first build
    // SETTLE, so the follow-up PROMOTES into its own build (clearing the
    // coalescing slot as part of that), and only THEN does stop() abandon —
    // the exact window where the single-slot version of this fix had
    // nothing left to reject, and the caller hung forever.
    it('rejects a forced follow-up whose OWN promoted build is what stop() abandons, not just the build it originally waited on', async () => {
      const roots: { id: string; path: string }[] = [];
      const { loadRootsSpy } = makeLoadRootsSecondCallHangs(roots);
      const fake = createFakeWatchDirectory();
      const service = makeService({ loadRootsSpy, watchDirectory: fake.watchDirectory });

      // B1: start()'s own eager build (loadRootsSpy call 1) — resolves on
      // its own, no gate needed.
      const inFlight = service.getSnapshot();
      // Forced call made in the SAME synchronous tick, before anything has
      // had a chance to let B1 settle: inFlightBuild is definitely still
      // set here, so this correctly queues onto awaitForcedFollowUp(B1) —
      // flushing first (as the sibling tests above do, where it is safe
      // because their loadRoots is explicitly gated) would let B1 resolve
      // and clear inFlightBuild first, racing this call past the wrapper
      // entirely and into its own unwrapped build with no
      // pendingForcedRejects registration to falsify against.
      const forced = service.getSnapshot({ maxAgeMs: 0 });
      const forcedOutcome = forced.then(
        () => 'resolved' as const,
        (error: unknown) => ({ error, kind: 'rejected' as const })
      );

      // B1 settles, which promotes the follow-up into starting B2
      // (loadRootsSpy call 2) — the fixture makes THIS ONE hang forever.
      await inFlight;
      await vi.advanceTimersByTimeAsync(0);
      expect(loadRootsSpy).toHaveBeenCalledTimes(2);

      const stopPromise = service.stop();
      await vi.advanceTimersByTimeAsync(GIT_INVENTORY_STOP_DRAIN_TIMEOUT_MS);
      await stopPromise;

      // Still settles promptly — the forced caller's promise now depends on
      // B2, not B1, and stop() must still be able to reject it.
      const outcome = await forcedOutcome;
      expect(outcome).toMatchObject({ error: { code: 'inventory-stopped' }, kind: 'rejected' });
    });
  });
});
