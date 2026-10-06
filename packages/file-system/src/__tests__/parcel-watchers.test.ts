// BST-568 slice 2: startParcelWatch engine behavior with a mocked binding.
// Real temp files back the stat-based kind detection; the binding itself is
// faked so every backend outcome (events, errors, hung subscribe) is
// deterministic.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UNCONDITIONAL_EXCLUDED_PATH_IGNORE_GLOBS } from '@brainstrike/utils/background-indexing-policy';
import { DEFAULT_IGNORE_PATTERNS } from '@brainstrike/utils/path-filter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ParcelBackendName,
  type ParcelWatcherModule,
  selectParcelBackend,
} from '../adapters/parcel-backend.js';
import {
  PARCEL_SUBSCRIBE_TIMEOUT_MS,
  ParcelSubscribeTimeoutError,
  startParcelWatch,
} from '../adapters/parcel-watchers.js';
import type { DirectoryHandle, FileSystemChange } from '../types.js';

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

function withDefaultFilteredReporting(
  options: Parameters<typeof startParcelWatch>[2]
): Parameters<typeof startParcelWatch>[2] {
  return {
    ...options,
    reportDefaultFilteredChanges: true,
  };
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
  let batchMetadata: unknown[] = [];
  const collect: Parameters<typeof startParcelWatch>[1] = (changes, metadata) => {
    batches.push(changes);
    batchMetadata.push(metadata);
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bst568-engine-'));
    batches = [];
    batchMetadata = [];
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it('preserves default native ignore globs unless filtered reporting is explicitly enabled', async () => {
    const fake = createFakeBinding();
    const stop = await startParcelWatch(makeHandle(root), collect, {
      loadModule: () => Promise.resolve(fake.module),
    });
    expect(fake.lastSubscribeArgs.dir).toBe(root);
    // Platform-derived: fs-events on darwin, inotify on linux, windows on win32.
    expect(fake.lastSubscribeArgs.backend).toBe(selectParcelBackend(process.platform));
    expect(fake.lastSubscribeArgs.ignore).toEqual([
      ...DEFAULT_IGNORE_PATTERNS.flatMap((segment) => [`**/${segment}`, `**/${segment}/**`]),
      ...UNCONDITIONAL_EXCLUDED_PATH_IGNORE_GLOBS,
    ]);
    stop();
  });

  it('broadens only bounded output defaults while retaining high-cardinality native ignores', async () => {
    const fake = createFakeBinding();
    const stop = await startParcelWatch(
      makeHandle(root),
      collect,
      withDefaultFilteredReporting({
        loadModule: () => Promise.resolve(fake.module),
      })
    );
    expect(fake.lastSubscribeArgs.ignore).toEqual([
      '**/.git',
      '**/.git/**',
      '**/node_modules',
      '**/node_modules/**',
      '**/.pnpm-store',
      '**/.pnpm-store/**',
      '**/.next',
      '**/.next/**',
      '**/.turbo',
      '**/.turbo/**',
      ...UNCONDITIONAL_EXCLUDED_PATH_IGNORE_GLOBS,
    ]);
    stop();
  });

  it('does not report a default-filtered path without the explicit opt-in', async () => {
    const fake = createFakeBinding();
    const stop = await startParcelWatch(makeHandle(root), collect, {
      loadModule: () => Promise.resolve(fake.module),
    });

    const ignoredDirectory = join(root, 'node_modules');
    await mkdir(ignoredDirectory);
    const ignoredFile = join(ignoredDirectory, 'tracked.js');
    await writeFile(ignoredFile, 'changed');
    fake.emit([{ path: ignoredFile, type: 'update' }]);

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(batches).toEqual([]);
    expect(batchMetadata).toEqual([]);
    stop();
  });

  it.each(['node_modules', '.pnpm-store', '.next', '.turbo'])(
    'keeps high-cardinality %s activity silent after the explicit opt-in',
    async (directoryName) => {
      const fake = createFakeBinding();
      const stop = await startParcelWatch(
        makeHandle(root),
        collect,
        withDefaultFilteredReporting({
          loadModule: () => Promise.resolve(fake.module),
        })
      );

      const ignoredDirectory = join(root, directoryName);
      await mkdir(ignoredDirectory);
      const ignoredFile = join(ignoredDirectory, 'tracked.js');
      await writeFile(ignoredFile, 'changed');
      // The fake binding deliberately bypasses Parcel's native ignore so this
      // also proves the JS guard cannot accidentally disclose a marker.
      fake.emit([{ path: ignoredFile, type: 'update' }]);

      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(batches).toEqual([]);
      expect(batchMetadata).toEqual([]);
      stop();
    }
  );

  it('keeps a high-cardinality subtree silent even beneath a reportable boundary', async () => {
    const fake = createFakeBinding();
    const stop = await startParcelWatch(
      makeHandle(root),
      collect,
      withDefaultFilteredReporting({
        loadModule: () => Promise.resolve(fake.module),
      })
    );

    const ignoredDirectory = join(root, 'dist', 'node_modules');
    await mkdir(ignoredDirectory, { recursive: true });
    const ignoredFile = join(ignoredDirectory, 'tracked.js');
    await writeFile(ignoredFile, 'changed');
    fake.emit([{ path: ignoredFile, type: 'update' }]);

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(batches).toEqual([]);
    expect(batchMetadata).toEqual([]);
    stop();
  });

  it.each(['dist', 'build'])(
    'reports a root-relative %s boundary only after the explicit opt-in',
    async (directoryName) => {
      const fake = createFakeBinding();
      const stop = await startParcelWatch(
        makeHandle(root),
        collect,
        withDefaultFilteredReporting({
          loadModule: () => Promise.resolve(fake.module),
        })
      );

      const ignoredDirectory = join(root, 'packages', 'app', directoryName);
      await mkdir(ignoredDirectory, { recursive: true });
      const ignoredFile = join(ignoredDirectory, 'tracked.js');
      await writeFile(ignoredFile, 'changed');
      fake.emit([{ path: ignoredFile, type: 'update' }]);

      await waitForBatch(batches);
      expect(batches).toEqual([[]]);
      expect(batchMetadata).toEqual([
        { filteredChangeBoundaries: [`packages/app/${directoryName}`] },
      ]);
      stop();
    }
  );

  it('reports a root-relative .DS_Store boundary after the explicit opt-in', async () => {
    const fake = createFakeBinding();
    const stop = await startParcelWatch(
      makeHandle(root),
      collect,
      withDefaultFilteredReporting({
        loadModule: () => Promise.resolve(fake.module),
      })
    );

    const ignoredDirectory = join(root, 'packages', 'app');
    await mkdir(ignoredDirectory, { recursive: true });
    const ignoredFile = join(ignoredDirectory, '.DS_Store');
    await writeFile(ignoredFile, 'changed');
    fake.emit([{ path: ignoredFile, type: 'update' }]);

    await waitForBatch(batches);
    expect(batches).toEqual([[]]);
    expect(batchMetadata).toEqual([{ filteredChangeBoundaries: ['packages/app/.DS_Store'] }]);
    stop();
  });

  it.each(['build', 'dist', 'node_modules'])(
    'does not filter every event when the watched root has an ancestor named %s',
    async (ancestorName) => {
      const watchedRoot = join(root, ancestorName, 'workspace');
      await mkdir(watchedRoot, { recursive: true });
      const fake = createFakeBinding();
      const stop = await startParcelWatch(
        makeHandle(watchedRoot),
        collect,
        withDefaultFilteredReporting({
          loadModule: () => Promise.resolve(fake.module),
        })
      );

      const visibleFile = join(watchedRoot, 'src.ts');
      await writeFile(visibleFile, 'changed');
      fake.emit([{ path: visibleFile, type: 'update' }]);

      await waitForBatch(batches);
      expect(batches).toEqual([[{ kind: 'file', path: visibleFile, type: 'modified' }]]);
      expect(batchMetadata).toEqual([undefined]);
      stop();
    }
  );

  it('matches only a nested default boundary for a root under mixed default-filter ancestors', async () => {
    const watchedRoot = join(root, 'build', 'node_modules', 'workspace');
    const nestedBoundary = join(watchedRoot, 'src', 'dist');
    await mkdir(nestedBoundary, { recursive: true });
    const fake = createFakeBinding();
    const stop = await startParcelWatch(
      makeHandle(watchedRoot),
      collect,
      withDefaultFilteredReporting({
        loadModule: () => Promise.resolve(fake.module),
      })
    );

    const filteredFile = join(nestedBoundary, 'asset.js');
    await writeFile(filteredFile, 'changed');
    fake.emit([{ path: filteredFile, type: 'update' }]);

    await waitForBatch(batches);
    expect(batches).toEqual([[]]);
    expect(batchMetadata).toEqual([{ filteredChangeBoundaries: ['src/dist'] }]);
    stop();
  });

  it('coalesces mixed visible and default-filtered activity after the opt-in (BST-1180)', async () => {
    const fake = createFakeBinding();
    const stop = await startParcelWatch(
      makeHandle(root),
      collect,
      withDefaultFilteredReporting({
        loadModule: () => Promise.resolve(fake.module),
      })
    );

    const ignoredDirectory = join(root, 'dist');
    await mkdir(ignoredDirectory);
    const ignoredFile = join(ignoredDirectory, 'tracked.js');
    const visibleFile = join(root, 'source.ts');
    await Promise.all([writeFile(ignoredFile, 'changed'), writeFile(visibleFile, 'changed')]);
    fake.emit([
      { path: ignoredFile, type: 'update' },
      { path: visibleFile, type: 'update' },
    ]);

    await waitForBatch(batches);
    expect(batches).toEqual([[{ kind: 'file', path: visibleFile, type: 'modified' }]]);
    expect(batchMetadata).toEqual([{ filteredChangeBoundaries: ['dist'] }]);
    stop();
  });

  it('rejects filtered reporting combined with any explicit ignore override', async () => {
    const fake = createFakeBinding();

    await expect(
      startParcelWatch(
        makeHandle(root),
        collect,
        withDefaultFilteredReporting({
          ignorePatterns: [],
          loadModule: () => Promise.resolve(fake.module),
        })
      )
    ).rejects.toThrow(
      /reportDefaultFilteredChanges.*ignorePatterns|ignorePatterns.*reportDefaultFilteredChanges/u
    );
    expect(fake.lastSubscribeArgs.dir).toBeUndefined();
  });

  it('drops managed-worktree events at the default guard while delivering siblings (BST-1342/BST-1390)', async () => {
    // The 2026-08-17 run-5189 failure: worktree churn flooded FSEvents, each
    // overflow invalidated the root, and the rescan storm saturated the DB
    // host. Worktree copies are already excluded from indexing by
    // UNCONDITIONAL_EXCLUDED_DIRECTORY_PATH_PREFIXES; the DEFAULT watcher
    // guard must drop their events with the same policy. (Per-subscription
    // overrides still replace this entirely — the git-inventory watcher's
    // `ignorePatterns: []` keeps seeing worktree git metadata.)
    const fake = createFakeBinding();
    const stop = await startParcelWatch(makeHandle(root), collect, {
      loadModule: () => Promise.resolve(fake.module),
    });

    const worktreeSrc = join(root, '.claude', 'worktrees', 'agent-1', 'src');
    await mkdir(worktreeSrc, { recursive: true });
    const worktreeFile = join(worktreeSrc, 'copy.ts');
    await writeFile(worktreeFile, 'x');
    const brainstrikeWorktreeSrc = join(root, '.brainstrike', 'worktrees', 'managed-1', 'src');
    await mkdir(brainstrikeWorktreeSrc, { recursive: true });
    const brainstrikeWorktreeFile = join(brainstrikeWorktreeSrc, 'copy.ts');
    await writeFile(brainstrikeWorktreeFile, 'x');
    const siblingFile = join(root, 'kept.ts');
    await writeFile(siblingFile, 'y');

    fake.emit([
      { path: worktreeFile, type: 'create' },
      { path: brainstrikeWorktreeFile, type: 'create' },
      { path: siblingFile, type: 'create' },
    ]);
    await waitForBatch(batches);
    expect(batches[0]).toEqual([{ kind: 'file', path: siblingFile, type: 'added' }]);
    stop();
  });

  it.each(['.claude', '.muse'])(
    'watches normally when the subscription root is itself inside %s/worktrees (BST-1342 review)',
    async (directory) => {
      // Explorer visibility of worktrees is pinned product behavior, and a
      // user can open a worktree copy AS the workspace root. The exclusion is
      // root-RELATIVE (like the index-side policy): a root inside an excluded
      // tree must not have every event silently dropped — that would be the
      // exact silent-total-failure class git-inventory-watcher.ts documents
      // for a subscription rooted at .git.
      const worktreeRoot = join(root, directory, 'worktrees', 'agent-1');
      await mkdir(worktreeRoot, { recursive: true });
      const fake = createFakeBinding();
      const stop = await startParcelWatch(makeHandle(worktreeRoot), collect, {
        loadModule: () => Promise.resolve(fake.module),
      });

      // The native layer must not swallow the whole subscription either:
      // Parcel matches ignore globs against absolute paths, so only the hard
      // worktrees globs are omitted for a root already inside that tree. The
      // default-false watcher still preserves its ordinary native filters.
      expect(fake.lastSubscribeArgs.ignore).toEqual(
        DEFAULT_IGNORE_PATTERNS.flatMap((segment) => [`**/${segment}`, `**/${segment}/**`])
      );

      const filePath = join(worktreeRoot, 'src.ts');
      await writeFile(filePath, 'x');
      fake.emit([{ path: filePath, type: 'create' }]);
      await waitForBatch(batches);
      expect(batches[0]).toEqual([{ kind: 'file', path: filePath, type: 'added' }]);
      stop();
    }
  );

  it('replaces both the native ignore globs and the shouldIgnorePath guard with custom patterns (BST-1112)', async () => {
    const fake = createFakeBinding();
    const stop = await startParcelWatch(makeHandle(root), collect, {
      ignorePatterns: ['node_modules'],
      loadModule: () => Promise.resolve(fake.module),
    });
    // Native layer only carries globs for the custom pattern, not the defaults.
    expect(fake.lastSubscribeArgs.ignore).toEqual(['**/node_modules', '**/node_modules/**']);

    // fileFilter.shouldIgnorePath guard must also use the custom patterns:
    // a .git/HEAD event, dropped by the DEFAULT patterns, passes through here
    // because the override omits '.git'.
    const gitDir = join(root, '.git');
    await mkdir(gitDir);
    const headPath = join(gitDir, 'HEAD');
    await writeFile(headPath, 'ref: refs/heads/main');
    fake.emit([{ path: headPath, type: 'update' }]);
    await waitForBatch(batches);
    expect(batches[0]).toEqual([{ kind: 'file', path: headPath, type: 'modified' }]);
    stop();
  });

  it('treats an empty ignorePatterns array as "ignore nothing", never falling back to defaults (BST-1112)', async () => {
    const fake = createFakeBinding();
    const stop = await startParcelWatch(makeHandle(root), collect, {
      ignorePatterns: [],
      loadModule: () => Promise.resolve(fake.module),
    });
    expect(fake.lastSubscribeArgs.ignore).toEqual([]);

    const nodeModulesDir = join(root, 'node_modules');
    await mkdir(nodeModulesDir);
    const filePath = join(nodeModulesDir, 'pkg.js');
    await writeFile(filePath, 'x');
    fake.emit([{ path: filePath, type: 'create' }]);
    await waitForBatch(batches);
    expect(batches[0]).toEqual([{ kind: 'file', path: filePath, type: 'added' }]);
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
    // The sentinel is root/'added' (a MEMBERSHIP change): the Explorer refresh
    // consumer skips 'modified' as content-only, so only 'added' on the root
    // path forces the full root re-enumeration a backend drop requires.
    expect(batches[0]).toEqual([{ kind: 'directory', path: root, type: 'added' }]);
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

  it('emits starting then healthy health transitions on successful subscribe', async () => {
    const fake = createFakeBinding();
    const health: import('../types.js').WatcherHealthTransition[] = [];
    const stop = await startParcelWatch(makeHandle(root), collect, {
      loadModule: () => Promise.resolve(fake.module),
      onHealth: (event) => health.push(event),
    });
    expect(health.map((event) => event.state)).toEqual(['starting', 'healthy']);
    expect(health[0]?.backend).toBe(selectParcelBackend(process.platform));
    expect(health[1]?.failure).toBeUndefined();
    stop();
  });

  it('recovers degraded back to healthy on the next clean batch, per episode', async () => {
    const fake = createFakeBinding();
    const health: import('../types.js').WatcherHealthTransition[] = [];
    const stop = await startParcelWatch(makeHandle(root), collect, {
      loadModule: () => Promise.resolve(fake.module),
      onHealth: (event) => health.push(event),
    });
    const filePath = join(root, 'ok.txt');
    await writeFile(filePath, 'x');

    fake.emitError(new Error('events dropped'));
    fake.emit([{ path: filePath, type: 'update' }]);
    fake.emitError(new Error('events dropped again'));

    expect(health.map((event) => event.state)).toEqual([
      'starting',
      'healthy',
      'degraded',
      'healthy',
      'degraded',
    ]);
    stop();
  });

  it('emits degraded exactly once across repeated backend errors', async () => {
    const fake = createFakeBinding();
    const health: import('../types.js').WatcherHealthTransition[] = [];
    const stop = await startParcelWatch(makeHandle(root), collect, {
      loadModule: () => Promise.resolve(fake.module),
      onHealth: (event) => health.push(event),
    });
    fake.emitError(new Error('events dropped'));
    fake.emitError(new Error('events dropped again'));
    const degraded = health.filter((event) => event.state === 'degraded');
    expect(degraded).toHaveLength(1);
    expect(degraded[0]?.failure).toMatchObject({
      code: 'backend-error',
      retryable: true,
      terminal: false,
    });
    stop();
  });

  it('emits failed with a structured failure when subscribe times out', async () => {
    const module = {
      subscribe: () => new Promise(() => undefined),
    } as unknown as ParcelWatcherModule;
    const health: import('../types.js').WatcherHealthTransition[] = [];
    await expect(
      startParcelWatch(makeHandle(root), collect, {
        loadModule: () => Promise.resolve(module),
        onHealth: (event) => health.push(event),
        subscribeTimeoutMs: 30,
      })
    ).rejects.toBeInstanceOf(ParcelSubscribeTimeoutError);
    expect(health.map((event) => event.state)).toEqual(['starting', 'failed']);
    expect(health[1]?.failure).toMatchObject({
      code: 'subscribe-timeout',
      retryable: true,
      terminal: false,
    });
  });

  it('emits stopped exactly once on dispose', async () => {
    const fake = createFakeBinding();
    const health: import('../types.js').WatcherHealthTransition[] = [];
    const stop = await startParcelWatch(makeHandle(root), collect, {
      loadModule: () => Promise.resolve(fake.module),
      onHealth: (event) => health.push(event),
    });
    stop();
    stop();
    expect(health.filter((event) => event.state === 'stopped')).toHaveLength(1);
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
