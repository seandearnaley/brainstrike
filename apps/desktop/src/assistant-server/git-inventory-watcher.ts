/**
 * Per-repo `.git`-metadata watchers for the cross-workspace git inventory
 * (BST-1112): one subscription per repository COMMON dir, covering every
 * linked worktree's git metadata (settled empirically — see the plan's
 * Global Constraints). Filters the raw, unfiltered watch stream down to an
 * INTERESTING set of paths, batches interesting events behind a true
 * trailing debounce, and surfaces a dead subscription as typed state instead
 * of silently dropping it or auto-restarting it.
 *
 * `git-inventory-service.ts` (Task 4) owns turning `getHealthErrors()` into
 * `GitInventorySnapshot.errors` entries and calling `sync()` after every
 * rebuild; this module never touches git, the discovery walk, or the
 * database roots loader.
 */

import fsPromises from 'node:fs/promises';
import path from 'node:path';
import {
  ParcelWatchRetirementError,
  startJoinedParcelWatch,
} from '@brainstrike/file-system/native-watch';
import { createLogger } from '@brainstrike/logging';
import type { FileSystemChange, FileSystemWatchSignal } from '@brainstrike/types';

const logger = createLogger('GitInventoryWatchers');

/**
 * Batch window in ms. A TRAILING debounce (re-armed by every interesting
 * event, never a fixed window from the first) — see {@link scheduleInvalidate}
 * for why. Also tolerant of a stray late lock-file event after a rebuild
 * already ran, because lock files never reach the debounce at all (see
 * {@link isInterestingGitMetadataPath}).
 */
export const GIT_INVENTORY_WATCH_BATCH_MS = 300;

/**
 * Max-wait cap in ms on top of the trailing debounce above. A pure trailing
 * debounce re-arms on every interesting event with no upper bound, so
 * sustained churn (a long `git checkout`/rebase/`gc` writing refs
 * continuously) can starve invalidation indefinitely — the window never goes
 * quiet long enough to fire. This cap forces a fire once
 * {@link GIT_INVENTORY_WATCH_MAX_BATCH_MS} has elapsed since the FIRST event
 * of the current batch, even while events keep arriving.
 */
export const GIT_INVENTORY_WATCH_MAX_BATCH_MS = 2000;

/**
 * Injected watch function (BST-1112). Resolves once the native subscription
 * is ACQUIRED, with a disposer that settles only once the native unsubscribe
 * has settled. A rejection owns no subscription, except a typed
 * `ParcelWatchRetirementError`: its timed-out subscribe was acquired late,
 * and its `retire` still has to release it.
 *
 * Both halves are awaitable so `disposeAll()` can join every native
 * operation before Electron frees Main's Node environment. A @parcel/watcher
 * subscribe or unsubscribe still on the libuv thread pool at that point
 * completes into a dead JS context and aborts Main (BST-2244). Setup failure
 * is the visible rejection; it marks the watcher dead, and `sync()` never
 * throws for it. Production passes {@link watchGitCommonDirNatively}.
 */
export type WatchGitCommonDir = (
  commonDir: string,
  callback: (changes: FileSystemChange[]) => void,
  onSignal?: (signal: FileSystemWatchSignal) => void,
  options?: { readonly ignorePatterns?: readonly string[] }
) => Promise<() => Promise<void>>;

/**
 * The production {@link WatchGitCommonDir}: Main's joined @parcel/watcher
 * producer. A degraded backend (events lost) is an `overflow` signal; setup
 * failure arrives as the rejection, so `failed` health is not re-signalled.
 */
export const watchGitCommonDirNatively: WatchGitCommonDir = (
  commonDir,
  callback,
  onSignal,
  options
) =>
  startJoinedParcelWatch(
    { kind: 'directory', name: path.basename(commonDir), path: commonDir, platform: 'electron' },
    callback,
    {
      ignorePatterns: options?.ignorePatterns,
      onHealth: (event) => {
        if (event.state === 'degraded') {
          onSignal?.({ type: 'overflow' });
        }
      },
    }
  );

export interface GitInventoryWatcherDeps {
  /** Called (at most once per debounce window) when a repo's git metadata may have changed. */
  readonly onInvalidate: (gitCommonDir: string) => void;
  /** Defaults to `node:fs/promises`'s `realpath`; tests inject a fake. */
  readonly realpath?: (targetPath: string) => Promise<string>;
  /** electron-adapter-shaped watch function — see {@link WatchGitCommonDir}. */
  readonly watchDirectory: WatchGitCommonDir;
}

