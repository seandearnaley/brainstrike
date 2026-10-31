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
import { GitInventoryStoppedError } from '../../assistant-server/git-inventory-service';
import type { GitCommandRun, GitCommandRunner } from '../../assistant-server/git-service';
import {
  cleanupTempDirs,
  createFakeWatchDirectory,
  makeService,
  makeSingleRepoRoot,
  makeWorktreeListRunner,
} from './git-inventory-service-test-support';

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

afterEach(async () => {
  await cleanupTempDirs();
});

/**
 * A `loadRoots` whose FIRST call resolves immediately (so an initial build
 * settles and a follow-up can PROMOTE off it), and every call from the
 * second onward settles only `lateMs` later — models the follow-up's own
 * promoted build being the one `stop()` joins, not the build it originally
 * waited on.
 */
function makeLoadRootsSecondCallLate(
  roots: { id: string; path: string }[],
  lateMs: number
): {
  readonly loadRootsSpy: ReturnType<
    typeof vi.fn<() => Promise<readonly { id: string; path: string }[]>>
  >;
} {
  let calls = 0;
  const loadRootsSpy = vi.fn(async (): Promise<readonly { id: string; path: string }[]> => {
    calls += 1;
    if (calls >= 2) {
      return new Promise<readonly { id: string; path: string }[]>((resolve) => {
        setTimeout(() => resolve([...roots]), lateMs);
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

  describe('stop() joins its in-flight build (ADR-0026 R4)', () => {
    it('does not resolve until a build that ignores its abort for 5 s settles, and logs no abandonment', async () => {
      const { fs, rootDir, rootId } = await makeSingleRepoRoot(
        'brainstrike-git-inv-svc-join-late-build-'
      );
      const loadRootsSpy = vi.fn(() => Promise.resolve([{ id: rootId, path: rootDir }]));
      const { promise: runCalled, resolve: resolveRunCalled } = Promise.withResolvers<void>();
      let capturedSignal: AbortSignal | undefined;
      // A git child that ignores the abort and only fails 5 s later, longer
      // than the 2 s the old drain bound waited before abandoning the build.
      const run: GitCommandRunner = (params) => {
        capturedSignal = params.signal;
        resolveRunCalled?.();
        return new Promise<GitCommandRun>((_resolve, reject) => {
          setTimeout(() => reject(new Error('git exited late after its abort')), 5000);
        });
      };
      const fake = createFakeWatchDirectory();
      const service = makeService({ fs, loadRootsSpy, run, watchDirectory: fake.watchDirectory });

      service.start();
      await runCalled;
      let stopResolved = false;
      const stopPromise = service.stop().then(() => {
        stopResolved = true;
      });
      expect(capturedSignal?.aborted).toBe(true);

      await vi.advanceTimersByTimeAsync(2000);
      const resolvedAtTwoSeconds = stopResolved;
      await vi.advanceTimersByTimeAsync(2999);
      const resolvedBeforeTheBuildSettled = stopResolved;
      await vi.advanceTimersByTimeAsync(1);
      await stopPromise;

      expect({ resolvedAtTwoSeconds, resolvedBeforeTheBuildSettled }).toEqual({
        resolvedAtTwoSeconds: false,
        resolvedBeforeTheBuildSettled: false,
      });
      expect(loggerErrorSpy).not.toHaveBeenCalled();
      await expect(service.getSnapshot()).rejects.toMatchObject({ code: 'inventory-stopped' });
    });
  });

  describe('a forced follow-up settles once stop() has joined the build it depends on (BST-1400 item 10)', () => {
    // A forced (maxAgeMs: 0) caller waits on the build stop() aborts. stop()
    // joins that build instead of abandoning it, so the caller's chain settles
    // with it: rejected as stopped, never left hanging.
    it('rejects a forced follow-up caller once the build stop() joins has settled', async () => {
      const { fs, rootDir, rootId } = await makeSingleRepoRoot(
        'brainstrike-git-inv-svc-forced-join-'
      );
      const loadRootsSpy = vi.fn(() => Promise.resolve([{ id: rootId, path: rootDir }]));
      const { promise: runCalled, resolve: resolveRunCalled } = Promise.withResolvers<void>();
      // The git child ignores the abort and only fails 5 s later.
      const run: GitCommandRunner = () => {
        resolveRunCalled?.();
        return new Promise<GitCommandRun>((_resolve, reject) => {
          setTimeout(() => reject(new Error('git exited late after its abort')), 5000);
        });
      };
      const fake = createFakeWatchDirectory();
      const service = makeService({ fs, loadRootsSpy, run, watchDirectory: fake.watchDirectory });

      service.start();
      await runCalled;
      // Queues onto awaitForcedFollowUp(inFlightBuild): start()'s own build.
      let forcedOutcome: unknown = 'pending';
      const forced = service.getSnapshot({ maxAgeMs: 0 }).then(
        () => {
          forcedOutcome = 'resolved';
        },
        (error: unknown) => {
          forcedOutcome = error;
        }
      );
      let stopResolved = false;
      const stopPromise = service.stop().then(() => {
        stopResolved = true;
      });

      await vi.advanceTimersByTimeAsync(4999);
      expect({ forcedOutcome, stopResolved }).toEqual({
        forcedOutcome: 'pending',
        stopResolved: false,
      });
      await vi.advanceTimersByTimeAsync(1);
      await Promise.all([stopPromise, forced]);
      expect(forcedOutcome).toMatchObject({ code: 'inventory-stopped' });
      expect(loadRootsSpy).toHaveBeenCalledTimes(1);
      expect(loggerErrorSpy).not.toHaveBeenCalled();
    });

    // PR #2685 review, item 10 fold-in #2: the first build SETTLES, so the
    // follow-up PROMOTES into its own build (clearing the coalescing slot), and
    // only THEN does stop() run. stop() joins that promoted build, so the forced
    // caller still settles, with the build it was promised.
    it('settles a forced follow-up whose OWN promoted build is the one stop() joins', async () => {
      const roots: { id: string; path: string }[] = [];
      const { loadRootsSpy } = makeLoadRootsSecondCallLate(roots, 5000);
      const fake = createFakeWatchDirectory();
      const service = makeService({ loadRootsSpy, watchDirectory: fake.watchDirectory });

      // B1: resolves on its own. The forced call is made in the SAME tick, so
      // it queues onto awaitForcedFollowUp(B1) before B1 can settle.
      const inFlight = service.getSnapshot();
      let forcedOutcome: unknown = 'pending';
      const forced = service.getSnapshot({ maxAgeMs: 0 }).then(
        () => {
          forcedOutcome = 'resolved';
        },
        (error: unknown) => {
          forcedOutcome = error;
        }
      );

      // B1 settles, which promotes the follow-up into starting B2 (loadRoots
      // call 2), which settles only 5 s later.
      await inFlight;
      await vi.advanceTimersByTimeAsync(0);
      expect(loadRootsSpy).toHaveBeenCalledTimes(2);

      let stopResolved = false;
      const stopPromise = service.stop().then(() => {
        stopResolved = true;
      });
      await vi.advanceTimersByTimeAsync(4999);
      expect({ forcedOutcome, stopResolved }).toEqual({
        forcedOutcome: 'pending',
        stopResolved: false,
      });
      await vi.advanceTimersByTimeAsync(1);
      await Promise.all([stopPromise, forced]);
      // The promoted build started after the forced call, as promised.
      expect(forcedOutcome).toBe('resolved');
      expect(loggerErrorSpy).not.toHaveBeenCalled();
    });
  });
});
