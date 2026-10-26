// @vitest-environment node
// Root watch engine behavior. Most cases drive the engine through its `watch`
// seam (a fake recursive watcher) so every OS outcome — events, dropped
// events, a watch that ends with an error, a refused start — is deterministic;
// real temp files back the stat-based kind detection. The last block runs the
// real Node `fs.watch` on this host.
import type { Stats } from 'node:fs';
import fs from 'node:fs';
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type RootWatchFunction,
  startJoinedRootWatch,
  startRootWatch,
} from '../adapters/root-watchers.js';
import type {
  DirectoryHandle,
  FileSystemChange,
  FileSystemWatchBatchMetadata,
  WatcherHealthTransition,
} from '../types.js';

interface FakeWatch {
  closeCalls: number;
  directory: string | undefined;
  emit: (eventType: fs.WatchEventType, filename: string | null) => void;
  emitError: (error: Error) => void;
  ignore: (relativePath: string) => boolean;
  watch: RootWatchFunction;
}

function createFakeWatch(): FakeWatch {
  const state: FakeWatch = {
    closeCalls: 0,
    directory: undefined,
    emit: () => {
      throw new Error('The fake watch has not started.');
    },
    emitError: () => {
      throw new Error('The fake watch has not started.');
    },
    ignore: () => {
      throw new Error('The fake watch has not started.');
    },
    watch: (directory, options, listener) => {
      state.directory = directory;
      state.ignore = options.ignore;
      state.emit = listener;
      let onError: (error: Error) => void = () => undefined;
      state.emitError = (error) => onError(error);
      return {
        close: () => {
          state.closeCalls += 1;
        },
        on: (_event, listener) => {
          onError = listener;
        },
      };
    },
  };
  return state;
}

function makeHandle(path: string): DirectoryHandle {
  return { kind: 'directory', name: 'root', path, platform: 'electron' };
}

const EXPECTED_BACKEND = { darwin: 'fs-events', linux: 'inotify', win32: 'windows' } as const;

