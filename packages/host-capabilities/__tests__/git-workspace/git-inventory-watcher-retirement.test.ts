/**
 * BST-2248: `createGitInventoryWatchers` keeps a native subscription it failed
 * to release until its unsubscribe succeeds. A failed `sync()` drop or retry
 * stays owned; the next `sync()` or terminal `disposeAll()` retries it, once
 * per call, and a retirement that fails again rejects visibly. A subscription
 * dropped with its handle would stay live into Electron teardown, where its
 * late native completion aborts Main (BST-2244).
 */
import path from 'node:path';
import type { FileSystemChange } from '@brainstrike/types';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import {
  createGitInventoryWatchers,
  GIT_INVENTORY_WATCH_BATCH_MS,
  type GitInventoryWatcherDeps,
  type WatchGitCommonDir,
} from '../../src/git-workspace/git-inventory-watcher.ts';

const failure = new Error('native unsubscribe failed');

/**
 * A native disposer whose first `failures` unsubscribes reject with `failure`.
 * `released` counts the unsubscribes that succeeded.
 */
function flakyNativeDispose(failures: number): {
  readonly dispose: Mock<() => Promise<void>>;
  readonly released: () => number;
} {
  let remainingFailures = failures;
  let released = 0;
  return {
    dispose: vi.fn(() => {
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        return Promise.reject(failure);
      }
      released += 1;
      return Promise.resolve();
    }),
    released: () => released,
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

afterEach(() => {
  vi.useRealTimers();
});

describe('git inventory watchers keep a failed retirement until its unsubscribe succeeds (BST-2248)', () => {
  it('retries a failed sync() drop in the terminal dispose, without blocking other subscribes', async () => {
    const repoA = flakyNativeDispose(1);
    const repoB = flakyNativeDispose(0);
    const watchers = createGitInventoryWatchers(
      makeDeps({
        watchDirectory: (commonDir) =>
          Promise.resolve(commonDir === '/repo-a/.git' ? repoA.dispose : repoB.dispose),
      })
    );
    await watchers.sync(['/repo-a/.git']);

    await expect(watchers.sync(['/repo-b/.git'])).rejects.toThrow();
    await watchers.disposeAll();

    expect(repoA.dispose).toHaveBeenCalledTimes(2);
    expect(repoA.released()).toBe(1);
    expect(repoB.released()).toBe(1);
  });

  it('resubscribes a re-listed common dir only once a later sync() releases its failed retirement', async () => {
    const native = flakyNativeDispose(2);
    const watchDirectory = vi.fn<WatchGitCommonDir>(() => Promise.resolve(native.dispose));
    const watchers = createGitInventoryWatchers(makeDeps({ watchDirectory }));
    await watchers.sync(['/repo/.git']);
    await expect(watchers.sync([])).rejects.toThrow();

    // Still owned: its retry fails again, so no second native subscription
    // opens beside the unreleased one.
    await expect(watchers.sync(['/repo/.git'])).rejects.toThrow();
    expect(watchDirectory).toHaveBeenCalledOnce();

    await watchers.sync(['/repo/.git']);
    expect(native.dispose).toHaveBeenCalledTimes(3);
    expect(native.released()).toBe(1);
    expect(watchDirectory).toHaveBeenCalledTimes(2);
  });

  it('never invalidates for a common dir sync() dropped while its retirement is in flight', async () => {
    vi.useFakeTimers();
    const unsubscribe = Promise.withResolvers<void>();
    const onInvalidate = vi.fn();
    const watchDirectory = vi.fn<WatchGitCommonDir>(() =>
      Promise.resolve(() => unsubscribe.promise)
    );
    const watchers = createGitInventoryWatchers(makeDeps({ onInvalidate, watchDirectory }));
    await watchers.sync(['/repo/.git']);

    const dropping = watchers.sync([]);
    const change: FileSystemChange = {
      kind: 'file',
      path: path.join('/repo/.git', 'HEAD'),
      type: 'modified',
    };
    const onChanges = watchDirectory.mock.calls[0]?.[1];
    if (!onChanges) {
      throw new Error('expected the change callback');
    }
    onChanges([change]);
    await vi.advanceTimersByTimeAsync(GIT_INVENTORY_WATCH_BATCH_MS);

    expect(onInvalidate).not.toHaveBeenCalled();
    unsubscribe.resolve();
    await dropping;
  });

  it('retries a terminal dispose whose unsubscribe failed in the next terminal dispose', async () => {
    const native = flakyNativeDispose(1);
    const watchers = createGitInventoryWatchers(
      makeDeps({ watchDirectory: () => Promise.resolve(native.dispose) })
    );
    await watchers.sync(['/repo/.git']);

    await expect(watchers.disposeAll()).rejects.toMatchObject({ errors: [failure] });
    await watchers.disposeAll();
    await watchers.disposeAll();

    expect(native.dispose).toHaveBeenCalledTimes(2);
    expect(native.released()).toBe(1);
  });

  it('rejects the terminal dispose with a retirement that fails on every attempt, and keeps owning it', async () => {
    const native = flakyNativeDispose(Number.POSITIVE_INFINITY);
    const watchers = createGitInventoryWatchers(
      makeDeps({ watchDirectory: () => Promise.resolve(native.dispose) })
    );
    await watchers.sync(['/repo/.git']);
    await expect(watchers.sync([])).rejects.toThrow();

    // One retry per terminal dispose, never a loop.
    await expect(watchers.disposeAll()).rejects.toMatchObject({ errors: [failure] });
    expect(native.dispose).toHaveBeenCalledTimes(2);

    await expect(watchers.disposeAll()).rejects.toMatchObject({ errors: [failure] });
    expect(native.dispose).toHaveBeenCalledTimes(3);
    expect(native.released()).toBe(0);
  });
});
