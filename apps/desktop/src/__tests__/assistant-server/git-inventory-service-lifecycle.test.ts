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
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FileSystemChange, FileSystemWatchSignal } from '@brainstrike/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  InventoryDirent,
  InventoryFs,
  InventoryStat,
} from '../../assistant-server/git-inventory-discovery';
import {
  createGitInventoryService,
  GIT_INVENTORY_SNAPSHOT_TTL_MS,
  type GitInventoryService,
  type GitInventoryServiceDeps,
} from '../../assistant-server/git-inventory-service';
import {
  GIT_INVENTORY_WATCH_BATCH_MS,
  type WatchGitCommonDir,
} from '../../assistant-server/git-inventory-watcher';
import type { GitCommandRun, GitCommandRunner } from '../../assistant-server/git-service';

const createdRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), prefix));
  const real = await fsPromises.realpath(root);
  createdRoots.push(real);
  return real;
}

afterEach(async () => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root) {
      await fsPromises.rm(root, { force: true, recursive: true });
    }
  }
});

/** Minimal in-memory `InventoryFs`, scoped to a single directory-`.git` repo
 * with no linked worktrees — a narrower copy of the fixture in
 * `git-inventory-service.test.ts`. */
class FakeFs implements InventoryFs {
  private readonly nodes = new Map<string, { readonly children: readonly string[] }>();
  private readonly realpaths = new Map<string, string>();

  addDir(dirPath: string, children: readonly string[]): void {
    this.nodes.set(dirPath, { children });
  }

  setRealpath(fromPath: string, toPath: string): void {
    this.realpaths.set(fromPath, toPath);
  }

  lstat(targetPath: string): Promise<InventoryStat> {
    if (!this.nodes.has(targetPath)) {
      return Promise.reject(enoent(targetPath));
    }
    return Promise.resolve({ isDirectory: () => true, isFile: () => false });
  }

  readdir(dirPath: string): Promise<readonly InventoryDirent[]> {
    const node = this.nodes.get(dirPath);
    if (!node) {
      return Promise.reject(enoent(dirPath));
    }
    return Promise.resolve(
      node.children.map((name) => ({
        isDirectory: () => true,
        isFile: () => false,
        name,
      }))
    );
  }

  readFile(filePath: string): Promise<string> {
    return Promise.reject(enoent(filePath));
  }

  realpath(targetPath: string): Promise<string> {
    const resolved = this.realpaths.get(targetPath) ?? targetPath;
    if (!(this.nodes.has(resolved) || this.realpaths.has(targetPath))) {
      return Promise.reject(enoent(targetPath));
    }
    return Promise.resolve(resolved);
  }
}

function enoent(targetPath: string): NodeJS.ErrnoException {
  const error = new Error(
    `ENOENT: no such file or directory '${targetPath}'`
  ) as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return error;
}

const FAKE_HEAD = 'a'.repeat(40);

/** One real (canonical, mkdtemp'd) root directory with a REAL `.git` child
 * directory — real because `createGitInventoryWatchers`' default `realpath`
 * (unfaked here, matching production wiring) resolves the common dir with
 * `node:fs/promises`, not the injected `InventoryFs`. */
async function makeSingleRepoRoot(prefix: string): Promise<{
  readonly commonDir: string;
  readonly fs: InventoryFs;
  readonly rootDir: string;
  readonly rootId: string;
}> {
  const rootDir = await makeTempDir(prefix);
  const commonDir = path.join(rootDir, '.git');
  await fsPromises.mkdir(commonDir);

  const fs = new FakeFs();
  fs.addDir(rootDir, ['.git']);
  fs.addDir(commonDir, []);
  fs.setRealpath(commonDir, commonDir);

  return { commonDir, fs, rootDir, rootId: 'root-1' };
}