describe('root watch engine', () => {
  let root = '';
  let batches: FileSystemChange[][] = [];
  let batchMetadata: (FileSystemWatchBatchMetadata | undefined)[] = [];
  let nextBatch: (() => void) | undefined;
  const collect = (changes: FileSystemChange[], metadata?: FileSystemWatchBatchMetadata): void => {
    batches.push(changes);
    batchMetadata.push(metadata);
    nextBatch?.();
  };
  /** Resolves once `count` batches have been delivered. */
  const batchCount = (count: number): Promise<void> =>
    new Promise((resolve) => {
      const check = (): void => {
        if (batches.length >= count) {
          nextBatch = undefined;
          resolve();
        }
      };
      nextBatch = check;
      check();
    });

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'root-watch-engine-')));
    batches = [];
    batchMetadata = [];
    nextBatch = undefined;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { force: true, recursive: true });
  });

  describe('watch-level ignore', () => {
    it('ignores every default tree, worktree copies at any depth, and nothing visible', async () => {
      const fake = createFakeWatch();
      const stop = await startRootWatch(makeHandle(root), collect, { watch: fake.watch });
      expect(fake.directory).toBe(root);
      for (const ignored of [
        '.git',
        'node_modules',
        join('packages', 'app', 'node_modules'),
        '.pnpm-store',
        '.next',
        '.turbo',
        'dist',
        join('packages', 'app', 'build'),
        '.DS_Store',
        join('.claude', 'worktrees'),
        join('.claude', 'worktrees', 'agent-1', 'src', 'copy.ts'),
        join('nested', '.claude', 'worktrees', 'agent-1'),
      ]) {
        expect(fake.ignore(ignored), ignored).toBe(true);
      }
      for (const visible of ['src', join('src', 'index.ts'), '.claude', 'README.md']) {
        expect(fake.ignore(visible), visible).toBe(false);
      }
      stop();
    });

    it('keeps reportable output trees watched only after the explicit opt-in', async () => {
      const fake = createFakeWatch();
      const stop = await startRootWatch(makeHandle(root), collect, {
        reportDefaultFilteredChanges: true,
        watch: fake.watch,
      });
      expect(fake.ignore('dist')).toBe(false);
      expect(fake.ignore(join('packages', 'app', 'build', 'out.js'))).toBe(false);
      expect(fake.ignore('.DS_Store')).toBe(false);
      // High-cardinality trees stay out of the watch, even beneath a boundary.
      expect(fake.ignore('node_modules')).toBe(true);
      expect(fake.ignore(join('dist', 'node_modules'))).toBe(true);
      expect(fake.ignore('.git')).toBe(true);
      stop();
    });

    it.each(['.claude', '.muse'])(
      'watches a root that is itself inside %s/worktrees (BST-1342 review)',
      async (directory) => {
        const worktreeRoot = join(root, directory, 'worktrees', 'agent-1');
        await mkdir(worktreeRoot, { recursive: true });
        const fake = createFakeWatch();
        const stop = await startRootWatch(makeHandle(worktreeRoot), collect, {
          watch: fake.watch,
        });
        expect(fake.ignore('src.ts')).toBe(false);
        expect(fake.ignore('node_modules')).toBe(true);

        const filePath = join(worktreeRoot, 'src.ts');
        await writeFile(filePath, 'x');
        fake.emit('rename', 'src.ts');
        await batchCount(1);
        expect(batches[0]).toEqual([{ kind: 'file', path: filePath, type: 'added' }]);
        stop();
      }
    );

    it('replaces every default layer with custom patterns (BST-1112)', async () => {
      const fake = createFakeWatch();
      const stop = await startRootWatch(makeHandle(root), collect, {
        ignorePatterns: ['node_modules'],
        watch: fake.watch,
      });
      expect(fake.ignore('node_modules')).toBe(true);
      expect(fake.ignore('.git')).toBe(false);
      expect(fake.ignore(join('.claude', 'worktrees', 'agent-1', '.git'))).toBe(false);

      const headPath = join(root, '.git', 'HEAD');
      await mkdir(join(root, '.git'));
      await writeFile(headPath, 'ref: refs/heads/main');
      fake.emit('change', join('.git', 'HEAD'));
      await batchCount(1);
      expect(batches[0]).toEqual([{ kind: 'file', path: headPath, type: 'modified' }]);
      stop();
    });

    it('treats an empty ignorePatterns array as "ignore nothing" (BST-1112)', async () => {
      const fake = createFakeWatch();
      const stop = await startRootWatch(makeHandle(root), collect, {
        ignorePatterns: [],
        watch: fake.watch,
      });
      expect(fake.ignore('node_modules')).toBe(false);
      expect(fake.ignore('.git')).toBe(false);
      stop();
    });

    it('rejects filtered reporting combined with any explicit ignore override', async () => {
      const fake = createFakeWatch();
      await expect(
        startRootWatch(makeHandle(root), collect, {
          ignorePatterns: [],
          reportDefaultFilteredChanges: true,
          watch: fake.watch,
        })
      ).rejects.toThrow(
        /reportDefaultFilteredChanges.*ignorePatterns|ignorePatterns.*reportDefaultFilteredChanges/u
      );
      expect(fake.directory).toBeUndefined();
    });
  });

  describe('event guard', () => {
    it('drops a delivered default-filtered event without the opt-in', async () => {
      const fake = createFakeWatch();
      const stop = await startRootWatch(makeHandle(root), collect, { watch: fake.watch });
      const visibleFile = join(root, 'kept.ts');
      await writeFile(visibleFile, 'x');
      // The fake delivers paths its ignore predicate would have dropped, so this
      // proves the JS guard on its own.
      fake.emit('change', join('dist', 'tracked.js'));
      fake.emit('change', join('node_modules', 'pkg', 'index.js'));
      fake.emit('rename', join('.claude', 'worktrees', 'agent-1', 'src', 'copy.ts'));
      fake.emit('change', 'kept.ts');
      await batchCount(1);
      expect(batches).toEqual([[{ kind: 'file', path: visibleFile, type: 'modified' }]]);
      expect(batchMetadata).toEqual([undefined]);
      stop();
    });

    it.each(['dist', 'build'])(
      'reports a root-relative %s boundary after the explicit opt-in',
      async (directoryName) => {
        const fake = createFakeWatch();
        const stop = await startRootWatch(makeHandle(root), collect, {
          reportDefaultFilteredChanges: true,
          watch: fake.watch,
        });
        fake.emit('change', join('packages', 'app', directoryName, 'tracked.js'));
        await batchCount(1);
        expect(batches).toEqual([[]]);
        expect(batchMetadata).toEqual([
          { filteredChangeBoundaries: [`packages/app/${directoryName}`] },
        ]);
        stop();
      }
    );

    it('keeps a high-cardinality subtree silent beneath a reportable boundary', async () => {
      const fake = createFakeWatch();
      const stop = await startRootWatch(makeHandle(root), collect, {
        reportDefaultFilteredChanges: true,
        watch: fake.watch,
      });
      const visibleFile = join(root, 'kept.ts');
      await writeFile(visibleFile, 'x');
      fake.emit('change', join('dist', 'node_modules', 'tracked.js'));
      fake.emit('change', 'kept.ts');
      await batchCount(1);
      expect(batches).toEqual([[{ kind: 'file', path: visibleFile, type: 'modified' }]]);
      expect(batchMetadata).toEqual([undefined]);
      stop();
    });

    it('coalesces visible and default-filtered activity after the opt-in (BST-1180)', async () => {
      const fake = createFakeWatch();
      const stop = await startRootWatch(makeHandle(root), collect, {
        reportDefaultFilteredChanges: true,
        watch: fake.watch,
      });
      const visibleFile = join(root, 'source.ts');
      await writeFile(visibleFile, 'changed');
      fake.emit('change', join('dist', 'tracked.js'));
      fake.emit('change', 'source.ts');
      await batchCount(1);
      expect(batches).toEqual([[{ kind: 'file', path: visibleFile, type: 'modified' }]]);
      expect(batchMetadata).toEqual([{ filteredChangeBoundaries: ['dist'] }]);
      stop();
    });

    it.each(['build', 'dist', 'node_modules'])(
      'filters nothing for a root that has an ancestor named %s',
      async (ancestorName) => {
        const watchedRoot = join(root, ancestorName, 'workspace');
        await mkdir(watchedRoot, { recursive: true });
        const fake = createFakeWatch();
        const stop = await startRootWatch(makeHandle(watchedRoot), collect, {
          reportDefaultFilteredChanges: true,
          watch: fake.watch,
        });
        const visibleFile = join(watchedRoot, 'src.ts');
        await writeFile(visibleFile, 'changed');
        fake.emit('change', 'src.ts');
        await batchCount(1);
        expect(batches).toEqual([[{ kind: 'file', path: visibleFile, type: 'modified' }]]);
        stop();
      }
    );
  });

  describe('event normalization', () => {
    it('reports a rename that leaves a file as added/file', async () => {
      const fake = createFakeWatch();
      const stop = await startRootWatch(makeHandle(root), collect, { watch: fake.watch });
      const filePath = join(root, 'a.txt');
      await writeFile(filePath, 'x');
      fake.emit('rename', 'a.txt');
      await batchCount(1);
      expect(batches[0]).toEqual([{ kind: 'file', path: filePath, type: 'added' }]);
      stop();
    });

    it('reports a rename that leaves a directory as added/directory', async () => {
      const fake = createFakeWatch();
      const stop = await startRootWatch(makeHandle(root), collect, { watch: fake.watch });
      const dirPath = join(root, 'sub');
      await mkdir(dirPath);
      fake.emit('rename', 'sub');
      await batchCount(1);
      expect(batches[0]).toEqual([{ kind: 'directory', path: dirPath, type: 'added' }]);
      stop();
    });

    it('reports a change to a file as modified/file', async () => {
      const fake = createFakeWatch();
      const stop = await startRootWatch(makeHandle(root), collect, { watch: fake.watch });
      const filePath = join(root, 'b.txt');
      await writeFile(filePath, 'x');
      fake.emit('change', 'b.txt');
      await batchCount(1);
      expect(batches[0]).toEqual([{ kind: 'file', path: filePath, type: 'modified' }]);
      stop();
    });

    it('reports any event for a vanished path as the safe directory-removed shape', async () => {
      const fake = createFakeWatch();
      const stop = await startRootWatch(makeHandle(root), collect, { watch: fake.watch });
      fake.emit('rename', 'gone');
      fake.emit('change', join('nested', 'ghost.txt'));
      await batchCount(1);
      expect(batches[0]).toEqual([
        { kind: 'directory', path: join(root, 'gone'), type: 'removed' },
        { kind: 'directory', path: join(root, 'nested', 'ghost.txt'), type: 'removed' },
      ]);
      stop();
    });

    it('joins event names onto the handle path as given, with no doubled separator', async () => {
      const fake = createFakeWatch();
      const stop = await startRootWatch(makeHandle(`${root}${sep}`), collect, {
        watch: fake.watch,
      });
      expect(fake.directory).toBe(root);
      const filePath = join(root, 'c.txt');
      await writeFile(filePath, 'x');
      fake.emit('rename', 'c.txt');
      await batchCount(1);
      expect(batches[0]).toEqual([{ kind: 'file', path: `${root}${sep}c.txt`, type: 'added' }]);
      stop();
    });
  });

  describe('health', () => {
    it('reports starting then healthy, labelled with the OS mechanism', async () => {
      const fake = createFakeWatch();
      const health: WatcherHealthTransition[] = [];
      const stop = await startRootWatch(makeHandle(root), collect, {
        onHealth: (event) => health.push(event),
        watch: fake.watch,
      });
      expect(health.map((event) => event.state)).toEqual(['starting', 'healthy']);
      const platform = process.platform;
      if (platform === 'darwin' || platform === 'linux' || platform === 'win32') {
        expect(health[0]?.backend).toBe(EXPECTED_BACKEND[platform]);
      }
      expect(health[1]?.failure).toBeUndefined();
      stop();
    });

    it('maps dropped events to a root invalidation and keeps the watch', async () => {
      const fake = createFakeWatch();
      const health: WatcherHealthTransition[] = [];
      const stop = await startRootWatch(makeHandle(root), collect, {
        onHealth: (event) => health.push(event),
        watch: fake.watch,
      });
      fake.emit('change', null);
      await batchCount(1);
      // The sentinel is root/'added' (a MEMBERSHIP change): the Explorer refresh
      // consumer skips 'modified' as content-only, so only 'added' on the root
      // path forces the full root re-enumeration lost events require.
      expect(batches[0]).toEqual([{ kind: 'directory', path: root, type: 'added' }]);
      expect(health.at(-1)).toMatchObject({
        failure: { code: 'rescan-required', retryable: true, terminal: false },
        state: 'degraded',
      });
      const filePath = join(root, 'after-overflow.txt');
      await writeFile(filePath, 'x');
      fake.emit('rename', 'after-overflow.txt');
      await batchCount(2);
      expect(batches[1]).toEqual([{ kind: 'file', path: filePath, type: 'added' }]);
      expect(fake.closeCalls).toBe(0);
      stop();
    });

    it('recovers degraded to healthy on the next clean event, once per episode', async () => {
      const fake = createFakeWatch();
      const health: WatcherHealthTransition[] = [];
      const stop = await startRootWatch(makeHandle(root), collect, {
        onHealth: (event) => health.push(event),
        watch: fake.watch,
      });
      await writeFile(join(root, 'ok.txt'), 'x');
      fake.emit('change', null);
      fake.emit('change', null);
      fake.emit('change', 'ok.txt');
      fake.emit('change', null);
      expect(health.map((event) => event.state)).toEqual([
        'starting',
        'healthy',
        'degraded',
        'healthy',
        'degraded',
      ]);
      stop();
    });

    it('reports a watch that ends with an error as failed, with a root invalidation', async () => {
      const fake = createFakeWatch();
      const health: WatcherHealthTransition[] = [];
      const stop = await startRootWatch(makeHandle(root), collect, {
        onHealth: (event) => health.push(event),
        watch: fake.watch,
      });
      fake.emitError(new Error('EPERM: operation not permitted, watch'));
      await batchCount(1);
      expect(batches[0]).toEqual([{ kind: 'directory', path: root, type: 'added' }]);
      expect(health.at(-1)).toMatchObject({
        failure: {
          code: 'backend-error',
          message: 'EPERM: operation not permitted, watch',
          retryable: true,
          terminal: false,
        },
        state: 'failed',
      });
      stop();
    });

    it('reports a refused start as failed and rejects, owning no watch', async () => {
      const health: WatcherHealthTransition[] = [];
      await expect(
        startRootWatch(makeHandle(root), collect, {
          onHealth: (event) => health.push(event),
          watch: () => {
            throw new Error('ENOSPC: System limit for number of file watchers reached');
          },
        })
      ).rejects.toThrow('ENOSPC');
      expect(health.map((event) => event.state)).toEqual(['starting', 'failed']);
      expect(health[1]?.failure).toMatchObject({
        code: 'subscribe-failed',
        retryable: true,
        terminal: false,
      });
    });

    it('awaits its beforeSubscribe seam before the watch starts', async () => {
      const fake = createFakeWatch();
      const watch = vi.fn(fake.watch);
      const gate = Promise.withResolvers<void>();
      const health: WatcherHealthTransition[] = [];
      const watching = startRootWatch(makeHandle(root), collect, {
        beforeSubscribe: () => gate.promise,
        onHealth: (event) => health.push(event),
        watch,
      });
      await Promise.resolve();
      expect(watch).not.toHaveBeenCalled();
      expect(health.map((event) => event.state)).toEqual(['starting']);
      gate.resolve();
      const stop = await watching;
      expect(watch).toHaveBeenCalledOnce();
      expect(health.map((event) => event.state)).toEqual(['starting', 'healthy']);
      stop();
    });
  });

  describe('retirement', () => {
    it('closes the watch exactly once and reports stopped once', async () => {
      const fake = createFakeWatch();
      const health: WatcherHealthTransition[] = [];
      const stop = await startRootWatch(makeHandle(root), collect, {
        onHealth: (event) => health.push(event),
        watch: fake.watch,
      });
      stop();
      stop();
      expect(fake.closeCalls).toBe(1);
      expect(health.filter((event) => event.state === 'stopped')).toHaveLength(1);
    });

    it('drops events and errors that arrive after close', async () => {
      const fake = createFakeWatch();
      const health: WatcherHealthTransition[] = [];
      const retire = await startJoinedRootWatch(makeHandle(root), collect, {
        onHealth: (event) => health.push(event),
        watch: fake.watch,
      });
      await writeFile(join(root, 'late.txt'), 'x');
      await retire();
      fake.emit('rename', 'late.txt');
      fake.emitError(new Error('late'));
      expect(health.at(-1)?.state).toBe('stopped');
      expect(batches).toEqual([]);
    });

    it('settles once an admitted event stat has, without admitting queued stats', async () => {
      const fake = createFakeWatch();
      const releaseStat = Promise.withResolvers<Stats>();
      const statStarted = Promise.withResolvers<void>();
      const stat = vi.spyOn(fs.promises, 'stat').mockImplementation(() => {
        statStarted.resolve();
        return releaseStat.promise;
      });
      const retire = await startJoinedRootWatch(makeHandle(root), collect, {
        watch: fake.watch,
      });
      fake.emit('change', 'a.ts');
      fake.emit('change', 'b.ts');
      await statStarted.promise;
      expect(stat).toHaveBeenCalledOnce();
      let settled = false;
      const retiring = retire().then(() => {
        settled = true;
      });
      expect(fake.closeCalls).toBe(1);
      await Promise.resolve();
      expect(settled).toBe(false);
      releaseStat.resolve(await fs.promises.lstat(root));
      await retiring;
      expect(stat).toHaveBeenCalledOnce();
      await retire();
      expect(fake.closeCalls).toBe(1);
    });
  });
});

