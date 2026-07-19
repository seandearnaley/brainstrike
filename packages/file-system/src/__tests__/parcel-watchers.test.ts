// BST-568 slice 2: startParcelWatch engine behavior with a mocked binding.
// Real temp files back the stat-based kind detection; the binding itself is
// faked so every backend outcome (events, errors, hung subscribe) is
// deterministic.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParcelBackendName, ParcelWatcherModule } from '../adapters/parcel-backend';
import {
  PARCEL_SUBSCRIBE_TIMEOUT_MS,
  ParcelSubscribeTimeoutError,
  startParcelWatch,
} from '../adapters/parcel-watchers';
import type { DirectoryHandle, FileSystemChange } from '../types';

type SubscribeCallback = (
  error: Error | null,
  events: Array<{ path: string; type: 'create' | 'delete' | 'update' }>
) => unknown;

interface FakeBinding {
  emit: (events: Array<{ path: string; type: 'create' | 'delete' | 'update' }>) => void;
  emitError: (error: Error) => void;
  lastSubscribeArgs: {
    backend?: string | undefined;
    dir?: string | undefined;
    ignore?: string[] | undefined;
  };
  module: ParcelWatcherModule;
  unsubscribeCalls: number;
}

function createFakeBinding(behavior: 'hang' | 'resolve' = 'resolve'): FakeBinding {
  const state: FakeBinding = {
    emit: () => undefined,
    emitError: () => undefined,
    lastSubscribeArgs: {},
    module: undefined as unknown as ParcelWatcherModule,
    unsubscribeCalls: 0,
  };

  const subscribe = (
    dir: string,
    callback: SubscribeCallback,
    options?: { backend?: ParcelBackendName; ignore?: string[] }
  ) => {
    state.lastSubscribeArgs = {
      backend: options?.backend,
      dir,
      ignore: options?.ignore,
    };
    state.emit = (events) => {
      callback(null, events);
    };
    state.emitError = (error) => {
      callback(error, []);
    };
    const subscription = {
      unsubscribe: () => {
        state.unsubscribeCalls += 1;
        return Promise.resolve();
      },
    };
    if (behavior === 'hang') {
      return new Promise<typeof subscription>(() => undefined);
    }
    return Promise.resolve(subscription);
  };

  state.module = { subscribe } as unknown as ParcelWatcherModule;
  return state;
}

function makeHandle(path: string): DirectoryHandle {
  return { kind: 'directory', name: 'root', path } as DirectoryHandle;
}

async function waitForBatch(batches: FileSystemChange[][], minBatches = 1): Promise<void> {
  await vi.waitFor(
    () => {
      expect(batches.length).toBeGreaterThanOrEqual(minBatches);
    },
    { interval: 20, timeout: 2000 }
  );
}

