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
import {
  assertNoPlatformSkips,
  attributeWatcherFailure,
} from '@brainstrike/file-system/testing/watcher-liveness';
import { getAdjustedTimeout } from '@brainstrike/test-utils';
import type { DirectoryHandle, WatcherHealthState } from '@brainstrike/types';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGitInventoryWatchers,
  type WatchGitCommonDir,
} from '../../assistant-server/git-inventory-watcher';

// Real git subprocesses + a real native watcher subscription. Uses the shared
// scaled profile rather than a literal so `TEST_TIMEOUT_MULTIPLIER` can still
// raise it on a slow machine — a hardcoded 30_000 would equal the CI value
// (`uiComponent` 15s x2) and silently CAP any higher multiplier.
vi.setConfig({ testTimeout: getAdjustedTimeout('heavy') });

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
 * `stallSubscribeMs` defers the real subscribe to simulate a loaded CI box.
 * {@link RealWatchHarness.observedStates} is what actually PROVES the gate:
 * see the assertion in {@link expectLinkedWorktreeCommitInvalidates}.
 */
interface RealWatchHarness {
  /**
   * Every health state this harness observed, in arrival order. Lets a test
   * assert the ORDERING invariant (`'healthy'` precedes `sync()` resolving)
   * directly, instead of inferring it from a wall-clock race it happened to
   * win.
   */
  readonly observedStates: readonly WatcherHealthState[];
  readonly watchDirectory: WatchGitCommonDir;
}

function createRealWatchDirectory(stallSubscribeMs = 0): RealWatchHarness {
  const adapter = new ElectronFileSystemAdapter();
  const observedStates: WatcherHealthState[] = [];
  // Must exceed the injected stall, so the stall itself can never trip it.
  const settleDeadlineMs = stallSubscribeMs + getAdjustedTimeout('integration');

  const watchDirectory: WatchGitCommonDir = (commonDir, callback, onSignal, options) =>
    new Promise<() => void>((resolve, reject) => {
      const handle: DirectoryHandle = {
        kind: 'directory',
        name: path.basename(commonDir),
        path: commonDir,
        platform: 'electron',
      };
      let settled = false;
      // Hoisted so the deadline below can dispose a watch that DID come up
      // after this promise already gave up on it.
      let stop: () => void = () => {};

      // `startParcelWatch` can reject BEFORE emitting any health transition:
      // `selectParcelBackend()` (parcel-watchers.ts:92) and
      // `buildIgnorePatternRegex()` (:97 — reached here, since this module
      // passes `ignorePatterns: []`) both run ABOVE `transitionHealth(
      // 'starting')` (:117), and `ElectronFileSystemAdapter` only LOGS that
      // rejection (electron-adapter.ts:639-647) — no `onHealth`, no
      // `onSignal`. Without this deadline the gate would never settle,
      // `sync()` would hang, and the run would die at the test timeout with
      // no cause attached — the exact opaque failure this file exists to stop
      // producing.
      const settleDeadline = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        stop();
        reject(
          new Error(
            `watch setup for ${commonDir} reported no 'healthy'/'failed' health transition within ${settleDeadlineMs}ms (startParcelWatch likely rejected before its first transition)`
          )
        );
      }, settleDeadlineMs);

      const start = (): void => {
        // Assigned synchronously here, before any `'healthy'` transition can
        // fire (that one is always post-`await` inside `startParcelWatch`,
        // whereas `'starting'` fires synchronously during this very call).
        stop = adapter.watchDirectory(handle, callback, onSignal, {
          ignorePatterns: options?.ignorePatterns,
          onHealth: (event) => {
            observedStates.push(event.state);
            if (settled) {
              return;
            }
            if (event.state === 'healthy') {
              settled = true;
              clearTimeout(settleDeadline);
              resolve(stop);
              return;
            }
            if (event.state === 'failed') {
              settled = true;
              clearTimeout(settleDeadline);
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

  return { observedStates, watchDirectory };
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
  const harness = createRealWatchDirectory(stallSubscribeMs);
  const watchers = createGitInventoryWatchers({
    onInvalidate: (gitCommonDir) => invalidations.push(gitCommonDir),
    watchDirectory: harness.watchDirectory,
  });

  try {
    await watchers.sync([commonDir]);
    // A setup failure must surface as ITS OWN message here, rather than as an
    // opaque `expected [] to include …` once the deadline below expires.
    expect(watchers.getHealthErrors()).toEqual([]);

    // THE invariant this file exists to protect, asserted DIRECTLY rather than
    // inferred from a race: `sync()` must not resolve until the native
    // subscription is live. Machine-independent and deadline-free — remove the
    // `'healthy'` gate and `sync()` resolves in the same tick it was called,
    // so this fails immediately and identically on an idle laptop and a loaded
    // CI box alike. That is the property a stall alone cannot guarantee: a
    // refactor that drops the gate would drop the now-dead stall with it,
    // taking the guard along. This assertion survives that.
    expect(harness.observedStates).toContain('healthy');

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

/**
 * BST-1328 attribution. These tests assert OUR invalidation rule THROUGH the OS
 * watcher, so they are only meaningful while that layer actually delivers. On a
 * host where it has gone silent they failed as
 * `expected [] to include '/private/var/…'` after the full 10s wait — an
 * "events were LOST" signature that reads like a bug in
 * `git-inventory-watcher.ts` when it is nothing of the sort.
 *
 * The probe runs on the FAILURE PATH ONLY, and at the moment of failure — not
 * as a pre-flight gate. The fault is intermittent rather than steady: measured
 * on this host, a pre-flight probe reported `alive`, the first test passed, and
 * the platform then went silent for the second test in the SAME process. Only a
 * probe taken when the event failed to arrive answers the right question.
 *
 * It is narrow by construction: it steps aside ONLY when the native backend is
 * silent while libuv still delivers in the same process (proven, not assumed),
 * prints the reason to stderr, and is never reached on a healthy host or in CI
 * (Linux/inotify). A host where NOTHING delivers is deliberately NOT skipped —
 * that is a broken harness, not the known platform fault, and must fail. When
 * the probe finds the platform ALIVE, the failure is rethrown with that verdict
 * attached: positive evidence that the bug is ours.
 */
describe('createGitInventoryWatchers (real repo, real @parcel/watcher)', () => {
  it('invalidates the repo common dir when a commit lands in a LINKED WORKTREE', async (ctx) => {
    try {
      await expectLinkedWorktreeCommitInvalidates(0);
    } catch (error) {
      await attributeWatcherFailure(ctx, error);
    }
  });

  /**
   * Regression guard for the subscribe-window race that made this file flaky
   * in the "Unit (heavy)" lane (2026-08-07/08). Complements — never replaces —
   * the `observedStates` ordering assertion, which is what actually detects
   * removal of the gate. This case adds the end-to-end proof that the gate
   * still yields a correct invalidation when the native subscribe is genuinely
   * slow, i.e. the real CI condition, rather than only when it is fast.
   */
  it('invalidates even when the native subscribe is slow to come up', async (ctx) => {
    try {
      await expectLinkedWorktreeCommitInvalidates(400);
    } catch (error) {
      await attributeWatcherFailure(ctx, error);
    }
  });
});

// A run that skipped its subject is not a pass — see assertNoPlatformSkips.
afterAll(() => {
  assertNoPlatformSkips();
});