describe('root watch engine on Node fs.watch', () => {
  let root = '';

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'root-watch-real-')));
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  /**
   * Starts a real watch and resolves once it reports a change in `probeDirectory`. A watch is not live when
   * `fs.watch` returns on macOS (libuv starts the FSEvents stream on its CoreFoundation thread) or on Linux (Node
   * watches nested directories afterwards), so a change made at once can go unseen. A probe file rewritten until one
   * write is reported proves the watch live.
   */
  async function startLiveWatch(
    probeDirectory: string,
    onChanges: (changes: FileSystemChange[]) => void
  ): Promise<() => Promise<void>> {
    const probe = join(probeDirectory, '.live-probe');
    let live = false;
    const retire = await startJoinedRootWatch(makeHandle(root), (changes) => {
      live ||= changes.some((change) => change.path === probe);
      onChanges(changes);
    });
    let writes = 0;
    try {
      await expect
        .poll(
          async () => {
            if (!live) {
              writes += 1;
              await writeFile(probe, String(writes));
            }
            return live;
          },
          { interval: 50, timeout: 4000 }
        )
        .toBe(true);
    } catch (cause) {
      await retire();
      throw cause;
    }
    return retire;
  }

  it('reports a file created in a nested directory, and never an ignored tree', async () => {
    await mkdir(join(root, 'src', 'deep'), { recursive: true });
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
    const created = join(root, 'src', 'deep', 'created.ts');
    const seen: FileSystemChange[] = [];
    const delivered = Promise.withResolvers<void>();
    const retire = await startLiveWatch(join(root, 'src', 'deep'), (changes) => {
      seen.push(...changes);
      if (changes.some((change) => change.path === created)) {
        delivered.resolve();
      }
    });
    try {
      await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'ignored');
      await writeFile(created, 'export {};');
      await delivered.promise;
      expect(seen).toContainEqual({ kind: 'file', path: created, type: expect.any(String) });
      expect(seen.filter((change) => change.path.includes('node_modules'))).toEqual([]);
    } finally {
      await retire();
    }
  });

  /** Starts a live watch, acts, and resolves once every path in `expected` has been reported. */
  async function watchUntilReported(
    expected: readonly string[],
    act: () => Promise<void>,
    probeDirectory = root
  ): Promise<FileSystemChange[]> {
    const seen: FileSystemChange[] = [];
    const pending = new Set(expected);
    const delivered = Promise.withResolvers<void>();
    const retire = await startLiveWatch(probeDirectory, (changes) => {
      seen.push(...changes);
      for (const change of changes) {
        pending.delete(change.path);
      }
      if (pending.size === 0) {
        delivered.resolve();
      }
    });
    try {
      await act();
      await delivered.promise;
      return seen;
    } finally {
      await retire();
    }
  }

  it('reports a directory and a file written into it within one batch window', async () => {
    const directory = join(root, 'fresh');
    const file = join(directory, 'inside.ts');
    const seen = await watchUntilReported([directory, file], async () => {
      await mkdir(directory);
      await writeFile(file, 'export {};');
    });
    expect(seen).toContainEqual({ kind: 'directory', path: directory, type: 'added' });
    expect(seen).toContainEqual(expect.objectContaining({ kind: 'file', path: file }));
  });

  it('reports a directory renamed into the root, with what it already holds', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'root-watch-outside-'));
    try {
      await mkdir(join(outside, 'moved', 'nested'), { recursive: true });
      await writeFile(join(outside, 'moved', 'nested', 'kept.ts'), 'export {};');
      const directory = join(root, 'moved');
      const nestedFile = join(directory, 'nested', 'kept.ts');
      const seen = await watchUntilReported([directory], async () => {
        await rename(join(outside, 'moved'), directory);
      });
      expect(seen).toContainEqual({ kind: 'directory', path: directory, type: 'added' });
      // The moved tree is watched: a later write inside it is reported.
      const later = await watchUntilReported(
        [nestedFile],
        async () => {
          await writeFile(nestedFile, 'export const changed = true;');
        },
        join(directory, 'nested')
      );
      expect(later).toContainEqual(expect.objectContaining({ kind: 'file', path: nestedFile }));
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });

  it('refuses a missing root visibly: failed health and a rejected start', async () => {
    const missing = join(root, 'missing');
    const health: WatcherHealthTransition[] = [];
    await expect(
      startJoinedRootWatch(makeHandle(missing), () => undefined, {
        onHealth: (event) => health.push(event),
      })
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(health.map((event) => event.state)).toEqual(['starting', 'failed']);
  });
});