export interface GitInventoryWatchers {
  /**
   * Resolves only once every subscribe still in flight has settled and every
   * acquired native subscription is unsubscribed (BST-2244); a failed
   * unsubscribe rejects, as an `AggregateError`, after the others settle.
   * Safe to call at any time, including while a `sync()` subscribe is in
   * flight. A later call joins retirements still in flight and retries, once,
   * each one whose unsubscribe failed, here or in an earlier `sync()`: a
   * failed retirement stays owned until its unsubscribe succeeds. TERMINAL:
   * once called, this instance never subscribes again, even if a later
   * `sync()` lists a common dir — matches the service `stop()` lifecycle this
   * pairs with (`createGitInventoryWatchers` is called again to start fresh).
   */
  readonly disposeAll: () => Promise<void>;
  /**
   * Common dirs whose watcher failed and is NOT watching (typed state Task 4
   * folds into `GitInventorySnapshot.errors`). Covers SETUP-TIME death only —
   * a rejected {@link WatchGitCommonDir} acquisition (or an `errored`
   * signal). A subscription that dies AFTER
   * successfully starting (backend crash, common dir replaced on disk, …)
   * reports `'degraded'`/`'overflow'` upstream instead, which this module
   * does not treat as dead — that subscription stays silently stale until
   * the next TTL-driven rebuild notices on its own. See 3712387859.
   */
  readonly getDeadCommonDirs: () => ReadonlySet<string>;
  /** Human-readable, ready-to-append error strings — one per dead watcher. Same setup-time-only coverage as {@link getDeadCommonDirs}. */
  readonly getHealthErrors: () => readonly string[];
  /**
   * Subscribe every NEW common dir in the list, dispose every subscription
   * whose common dir is no longer in the list, and leave every other live
   * subscription untouched. A DEAD subscription that is still in the list is
   * disposed and resubscribed — this is the only retry path ("no
   * auto-restart" means nothing resubscribes on a timer or on its own; it
   * only happens because the caller invoked `sync()` again, i.e. an explicit
   * rebuild). A failed unsubscribe rejects `sync()`, as an `AggregateError`,
   * after its subscribes ran; that subscription stays owned (its common dir
   * is not resubscribed) and the next `sync()` or `disposeAll()` retries it.
   * Calling `sync()` on an instance after `disposeAll()` is a
   * deliberate, silent no-op — TERMINAL per `disposeAll`'s own contract — NOT
   * a gap in this module's own NO-SILENT-FALLBACKS posture: the one caller
   * (`git-inventory-service.ts`) never reuses a disposed instance past
   * `stop()`, since `stop()` drops it entirely and a later `start()` always
   * builds a fresh `createGitInventoryWatchers()` instance instead.
   */
  readonly sync: (commonDirs: readonly string[]) => Promise<void>;
}

