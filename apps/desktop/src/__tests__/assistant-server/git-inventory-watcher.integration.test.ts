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

/** A repo with one seeded commit plus a linked worktree checked out on `feat`. */
async function makeRepoWithLinkedWorktree(): Promise<{
  commonDir: string;
  linkedWorktree: string;
}> {
  const container = await makeContainer();
  const repo = path.join(container, 'main-repo');
  await fsPromises.mkdir(repo, { recursive: true });
  await initRepoAt(repo);
  await commitFile(repo, 'a.txt', 'a');
  await execFileAsync('git', ['branch', 'feat'], { cwd: repo });

  const linkedPath = path.join(container, 'main-repo-linked');
  await execFileAsync('git', ['worktree', 'add', '-q', linkedPath, 'feat'], { cwd: repo });

  return {
    commonDir: await fsPromises.realpath(path.join(repo, '.git')),
    linkedWorktree: await fsPromises.realpath(linkedPath),
  };
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
 * watchDirectory` into this module's `Promise<() => void>` DI shape, GATED ON
 * THE `'healthy'` TRANSITION — resolving only once the native subscription is
 * actually live.
 *
 * That gate is a TEST-ARRANGE requirement, not a production one, and the
 * difference is deliberate on both sides. `adapter.watchDirectory` returns its
 * disposer synchronously while `startParcelWatch` (dynamic native-addon import
 * + `module.subscribe`) is still in flight, so a bare
 * `Promise.resolve(adapter.watchDirectory(...))` resolves in the SAME TICK it
 * was called — awaiting it proves the disposer is safe to call, never that the
 * kernel is watching yet. Production (`git-inventory-watcher.ts`'s
 * `WatchGitCommonDir` doc) correctly declines this gate: a subscribe-window
 * event it misses is covered by the next TTL-driven rebuild. A test that
 * commits ONCE and asserts on that single commit has no such safety net — the
 * event is simply gone, and no assertion deadline can recover it (measured:
 * `sync()` resolved at +83ms, the watch went healthy at +89ms, and the commit's
 * writes spanned +83→+109ms — a 6ms margin that CI load erases, producing
 * `expected [] to include …` after the full 10s wait).
 *
 * Resolve-on-`'healthy'` / reject-on-`'failed'` mirrors the same adapter's
 * existing production precedent in `ipc-notes-vault.ts:71-102`, which wraps
 * this identical sync adapter into a Promise so its caller can await confirmed
 * setup.
 *
 * `stallSubscribeMs` defers the real subscribe to simulate a loaded CI box,
 * making the race that used to be a 6ms coin-flip reproducible on demand.
 */
function createRealWatchDirectory(stallSubscribeMs = 0): WatchGitCommonDir {
  const adapter = new ElectronFileSystemAdapter();
  return (commonDir, callback, onSignal, options) =>
    new Promise<() => void>((resolve, reject) => {
      const handle: DirectoryHandle = {
        kind: 'directory',
        name: path.basename(commonDir),
        path: commonDir,
        platform: 'electron',
      };
      const start = (): void => {
        let settled = false;
        // Assigned synchronously below, before any `'healthy'` transition can
        // fire (that one is always post-`await` inside `startParcelWatch`,
        // whereas `'starting'` fires synchronously during this very call).
        let stop: () => void = () => {};
        stop = adapter.watchDirectory(handle, callback, onSignal, {
          ignorePatterns: options?.ignorePatterns,
          onHealth: (event) => {
            if (settled) {
              return;
            }
            if (event.state === 'healthy') {
              settled = true;
              resolve(stop);
              return;
            }
            if (event.state === 'failed') {
              settled = true;
              stop();
              reject(
                new Error(event.failure?.message ?? 'git inventory watcher setup failed in test')
              );
            }
          },
        });
      };
      if (stallSubscribeMs === 0) {
        start();
        return;
      }
      setTimeout(start, stallSubscribeMs);
    });
}

/**
 * Commit from the linked worktree and assert the COMMON dir is invalidated.
 * The write lands under `.git/worktrees/main-repo-linked/*` plus the shared
 * `refs/heads/feat` — both watched by the SAME subscription opened against the
 * common dir, which is the claim under test.
 */
async function expectLinkedWorktreeCommitInvalidates(stallSubscribeMs: number): Promise<void> {
  const { commonDir, linkedWorktree } = await makeRepoWithLinkedWorktree();
  const invalidations: string[] = [];
  const watchers = createGitInventoryWatchers({
    onInvalidate: (gitCommonDir) => invalidations.push(gitCommonDir),
    watchDirectory: createRealWatchDirectory(stallSubscribeMs),
  });

  try {
    await watchers.sync([commonDir]);
    // A setup failure must surface as ITS OWN message here, rather than as an
    // opaque `expected [] to include …` once the deadline below expires.
    expect(watchers.getHealthErrors()).toEqual([]);

    await commitFile(linkedWorktree, 'b.txt', 'b');

    // A true safety net now, not the mechanism: the subscription is already
    // confirmed live above, so the only remaining wait is the watcher's own
    // trailing debounce (300ms, capped at 2000ms).
    await vi.waitFor(
      () => {
        expect(invalidations).toContain(commonDir);
      },
      { interval: 50, timeout: 10_000 }
    );
  } finally {
    await watchers.disposeAll();
  }
}

describe('createGitInventoryWatchers (real repo, real @parcel/watcher)', () => {
  it('invalidates the repo common dir when a commit lands in a LINKED WORKTREE', async () => {
    await expectLinkedWorktreeCommitInvalidates(0);
  }, 30_000);

  /**
   * Regression guard for the subscribe-window race that made this file flaky
   * in the "Unit (heavy)" lane (2026-08-07/08). Without the `'healthy'` gate
   * in {@link createRealWatchDirectory} this case fails 100% of the time with
   * the exact CI signature — while the ungated case above still passes locally
   * on an idle machine, which is precisely why the gate needs a test that does
   * not depend on winning a wall-clock race to detect its removal.
   */
  it('invalidates even when the native subscribe is slow to come up', async () => {
    await expectLinkedWorktreeCommitInvalidates(400);
  }, 30_000);
});