function makeWorktreeListRunner(rootDir: string): GitCommandRunner {
  const run: GitCommandRunner = ({ args, cwd }): Promise<GitCommandRun> => {
    if (args[0] === 'config') {
      return Promise.resolve({ exitCode: 1, stderr: '', stdout: '', timedOut: false });
    }
    return Promise.resolve({
      exitCode: 0,
      stderr: '',
      stdout: `worktree ${cwd}\0HEAD ${FAKE_HEAD}\0branch refs/heads/main\0\0`,
      timedOut: false,
    });
  };
  void rootDir;
  return run;
}

interface FakeWatchSubscription {
  disposeCallCount: number;
  readonly fireErrorSignal: (message: string) => void;
  readonly fireInterestingChange: () => void;
}

interface FakeWatchDirectory {
  readonly subscriptionsByCommonDir: Map<string, FakeWatchSubscription>;
  readonly watchDirectory: WatchGitCommonDir;
  readonly watchDirectorySpy: ReturnType<typeof vi.fn>;
}

function createFakeWatchDirectory(): FakeWatchDirectory {
  const subscriptionsByCommonDir = new Map<string, FakeWatchSubscription>();
  const watchDirectorySpy = vi.fn(
    (
      commonDir: string,
      callback: (changes: FileSystemChange[]) => void,
      onSignal?: (signal: FileSystemWatchSignal) => void
    ) => {
      const sub: FakeWatchSubscription = {
        disposeCallCount: 0,
        fireErrorSignal: (message) => onSignal?.({ message, type: 'errored' }),
        fireInterestingChange: () =>
          callback([{ kind: 'file', path: path.join(commonDir, 'HEAD'), type: 'modified' }]),
      };
      subscriptionsByCommonDir.set(commonDir, sub);
      return Promise.resolve(() => {
        sub.disposeCallCount += 1;
      });
    }
  );
  return {
    subscriptionsByCommonDir,
    watchDirectory: watchDirectorySpy as unknown as WatchGitCommonDir,
    watchDirectorySpy,
  };
}

function makeService(
  overrides: Partial<GitInventoryServiceDeps> & {
    readonly loadRootsSpy?: ReturnType<typeof vi.fn>;
    readonly watchDirectory: WatchGitCommonDir;
  }
): GitInventoryService {
  const { loadRootsSpy, watchDirectory, ...deps } = overrides;
  return createGitInventoryService({
    loadRoots: loadRootsSpy ?? (() => Promise.resolve([])),
    run: (() =>
      Promise.reject(
        new Error('run() should not be called without a fixture')
      )) as GitCommandRunner,
    watchDirectory,
    ...deps,
  });
}

describe('createGitInventoryService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
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
        run: makeWorktreeListRunner(rootDir),
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

      expect(loadRootsSpy).toHaveBeenCalledTimes(1);
      expect(a).toBe(b);
    });
  });

  describe('stop()', () => {
    it('disposes every live watcher and drops the cache, so a later getSnapshot() rebuilds rather than serving stale data', async () => {
      const { commonDir, fs, rootDir, rootId } = await makeSingleRepoRoot(
        'brainstrike-git-inv-svc-stop-'
      );
      const loadRootsSpy = vi.fn(() => Promise.resolve([{ id: rootId, path: rootDir }]));
      const fake = createFakeWatchDirectory();
      const service = makeService({
        fs,
        loadRootsSpy,
        run: makeWorktreeListRunner(rootDir),
        watchDirectory: fake.watchDirectory,
      });

      service.start();
      const before = await service.getSnapshot();
      expect(loadRootsSpy).toHaveBeenCalledTimes(1);
      const sub = fake.subscriptionsByCommonDir.get(commonDir);
      expect(sub?.disposeCallCount).toBe(0);

      await service.stop();
      expect(sub?.disposeCallCount).toBe(1);

      const after = await service.getSnapshot();
      expect(loadRootsSpy).toHaveBeenCalledTimes(2);
      expect(after).not.toBe(before);
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
        run: makeWorktreeListRunner(rootDir),
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
        run: makeWorktreeListRunner(rootDir),
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
        run: makeWorktreeListRunner(rootDir),
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
});