interface Subscription {
  /**
   * Interesting-vs-seen counters ACCUMULATED SINCE THE LAST BATCH CLOSE —
   * see {@link logAndResetBatchCounters}. NOT scoped to "the current batch":
   * a batch only opens once an interesting event arrives, so a noise-only
   * period (e.g. sustained `objects/**` churn with no interesting event)
   * keeps incrementing `batchEventsSeen` with no batch open at all. That is
   * deliberate, not a gap — it is the MORE useful measurement, because it
   * captures noise the debounce window itself never saw: the first
   * interesting event to arrive after such a period reports the full
   * accumulated noise, not just its own delivery. Zero-cost: two integers,
   * reset every time a batch closes (normal debounce fire or forced
   * overflow fire).
   */
  /**
   * This claim's native acquisition. Never rejects: it settles once the
   * subscription is acquired or has failed. Whoever removes the claim joins
   * it before calling {@link Subscription.dispose}.
   */
  acquisition: Promise<void>;
  batchEventsInteresting: number;
  batchEventsSeen: number;
  dead: boolean;
  deadReason: string | null;
  /** Retires the acquired native subscription; settles once its unsubscribe has. */
  dispose: () => Promise<void>;
  /** Arrival time (ms, `Date.now()`) of the first event in the CURRENT batch; `null` when no batch is pending. Drives the {@link GIT_INVENTORY_WATCH_MAX_BATCH_MS} cap. */
  firstEventAt: number | null;
  /** The retirement in flight, or the one that succeeded; cleared when one rejects, so the next attempt retries. */
  retirement: Promise<void> | undefined;
  /** The claim was removed; the entry stays in the map until its native unsubscribe succeeds. */
  retiring: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

const LOCK_SUFFIX_RE = /\.lock$/;

/**
 * The INTERESTING set (Global Constraints, settled): `HEAD`, `index`,
 * `ORIG_HEAD`, `refs/**`, `packed-refs` (a content write — the false-negative
 * hole a default ignore set would drop), `worktrees/<name>/(HEAD|index|
 * ORIG_HEAD|locked|gitdir)`, and a BARE `worktrees/<name>` for worktree
 * lifecycle (add/remove — the directory itself appearing or disappearing).
 * `locked` and `gitdir` are inventory-visible, not just bookkeeping:
 * `GitWorktreeSummary.lockedReason` (`packages/types/src/git.ts`) is read
 * from `.git/worktrees/<name>/locked`, and `gitdir` is rewritten by `git
 * worktree move`/`repair`, changing `WorktreeDescriptor.path` — without
 * these, `git worktree lock`/`unlock`/`move` produce no invalidation.
 * Deliberately excludes `objects/**` churn (every write there is content the
 * inventory doesn't summarize) and every `*.lock` transient path via the
 * separate {@link LOCK_SUFFIX_RE} check below: git always renames a lock file
 * into its final name (`index.lock` → `index`, `refs/heads/x.lock` →
 * `refs/heads/x`, `packed-refs.lock` → `packed-refs`) and that final name is
 * already matched here — the lock file itself is redundant noise, never a
 * missed signal. Also deliberately excludes `FETCH_HEAD` and
 * `COMMIT_EDITMSG` — the two most surprising omissions, kept out because
 * neither feeds `GitInventory` (see the full excluded list in
 * `docs/agents/platform-contracts.md`).
 */
const INTERESTING_RE =
  /^(?:HEAD|ORIG_HEAD|index|packed-refs|refs\/.+|worktrees\/[^/]+(?:\/(?:HEAD|ORIG_HEAD|index|locked|gitdir))?)$/;

function isInterestingGitMetadataPath(relativePosixPath: string): boolean {
  if (LOCK_SUFFIX_RE.test(relativePosixPath)) {
    return false;
  }
  return INTERESTING_RE.test(relativePosixPath);
}

/** POSIX-separated path of `absolutePath` relative to `commonDir`, for matching against {@link INTERESTING_RE} on every platform. */
function toRelativePosixPath(commonDir: string, absolutePath: string): string {
  return path.relative(commonDir, absolutePath).split(path.sep).join('/');
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Rejects with every failed retirement; the message names each cause, as the service reports only the message. */
function throwRetirementFailures(results: readonly PromiseSettledResult<void>[]): void {
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  );
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Git inventory watcher retirement failed: ${failures.map(toErrorMessage).join('; ')}`
    );
  }
}

/**
 * Wire per-repo git-metadata watchers. Deliberately takes no discovery/DB
 * dependency — `commonDirs` is handed in by the caller (`sync`), which is
 * `git-inventory-service.ts` after every snapshot rebuild.
 */
export function createGitInventoryWatchers(deps: GitInventoryWatcherDeps): GitInventoryWatchers {
  const realpath = deps.realpath ?? ((targetPath: string) => fsPromises.realpath(targetPath));
  const subscriptions = new Map<string, Subscription>();
  let disposed = false;

  /**
   * Zero-cost measurement seam (no new infra, no persistence, no new
   * dependency, no new public interface): logs how many raw events were SEEN
   * versus how many PASSED {@link isInterestingGitMetadataPath} SINCE THE
   * LAST TIME A BATCH CLOSED for this common dir (see the doc on
   * {@link Subscription.batchEventsSeen} for why that is not the same as
   * "the current batch" and why that is the more useful measurement), at
   * debug level, right before this batch closes (a normal debounce fire or
   * a forced overflow fire). Attributed per common dir so the numbers are
   * actionable — this is the data the `ignorePatterns: []` tradeoff comment
   * (in {@link subscribe}) says to gather before reaching for a native
   * ignore-pattern change.
   */
  function logAndResetBatchCounters(commonDir: string, sub: Subscription): void {
    logger.debug('git inventory watcher batch: interesting/seen event counts', {
      commonDir,
      eventsInteresting: sub.batchEventsInteresting,
      eventsSeen: sub.batchEventsSeen,
    });
    sub.batchEventsInteresting = 0;
    sub.batchEventsSeen = 0;
  }

  /**
   * TRUE trailing debounce, WITH a max-wait cap: every interesting event
   * clears and re-arms a fresh {@link GIT_INVENTORY_WATCH_BATCH_MS} window
   * from ITS OWN arrival time, never from the first event's. An event burst
   * at t=0,100,200 fires once at ~500, not at 300 — a FIXED window keyed off
   * the first event would fire mid-burst and could split one logical git
   * operation (e.g. a commit's HEAD+index+refs writes land a few ms apart)
   * across two rebuilds. But a PURE trailing debounce has no upper bound, so
   * sustained churn (a long `git checkout`/rebase/`gc`) can re-arm forever
   * and starve invalidation indefinitely; {@link GIT_INVENTORY_WATCH_MAX_BATCH_MS}
   * forces a fire once that much time has elapsed since the batch's first
   * event, even while events keep arriving.
   */
  function scheduleInvalidate(commonDir: string, sub: Subscription): void {
    const now = Date.now();
    if (sub.firstEventAt === null) {
      sub.firstEventAt = now;
    }
    if (sub.timer) {
      clearTimeout(sub.timer);
    }
    const elapsed = now - sub.firstEventAt;
    const delay = Math.max(
      0,
      Math.min(GIT_INVENTORY_WATCH_BATCH_MS, GIT_INVENTORY_WATCH_MAX_BATCH_MS - elapsed)
    );
    sub.timer = setTimeout(() => {
      sub.timer = null;
      sub.firstEventAt = null;
      logAndResetBatchCounters(commonDir, sub);
      deps.onInvalidate(commonDir);
    }, delay);
  }

  function handleChanges(
    commonDir: string,
    watchRoot: string,
    sub: Subscription,
    changes: readonly FileSystemChange[]
  ): void {
    // A torn-down (or superseded/replaced) subscription must never keep
    // arming timers or invoking onInvalidate — checked BEFORE doing any
    // path filtering work, not just before scheduling.
    if (isStaleAttempt(commonDir, sub)) {
      return;
    }
    // Relative-path base MUST be `watchRoot` (what the subscription was
    // actually opened against, realpath'd) — every change path the adapter
    // reports is under that real tree, not necessarily under the ORIGINAL
    // (possibly symlinked) `commonDir` key used for the invalidation/dead-set
    // identity below. Counted in full (not short-circuited) so
    // `batchEventsInteresting` reflects every interesting change in this
    // delivery, not just whether at least one existed.
    let interestingInThisDelivery = 0;
    for (const change of changes) {
      if (isInterestingGitMetadataPath(toRelativePosixPath(watchRoot, change.path))) {
        interestingInThisDelivery += 1;
      }
    }
    sub.batchEventsSeen += changes.length;
    sub.batchEventsInteresting += interestingInThisDelivery;
    if (interestingInThisDelivery === 0) {
      return;
    }
    scheduleInvalidate(commonDir, sub);
  }

  function handleSignal(commonDir: string, sub: Subscription, signal: FileSystemWatchSignal): void {
    // Same post-teardown guard as handleChanges: a disposed or
    // superseded/replaced subscription must never fire onInvalidate or write
    // dead state.
    if (isStaleAttempt(commonDir, sub)) {
      return;
    }
    if (signal.type === 'overflow') {
      // Events may have been missed (WICG 'unknown' records / native
      // overflow) — the whole repo's metadata is stale. Force an immediate
      // rebuild rather than waiting for another interesting event that may
      // never arrive; this does not mark the watcher dead, it stays live.
      if (sub.timer) {
        clearTimeout(sub.timer);
        sub.timer = null;
      }
      sub.firstEventAt = null;
      logAndResetBatchCounters(commonDir, sub);
      deps.onInvalidate(commonDir);
      return;
    }
    // signal.type === 'errored': the adapter has ALREADY torn the
    // subscription down (FileSystemWatchSignal's own contract: "the watch is
    // dead and already disconnected"). Mark this repo's watcher dead —
    // visible via getDeadCommonDirs()/getHealthErrors(), never a silent
    // no-op and never an auto-restart. Explicit retry only, via a later
    // sync() call that still lists this commonDir.
    sub.dead = true;
    sub.deadReason = signal.message;
    if (sub.timer) {
      clearTimeout(sub.timer);
      sub.timer = null;
    }
    sub.firstEventAt = null;
    logger.error('git inventory watcher failed; repo watcher marked dead', {
      commonDir,
      message: signal.message,
    });
  }

  /**
   * Is `sub` no longer the live claim for `commonDir` — because `disposeAll()`
   * ran, `sync()` removed its claim (it may still be retiring), or a
   * dispose/resubscribe race replaced it with a fresh retry Subscription?
   * Shared by the event handlers and every point in {@link subscribe} that
   * must not act (write dead state, log, or open/keep a real watch) on behalf
   * of a superseded attempt.
   */
  function isStaleAttempt(commonDir: string, sub: Subscription): boolean {
    return disposed || sub.retiring || subscriptions.get(commonDir) !== sub;
  }

  async function subscribe(commonDir: string): Promise<void> {
    // The map entry is claimed SYNCHRONOUSLY, before any `await`, and is the
    // single source of truth for "is someone already subscribing/subscribed
    // to this commonDir". Two overlapping sync() calls both decide (in their
    // own synchronous collection pass, before either has invoked subscribe())
    // that `commonDir` needs a NEW subscription; whichever of their
    // subscribe() calls actually runs first claims the map entry here, and
    // the second sees `subscriptions.has(commonDir)` already true and bails
    // — never creating a second live subscription that would silently
    // overwrite (and leak) the first.
    if (disposed || subscriptions.has(commonDir)) {
      return;
    }
    const sub: Subscription = {
      acquisition: Promise.resolve(),
      batchEventsInteresting: 0,
      batchEventsSeen: 0,
      dead: false,
      deadReason: null,
      dispose: () => Promise.resolve(),
      firstEventAt: null,
      retirement: undefined,
      retiring: false,
      timer: null,
    };
    subscriptions.set(commonDir, sub);
    sub.acquisition = acquire(commonDir, sub);
    await sub.acquisition;
  }

  /** Opens `sub`'s native watch. Never rejects: setup failure is dead state. */
  async function acquire(commonDir: string, sub: Subscription): Promise<void> {
    let watchRoot: string;
    try {
      watchRoot = await realpath(commonDir);
    } catch (error) {
      // Mutate the SAME `sub` record already claiming the map entry, rather
      // than creating (and setting) a new one — there is only ever one
      // Subscription object per claimed commonDir, from claim to teardown.
      // Guarded on the stale-identity check below: disposeAll() (or a
      // dispose/resubscribe race) may have already deleted this entry, or
      // replaced it with a fresh retry Subscription, while realpath() was in
      // flight — in either case this failure belongs to a subscription
      // attempt that no longer exists and must not write dead state or log.
      if (isStaleAttempt(commonDir, sub)) {
        return;
      }
      const message = `common dir could not be resolved: ${toErrorMessage(error)}`;
      sub.dead = true;
      sub.deadReason = message;
      logger.error('git inventory watcher setup failed to resolve common dir', {
        commonDir,
        error: message,
      });
      return;
    }

    // disposeAll() (or a dispose/resubscribe race) may have torn this
    // Subscription down while realpath() was in flight — checked BEFORE
    // opening the real watch, not just after.
    if (isStaleAttempt(commonDir, sub)) {
      return;
    }

    try {
      // `ignorePatterns: []` is LOAD-BEARING, not a perf oversight — do not
      // "fix" it back to the default. `DEFAULT_IGNORE_PATTERNS`
      // (packages/utils/src/path-filter.ts) includes `.git`, so a
      // subscription rooted AT `.git` would have every single event dropped
      // by the native filter before it ever reached this module.
      //
      // The cost this buys: `[]` disables native filtering ENTIRELY, not
      // just for `.git`. `parcel-watchers.ts`'s `processEvent` only calls
      // `shouldIgnore()` before `fs.stat()`-ing a non-delete event; with no
      // patterns, `shouldIgnore()` never matches, so every event reaches
      // that `stat()`. During a `git fetch`/`gc`, `.git/objects/**` writes
      // can number in the thousands — each one costs a main-process `stat`
      // call, and our own {@link isInterestingGitMetadataPath} then discards
      // nearly all of them anyway (see {@link logAndResetBatchCounters} for
      // a debug-level, per-repo seen-vs-interesting counter that measures
      // this live instead of by speculation).
      //
      // Rejected fix: `ignorePatterns: ['objects', 'logs']` would kill the
      // native storm, but `buildIgnorePatternRegex` (same file) is
      // PATH-SEGMENT based — it matches a pattern against ANY segment,
      // anywhere in the path — so it would also silently ignore a branch
      // literally named `objects` or `logs` (e.g. `refs/heads/objects`).
      // That is exactly the silent-false-negative class this repo bans; do
      // not reach for segment patterns here.
      //
      // Sanctioned direction if live measurement ever justifies it:
      // ROOT-ANCHORED PREFIX ignores — extend the `ignorePatterns` /
      // `WatchDirectoryOptions` mechanism so `objects/**` anchors at the
      // subscription root instead of matching any segment. Nothing like
      // that exists in `path-filter.ts` or `parcel-watchers.ts` today; it
      // would need to be built, not approximated with segment patterns.
      //
      // A claim removed while this resolves (sync() dropping or retrying the
      // common dir, or disposeAll()) is not disposed here: the remover joins
      // `sub.acquisition` and then retires `sub.dispose` itself.
      sub.dispose = await deps.watchDirectory(
        watchRoot,
        (changes) => handleChanges(commonDir, watchRoot, sub, changes),
        (signal) => handleSignal(commonDir, sub, signal),
        { ignorePatterns: [] }
      );
    } catch (error) {
      if (error instanceof ParcelWatchRetirementError) {
        // The timed-out subscribe was acquired late and its cleanup failed:
        // the native subscription is still owned, and the claim's remover
        // retries its retirement.
        sub.dispose = error.retire;
      }
      // Same stale-identity guard as the realpath catch above: only write
      // dead state if this Subscription is still the live claim.
      if (isStaleAttempt(commonDir, sub)) {
        return;
      }
      const message = `watcher setup failed: ${toErrorMessage(error)}`;
      sub.dead = true;
      sub.deadReason = message;
      logger.error('git inventory watcher setup rejected', { commonDir, error: message });
    }
  }

  /**
   * Removes `commonDir`'s claim and retires its native subscription. The
   * entry leaves the map only once the unsubscribe succeeds: a rejected
   * retirement is still owned, and the next call retries it, matching the
   * joined producer's retryable disposer. A call while one is in flight
   * joins it.
   */
  function disposeOne(commonDir: string): Promise<void> {
    const sub = subscriptions.get(commonDir);
    if (!sub) {
      return Promise.resolve();
    }
    sub.retiring = true;
    if (sub.timer) {
      clearTimeout(sub.timer);
      sub.timer = null;
    }
    if (sub.retirement) {
      return sub.retirement;
    }
    // A subscribe still in flight must not outlive its disposal: join it,
    // then retire whatever it acquired.
    const retirement = sub.acquisition.then(() => sub.dispose());
    sub.retirement = retirement;
    retirement.then(
      () => {
        subscriptions.delete(commonDir);
      },
      () => {
        sub.retirement = undefined;
      }
    );
    return retirement;
  }

  async function sync(commonDirs: readonly string[]): Promise<void> {
    const desired = new Set(commonDirs);
    const toDispose: string[] = [];
    const toSubscribe: string[] = [];

    for (const [commonDir, sub] of subscriptions) {
      if (!desired.has(commonDir)) {
        toDispose.push(commonDir);
      } else if (sub.dead || sub.retiring) {
        // Explicit-rebuild retry: dispose the dead (or still retiring) entry,
        // then resubscribe once its unsubscribe has succeeded.
        toDispose.push(commonDir);
        toSubscribe.push(commonDir);
      }
    }
    for (const commonDir of desired) {
      if (!subscriptions.has(commonDir)) {
        toSubscribe.push(commonDir);
      }
    }

    const retirements = await Promise.allSettled(
      toDispose.map((commonDir) => disposeOne(commonDir))
    );
    // A failed retirement keeps its entry, so subscribe() skips that common
    // dir; every other common dir is still subscribed before sync() rejects.
    await Promise.all(toSubscribe.map((commonDir) => subscribe(commonDir)));
    throwRetirementFailures(retirements);
  }

  async function disposeAll(): Promise<void> {
    disposed = true;
    throwRetirementFailures(
      await Promise.allSettled([...subscriptions.keys()].map((commonDir) => disposeOne(commonDir)))
    );
  }

  function getDeadCommonDirs(): ReadonlySet<string> {
    const dead = new Set<string>();
    for (const [commonDir, sub] of subscriptions) {
      if (sub.dead) {
        dead.add(commonDir);
      }
    }
    return dead;
  }

  function getHealthErrors(): readonly string[] {
    const errors: string[] = [];
    for (const [commonDir, sub] of subscriptions) {
      if (sub.dead) {
        errors.push(
          `git inventory: watcher for common dir "${commonDir}" failed and is not watching: ${sub.deadReason ?? 'unknown error'}`
        );
      }
    }
    return errors;
  }

  return { disposeAll, getDeadCommonDirs, getHealthErrors, sync };
}
