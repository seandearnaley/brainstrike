/**
 * `createGitInventoryService`'s `onInvalidate` dep (BST-1161): the seam that
 * feeds the `changes:invalidated` push-to-renderer broadcast. Split from
 * `git-inventory-service-lifecycle.test.ts` (max-lines cap); same harness via
 * `git-inventory-service-test-support.ts` — real service, real watchers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GIT_INVENTORY_WATCH_BATCH_MS } from '../../assistant-server/git-inventory-watcher';
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

describe('createGitInventoryService — onInvalidate dep forwards the invalidated repo (BST-1161)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    loggerErrorSpy.mockClear();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await cleanupTempDirs();
  });

  it('forwards the watcher-invalidated commonDir with its repositoryRoot resolved from the cached snapshot, AFTER marking the cache dirty', async () => {
    const { commonDir, fs, rootDir, rootId } = await makeSingleRepoRoot(
      'brainstrike-git-inv-svc-oninvalidate-'
    );
    const loadRootsSpy = vi.fn(() => Promise.resolve([{ id: rootId, path: rootDir }]));
    const fake = createFakeWatchDirectory();
    const onInvalidate = vi.fn();
    const service = makeService({
      fs,
      loadRootsSpy,
      onInvalidate,
      run: makeWorktreeListRunner(),
      watchDirectory: fake.watchDirectory,
    });

    service.start();
    await service.getSnapshot();
    expect(onInvalidate).not.toHaveBeenCalled();

    const sub = fake.subscriptionsByCommonDir.get(commonDir);
    expect(sub).toBeDefined();
    sub?.fireInterestingChange();
    await vi.advanceTimersByTimeAsync(GIT_INVENTORY_WATCH_BATCH_MS);

    expect(onInvalidate).toHaveBeenCalledExactlyOnceWith({
      gitCommonDir: commonDir,
      repositoryRoot: rootDir,
    });
    // The dep fires alongside the dirty-mark, so consumers refetching on the
    // push observe a rebuild, never the stale cache.
    await service.getSnapshot();
    expect(loadRootsSpy).toHaveBeenCalledTimes(2);
  });

  it('still marks the cache dirty (and logs) when the onInvalidate dep itself throws', async () => {
    const { commonDir, fs, rootDir, rootId } = await makeSingleRepoRoot(
      'brainstrike-git-inv-svc-oninvalidate-throw-'
    );
    const loadRootsSpy = vi.fn(() => Promise.resolve([{ id: rootId, path: rootDir }]));
    const fake = createFakeWatchDirectory();
    const onInvalidate = vi.fn(() => {
      throw new Error('renderer broadcast exploded');
    });
    const service = makeService({
      fs,
      loadRootsSpy,
      onInvalidate,
      run: makeWorktreeListRunner(),
      watchDirectory: fake.watchDirectory,
    });

    service.start();
    await service.getSnapshot();

    const sub = fake.subscriptionsByCommonDir.get(commonDir);
    sub?.fireInterestingChange();
    await vi.advanceTimersByTimeAsync(GIT_INVENTORY_WATCH_BATCH_MS);

    expect(onInvalidate).toHaveBeenCalledTimes(1);
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('onInvalidate'),
      expect.objectContaining({ error: expect.stringContaining('renderer broadcast exploded') })
    );
    // The throw must not lose the invalidation itself.
    await service.getSnapshot();
    expect(loadRootsSpy).toHaveBeenCalledTimes(2);
  });
});
