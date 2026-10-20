/**
 * Shared harness for `createGitInventoryService` unit suites
 * (`git-inventory-service-lifecycle.test.ts`,
 * `git-inventory-service-oninvalidate.test.ts`): fake `InventoryFs` +
 * fake `watchDirectory` fixtures exercising the REAL service, real
 * `buildInventorySnapshot`, and real `createGitInventoryWatchers`.
 *
 * Extracted verbatim from `git-inventory-service-lifecycle.test.ts` when that
 * file crossed the max-lines lint cap (BST-1161) — behavior unchanged.
 */
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FileSystemChange, FileSystemWatchSignal } from '@brainstrike/types';
import { vi } from 'vitest';

import type {
  InventoryDirent,
  InventoryFs,
  InventoryStat,
} from '../../assistant-server/git-inventory-discovery';
import {
  createGitInventoryService,
  type GitInventoryService,
  type GitInventoryServiceDeps,
} from '../../assistant-server/git-inventory-service';
import type { WatchGitCommonDir } from '../../assistant-server/git-inventory-watcher';
import type { GitCommandRun, GitCommandRunner } from '../../assistant-server/git-service';

const createdRoots: string[] = [];

export async function makeTempDir(prefix: string): Promise<string> {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), prefix));
  const real = await fsPromises.realpath(root);
  createdRoots.push(real);
  return real;
}

/** Call from each suite's `afterEach` — removes every temp dir made so far. */
export async function cleanupTempDirs(): Promise<void> {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root) {
      await fsPromises.rm(root, { force: true, recursive: true });
    }
  }
}

/** Minimal in-memory `InventoryFs`, scoped to a single directory-`.git` repo
 * with no linked worktrees — a narrower copy of the fixture in
 * `git-inventory-service.test.ts`. */
export class FakeFs implements InventoryFs {
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

export const FAKE_HEAD = 'a'.repeat(40);

/** One real (canonical, mkdtemp'd) root directory with a REAL `.git` child
 * directory — real because `createGitInventoryWatchers`' default `realpath`
 * (unfaked here, matching production wiring) resolves the common dir with
 * `node:fs/promises`, not the injected `InventoryFs`. */
export async function makeSingleRepoRoot(prefix: string): Promise<{
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

export function makeWorktreeListRunner(): GitCommandRunner {
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
  return run;
}

export interface FakeWatchSubscription {
  disposeCallCount: number;
  readonly fireErrorSignal: (message: string) => void;
  readonly fireInterestingChange: () => void;
}

export interface FakeWatchDirectory {
  readonly subscriptionsByCommonDir: Map<string, FakeWatchSubscription>;
  readonly watchDirectory: WatchGitCommonDir;
  readonly watchDirectorySpy: ReturnType<typeof vi.fn>;
}

export function createFakeWatchDirectory(): FakeWatchDirectory {
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
        return Promise.resolve();
      });
    }
  );
  return {
    subscriptionsByCommonDir,
    watchDirectory: watchDirectorySpy as unknown as WatchGitCommonDir,
    watchDirectorySpy,
  };
}

export function requireRelease(callback: (() => void) | null, description: string): () => void {
  if (!callback) {
    throw new Error(`expected ${description}`);
  }
  return callback;
}

export function makeService(
  overrides: Partial<GitInventoryServiceDeps> & {
    readonly loadRootsSpy?: GitInventoryServiceDeps['loadRoots'];
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
