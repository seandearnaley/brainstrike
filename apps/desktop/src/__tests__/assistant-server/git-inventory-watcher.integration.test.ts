/**
 * Real-repo + real `@parcel/watcher` integration coverage for
 * `git-inventory-watcher.ts`: a commit in a LINKED WORKTREE fires an
 * invalidation keyed by the repo's COMMON dir — proving the "one
 * subscription per common dir covers every linked worktree's git metadata"
 * watcher rule end to end, through the real `ElectronFileSystemAdapter`
 * (never a fake), mirroring the `makeRepo`/realpath pattern from
 * `git-service.integration.test.ts:31-40`.
 */
import { execFile } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ElectronFileSystemAdapter } from '@brainstrike/file-system/electron';
import type { DirectoryHandle } from '@brainstrike/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGitInventoryWatchers,
  type WatchGitCommonDir,
} from '../../assistant-server/git-inventory-watcher';

const execFileAsync = promisify(execFile);
const createdRoots: string[] = [];

/**
 * Repo + linked worktree both live inside a dedicated container directory
 * (never the shared OS tmpdir itself), matching the rationale in
 * `git-inventory.integration.test.ts` — avoids any accidental interaction
 * with concurrently-running tests' own temp trees.
 */
async function makeContainer(): Promise<string> {
  const root = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), 'brainstrike-git-inventory-watch-container-')
  );
  const real = await fsPromises.realpath(root);
  createdRoots.push(real);
  return real;
}

async function initRepoAt(dir: string): Promise<string> {
  await execFileAsync('git', ['init', '-q'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'test@brainstrike.dev'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'Brainstrike Test'], { cwd: dir });
  await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  return dir;
}

async function commitFile(repo: string, name: string, content: string): Promise<void> {
  await fsPromises.writeFile(path.join(repo, name), content, 'utf8');
  await execFileAsync('git', ['add', name], { cwd: repo });
  await execFileAsync('git', ['commit', '-q', '-m', `add ${name}`], { cwd: repo });
}

afterEach(async () => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root) {
      await fsPromises.rm(root, { force: true, recursive: true });
    }
  }
});

/**
 * Adapts the real, SYNCHRONOUSLY-returning `ElectronFileSystemAdapter.
 * watchDirectory` into this module's `Promise<() => void>` DI shape — see
 * `git-inventory-watcher.ts`'s `WatchGitCommonDir` doc for the full
 * sync-vs-async reconciliation. The adapter's disposer is safe to use the
 * instant it's returned, so `Promise.resolve(...)` is all production wiring
 * needs — no gate on a 'healthy' transition.
 */
function createProductionWatchDirectory(): WatchGitCommonDir {
  const adapter = new ElectronFileSystemAdapter();
  return (commonDir, callback, onSignal, options) => {
    const handle: DirectoryHandle = {
      kind: 'directory',
      name: path.basename(commonDir),
      path: commonDir,
      platform: 'electron',
    };
    return Promise.resolve(
      adapter.watchDirectory(handle, callback, onSignal, {
        ignorePatterns: options?.ignorePatterns,
      })
    );
  };
}

describe('createGitInventoryWatchers (real repo, real @parcel/watcher)', () => {
  it('invalidates the repo common dir when a commit lands in a LINKED WORKTREE', async () => {
    const container = await makeContainer();
    const repo = path.join(container, 'main-repo');
    await fsPromises.mkdir(repo, { recursive: true });
    await initRepoAt(repo);
    await commitFile(repo, 'a.txt', 'a');
    await execFileAsync('git', ['branch', 'feat'], { cwd: repo });

    const linkedPath = path.join(container, 'main-repo-linked');
    await execFileAsync('git', ['worktree', 'add', '-q', linkedPath, 'feat'], { cwd: repo });
    const linkedReal = await fsPromises.realpath(linkedPath);

    const commonDir = await fsPromises.realpath(path.join(repo, '.git'));
    const invalidations: string[] = [];
    const watchers = createGitInventoryWatchers({
      onInvalidate: (gitCommonDir) => invalidations.push(gitCommonDir),
      watchDirectory: createProductionWatchDirectory(),
    });

    try {
      await watchers.sync([commonDir]);

      // Commit FROM THE LINKED WORKTREE, not the main one — this is the
      // "one subscription per common dir covers all linked worktrees"
      // claim: the write lands under `.git/worktrees/main-repo-linked/*`
      // plus the shared `refs/heads/feat`, both watched by the SAME
      // subscription opened against the common dir.
      await commitFile(linkedReal, 'b.txt', 'b');

      await vi.waitFor(
        () => {
          expect(invalidations).toContain(commonDir);
        },
        { interval: 50, timeout: 10_000 }
      );
    } finally {
      await watchers.disposeAll();
    }
  });
});