describe('startParcelWatch', () => {
  let root = '';
  let batches: FileSystemChange[][] = [];
  const collect = (changes: FileSystemChange[]) => {
    batches.push(changes);
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bst568-engine-'));
    batches = [];
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it('subscribes with the explicit host backend and shared ignore globs', async () => {
    const fake = createFakeBinding();
    const stop = await startParcelWatch(makeHandle(root), collect, {
      loadModule: () => Promise.resolve(fake.module),
    });
    expect(fake.lastSubscribeArgs.dir).toBe(root);
    expect(fake.lastSubscribeArgs.backend).toBe('fs-events');
    expect(fake.lastSubscribeArgs.ignore).toContain('**/node_modules/**');
    expect(fake.lastSubscribeArgs.ignore).toContain('**/.git/**');
    stop();
  });

  it('normalizes create of a real file to added/file', async () => {
    const fake = createFakeBinding();
    const stop = await startParcelWatch(makeHandle(root), collect, {
      loadModule: () => Promise.resolve(fake.module),
    });
    const filePath = join(root, 'a.txt');
    await writeFile(filePath, 'x');
    fake.emit([{ path: filePath, type: 'create' }]);
    await waitForBatch(batches);
    expect(batches[0]).toEqual([{ kind: 'file', path: filePath, type: 'added' }]);
    stop();
  });

  it('normalizes create of a real directory to added/directory', async () => {
    const fake = createFakeBinding();
    const stop = await startParcelWatch(makeHandle(root), collect, {
      loadModule: () => Promise.resolve(fake.module),
    });
    const dirPath = join(root, 'sub');
    await mkdir(dirPath);
    fake.emit([{ path: dirPath, type: 'create' }]);
    await waitForBatch(batches);
    expect(batches[0]).toEqual([{ kind: 'directory', path: dirPath, type: 'added' }]);
    stop();
  });

  it('degrades a create whose path vanished to the safe directory-removed shape', async () => {
    const fake = createFakeBinding();
    const stop = await startParcelWatch(makeHandle(root), collect, {
      loadModule: () => Promise.resolve(fake.module),
    });
    const ghost = join(root, 'ghost.txt');
    fake.emit([{ path: ghost, type: 'create' }]);
    await waitForBatch(batches);
    expect(batches[0]).toEqual([{ kind: 'directory', path: ghost, type: 'removed' }]);
    stop();
  });

  it('normalizes update of a real file to modified/file', async () => {
    const fake = createFakeBinding();
    const stop = await startParcelWatch(makeHandle(root), collect, {
      loadModule: () => Promise.resolve(fake.module),
    });
    const filePath = join(root, 'b.txt');
    await writeFile(filePath, 'x');
    fake.emit([{ path: filePath, type: 'update' }]);
    await waitForBatch(batches);
    expect(batches[0]).toEqual([{ kind: 'file', path: filePath, type: 'modified' }]);
    stop();
  });

  it('drops an update whose path vanished (delete event follows separately)', async () => {
    const fake = createFakeBinding();
    const stop = await startParcelWatch(makeHandle(root), collect, {
      loadModule: () => Promise.resolve(fake.module),
    });
    const ghost = join(root, 'ghost.txt');
    const real = join(root, 'real.txt');
    await writeFile(real, 'x');
    fake.emit([
      { path: ghost, type: 'update' },
      { path: real, type: 'update' },
    ]);
    await waitForBatch(batches);
    expect(batches.flat()).toEqual([{ kind: 'file', path: real, type: 'modified' }]);
    stop();
  });

  it('normalizes delete to the safe directory-removed shape without stat', async () => {
    const fake = createFakeBinding();
    const stop = await startParcelWatch(makeHandle(root), collect, {
      loadModule: () => Promise.resolve(fake.module),
    });
    const gone = join(root, 'gone');
    fake.emit([{ path: gone, type: 'delete' }]);
    await waitForBatch(batches);
    expect(batches[0]).toEqual([{ kind: 'directory', path: gone, type: 'removed' }]);
    stop();
  });

  it('filters events under ignored segments', async () => {
    const fake = createFakeBinding();
    const stop = await startParcelWatch(makeHandle(root), collect, {
      loadModule: () => Promise.resolve(fake.module),
    });
    const ignored = join(root, 'node_modules', 'pkg', 'index.js');
    const real = join(root, 'kept.txt');
    await writeFile(real, 'x');
    fake.emit([
      { path: ignored, type: 'create' },
      { path: real, type: 'create' },
    ]);
    await waitForBatch(batches);
    expect(batches.flat()).toEqual([{ kind: 'file', path: real, type: 'added' }]);
    stop();
  });

  it('maps a backend error to a root invalidation and keeps the subscription', async () => {
    const fake = createFakeBinding();
    const stop = await startParcelWatch(makeHandle(root), collect, {
      loadModule: () => Promise.resolve(fake.module),
    });
    fake.emitError(new Error('Events were dropped by the FSEvents client. Rescan needed.'));
    await waitForBatch(batches);
    expect(batches[0]).toEqual([{ kind: 'directory', path: root, type: 'modified' }]);
    // Subscription survives: a later real event still flows.
    const filePath = join(root, 'after-error.txt');
    await writeFile(filePath, 'x');
    fake.emit([{ path: filePath, type: 'create' }]);
    await waitForBatch(batches, 2);
    expect(batches[1]).toEqual([{ kind: 'file', path: filePath, type: 'added' }]);
    expect(fake.unsubscribeCalls).toBe(0);
    stop();
  });

  it('rejects with a typed timeout error when subscribe hangs, then cleans up late resolution', async () => {
    expect(PARCEL_SUBSCRIBE_TIMEOUT_MS).toBe(10_000);
    const late: { resolve: (() => void) | null } = { resolve: null };
    const unsubscribed = vi.fn(() => Promise.resolve());
    const module = {
      subscribe: () =>
        new Promise((resolve) => {
          late.resolve = () => {
            resolve({ unsubscribe: unsubscribed });
          };
        }),
    } as unknown as ParcelWatcherModule;

    await expect(
      startParcelWatch(makeHandle(root), collect, {
        loadModule: () => Promise.resolve(module),
        subscribeTimeoutMs: 30,
      })
    ).rejects.toBeInstanceOf(ParcelSubscribeTimeoutError);

    // The hung promise resolving later must be unsubscribed, not leaked.
    expect(late.resolve).not.toBeNull();
    late.resolve?.();
    await vi.waitFor(() => {
      expect(unsubscribed).toHaveBeenCalledTimes(1);
    });
  });

  it('returns an idempotent disposer that unsubscribes exactly once', async () => {
    const fake = createFakeBinding();
    const stop = await startParcelWatch(makeHandle(root), collect, {
      loadModule: () => Promise.resolve(fake.module),
    });
    stop();
    stop();
    await vi.waitFor(() => {
      expect(fake.unsubscribeCalls).toBe(1);
    });
  });

  it('re-roots realpath-based event paths onto the handle path', async () => {
    // FSEvents (and other backends) report kernel realpaths; consumers match
    // change paths against the handle-rooted prefix, so the engine must
    // translate. macOS tmpdir is itself a symlink (/var -> /private/var),
    // giving us a natural fixture.
    const { realpath, symlink } = await import('node:fs/promises');
    const realRoot = await realpath(root);
    const linkRoot = `${root}-link`;
    await symlink(realRoot, linkRoot);
    try {
      const fake = createFakeBinding();
      const stop = await startParcelWatch(makeHandle(linkRoot), collect, {
        loadModule: () => Promise.resolve(fake.module),
      });
      const filePath = join(realRoot, 'c.txt');
      await writeFile(filePath, 'x');
      fake.emit([{ path: filePath, type: 'create' }]);
      await waitForBatch(batches);
      expect(batches[0]).toEqual([{ kind: 'file', path: join(linkRoot, 'c.txt'), type: 'added' }]);
      stop();
    } finally {
      await rm(linkRoot, { force: true });
    }
  });

  it('drops events that arrive after dispose', async () => {
    const fake = createFakeBinding();
    const stop = await startParcelWatch(makeHandle(root), collect, {
      loadModule: () => Promise.resolve(fake.module),
    });
    const filePath = join(root, 'late.txt');
    await writeFile(filePath, 'x');
    stop();
    fake.emit([{ path: filePath, type: 'create' }]);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(batches).toEqual([]);
  });
});
