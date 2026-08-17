// BST-568: @parcel/watcher-backed watch engine behind the existing
// `watchDirectory(handle, cb) => disposer` contract.
//
// Invariants (docs/agents/research/bst-568-parcel-watcher-spike.md):
// - One native subscription per root; subscribe is bounded by a timeout and a
//   late-resolving subscription after timeout/dispose is unsubscribed, never
//   leaked.
// - Backend callback errors (e.g. FSEvents "events were dropped") degrade to
//   a root-level invalidation (`directory`/`modified` on the root) with ONE
//   structured log per subscription — the subscription itself stays alive.
// - Normalization reuses the safe-invalidation idiom: any removed or
//   unstat-able path becomes `directory`/`removed`, which invalidates the
//   same-path record plus stale descendants without a full-tree rescan.
// - The DEFAULT ignore check is `fileFilter.shouldIgnorePath` PLUS the
//   background-indexing policy's unconditional excluded-path prefixes
//   (`.claude/worktrees`, BST-1342): trees no consumer may ever index also
//   never emit watch events, because worktree churn flooding FSEvents is what
//   drove the run-5189 overflow → full-refresh → DB-saturation failure
//   (2026-08-17). The prefix check is ROOT-RELATIVE (relativize, then reuse
//   the index-side predicate) and gated on the subscription root: a root
//   deliberately opened inside an excluded tree watches normally.
//   DEFAULT_IGNORE_PATTERNS and (for roots outside excluded trees) the
//   excluded-path globs also feed native-level ignore globs purely as a
//   resource saving (same rules, no broadening). Both clauses are
//   conditional on `options.ignorePatterns` being unset: a per-subscription
//   override (BST-1112) REPLACES all default layers for that subscription —
//   its own regex stands in for the default check, and its own native globs
//   may be broader or narrower than the defaults (the git-inventory
//   watcher's `ignorePatterns: []` relies on this to keep seeing worktree
//   git metadata).
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '@brainstrike/logging';
import {
  isExcludedBackgroundIndexingPath,
  isUnconditionalExcludedNativePath,
  UNCONDITIONAL_EXCLUDED_PATH_IGNORE_GLOBS,
} from '@brainstrike/utils/background-indexing-policy';
import {
  buildIgnorePatternRegex,
  DEFAULT_IGNORE_PATTERNS,
  fileFilter,
} from '@brainstrike/utils/path-filter';
import type {
  DirectoryHandle,
  FileSystemChange,
  WatcherFailure,
  WatcherHealthState,
  WatcherHealthTransition,
} from '../types.js';
import { createFileSystemChangeBatcher } from './electron-watchers.js';
import {
  loadParcelWatcher,
  type ParcelWatcherModule,
  selectParcelBackend,
} from './parcel-backend.js';

const logger = createLogger('ParcelWatchers');

export const PARCEL_SUBSCRIBE_TIMEOUT_MS = 10_000;

export class ParcelSubscribeTimeoutError extends Error {
  readonly code = 'subscribe-timeout';

  constructor(path: string, timeoutMs: number) {
    super(`@parcel/watcher subscribe for ${path} timed out after ${timeoutMs}ms`);
    this.name = 'ParcelSubscribeTimeoutError';
  }
}

export interface StartParcelWatchOptions {
  /**
   * Per-subscription ignore override (BST-1112): when provided, REPLACES
   * DEFAULT_IGNORE_PATTERNS for THIS subscription only — both the native
   * ignore globs passed to `module.subscribe` and the `shouldIgnorePath`
   * guard applied to every event. `undefined` (the default) keeps the
   * default patterns unchanged. `[]` means "ignore nothing" — it does NOT
   * fall back to the defaults.
   */
  ignorePatterns?: readonly string[] | undefined;
  /** Test seam: overrides the lazy binding load. */
  loadModule?: () => Promise<ParcelWatcherModule>;
  /**
   * Receives typed health transitions, exactly once per state CHANGE:
   * starting -> healthy | failed; healthy <-> degraded per backend-error
   * episode (a clean batch recovers degraded to healthy); stopped once.
   */
  onHealth?: (event: WatcherHealthTransition) => void;
  /** Test seam: overrides PARCEL_SUBSCRIBE_TIMEOUT_MS. */
  subscribeTimeoutMs?: number;
}

interface ParcelEvent {
  path: string;
  type: 'create' | 'delete' | 'update';
}

function nativeIgnoreGlobs(patterns: readonly string[]): string[] {
  return patterns.flatMap((segment) => [`**/${segment}`, `**/${segment}/**`]);
}

export async function startParcelWatch(
  handle: DirectoryHandle,
  callback: (changes: FileSystemChange[]) => void,
  options: StartParcelWatchOptions = {}
): Promise<() => void> {
  const backend = selectParcelBackend();
  const timeoutMs = options.subscribeTimeoutMs ?? PARCEL_SUBSCRIBE_TIMEOUT_MS;
  // undefined -> shared default patterns/regex (unchanged behavior); a
  // provided array (including []) REPLACES the default at both layers.
  const ignorePatterns = options.ignorePatterns;
  const ignoreRegex = ignorePatterns === undefined ? null : buildIgnorePatternRegex(ignorePatterns);

  // Health transitions fire exactly once per state change; a repeated cause
  // (e.g. an FSEvents error storm) cannot re-emit the same state.
  let healthState: WatcherHealthState | null = null;
  const transitionHealth = (state: WatcherHealthState, failure?: WatcherFailure): void => {
    if (healthState === state) {
      return;
    }
    healthState = state;
    options.onHealth?.({
      backend,
      ...(failure ? { failure } : {}),
      state,
      timestamp: Date.now(),
    });
  };

  transitionHealth('starting');

  let module: ParcelWatcherModule;
  try {
    module = await (options.loadModule ?? loadParcelWatcher)();
  } catch (error) {
    transitionHealth('failed', {
      code: 'binding-load-failed',
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
      terminal: true,
    });
    throw error;
  }

  const batcher = createFileSystemChangeBatcher(callback);
  let stopped = false;
  let loggedBackendError = false;

  // Backends report kernel realpaths (macOS tmp: /var -> /private/var), but
  // every consumer matches change paths against the handle-rooted prefix —
  // the legacy engine emitted handle-rooted paths by construction. Translate.
  // Root paths are normalized without a trailing separator so re-rooted
  // children can never gain a doubled separator.
  const rootPath =
    handle.path.length > 1 && handle.path.endsWith(path.sep)
      ? handle.path.slice(0, -1)
      : handle.path;
  let realRoot = rootPath;
  try {
    realRoot = await fs.promises.realpath(rootPath);
  } catch {
    // Root vanished between caller stat and watch start; subscribe below
    // will surface the real failure.
  }
  const rerootEventPath = (eventPath: string): string => {
    if (realRoot === rootPath) {
      return eventPath;
    }
    if (eventPath === realRoot) {
      return rootPath;
    }
    if (eventPath.startsWith(realRoot + path.sep)) {
      return rootPath + eventPath.slice(realRoot.length);
    }
    return eventPath;
  };

  // Root-RELATIVE exclusion, reusing the index-side predicate: a subscription
  // root deliberately opened INSIDE an excluded tree (a worktree copy as the
  // workspace root — Explorer visibility of worktrees is pinned product
  // behavior) must watch normally; only a nested excluded tree under the
  // root is silenced. An absolute-path match here would drop EVERY event for
  // such roots — the silent-total-failure class git-inventory-watcher.ts
  // documents for a subscription rooted at `.git`.
  const rootInsideExcludedTree = isUnconditionalExcludedNativePath(rootPath);
  const isExcludedEventPath = (eventPath: string): boolean => {
    if (rootInsideExcludedTree || !eventPath.startsWith(rootPath + path.sep)) {
      return false;
    }
    const relativePath = eventPath
      .slice(rootPath.length + 1)
      .split(path.sep)
      .join('/');
    return isExcludedBackgroundIndexingPath(relativePath);
  };
  const shouldIgnore = (eventPath: string): boolean =>
    ignoreRegex
      ? ignoreRegex.test(eventPath)
      : fileFilter.shouldIgnorePath(eventPath) || isExcludedEventPath(eventPath);

  const processEvent = async (event: ParcelEvent): Promise<void> => {
    const eventPath = rerootEventPath(event.path);
    if (shouldIgnore(eventPath)) {
      return;
    }
    if (event.type === 'delete') {
      // The path is gone; kind is unknowable. Directory removal is the safe
      // invalidation shape (same-path record plus stale descendants).
      batcher.enqueue({ kind: 'directory', path: eventPath, type: 'removed' });
      return;
    }
    try {
      const stat = await fs.promises.stat(eventPath);
      batcher.enqueue({
        kind: stat.isDirectory() ? 'directory' : 'file',
        path: eventPath,
        type: event.type === 'create' ? 'added' : 'modified',
      });
    } catch {
      if (event.type === 'create') {
        batcher.enqueue({
          kind: 'directory',
          path: eventPath,
          type: 'removed',
        });
      }
      // An update for a vanished path emits nothing: parcel delivers the
      // delete event separately.
    }
  };

  // Serialize async stat ordering exactly like the native fs.watch engine.
  let eventQueue = Promise.resolve();
  const handleBackendCallback = (error: Error | null, events: ParcelEvent[]): void => {
    if (stopped) {
      return;
    }
    if (error) {
      // Backend-level failure without per-path attribution (FSEvents drop,
      // inotify overflow). Root invalidation forces consumers to re-enumerate
      // the root; the subscription stays alive. Log once per subscription so
      // an error storm cannot loop the logger.
      if (!loggedBackendError) {
        loggedBackendError = true;
        logger.error('Parcel watcher backend error; root invalidated', {
          backend,
          errorMessage: error.message,
          path: handle.path,
        });
      }
      transitionHealth('degraded', {
        code: 'backend-error',
        message: error.message,
        retryable: true,
        terminal: false,
      });
      // ROOT-INVALIDATION SENTINEL: type 'added' on the root path, NOT
      // 'modified'. The Explorer refresh consumer deliberately skips
      // 'modified' as content-only (use-file-tree-refresh-events.ts), while a
      // root-path membership change triggers a full root re-enumeration —
      // exactly what "file system must be re-scanned" requires. The indexer
      // path-scopes either type identically (mtime+hash skip keeps it cheap).
      batcher.enqueue({ kind: 'directory', path: handle.path, type: 'added' });
      return;
    }
    if (healthState === 'degraded') {
      // The backend recovered: a clean batch after a degraded episode returns
      // the watch to healthy (PR #1774 review — degraded must not be sticky
      // for the chip). Resetting the log-once flag keeps "one structured log
      // per degradation EPISODE": the next distinct storm logs again.
      loggedBackendError = false;
      transitionHealth('healthy');
    }
    for (const event of events) {
      eventQueue = eventQueue
        .then(() => processEvent(event))
        .catch((processError: unknown) => {
          logger.error('Parcel watcher event processing failed', {
            error: processError,
            path: handle.path,
          });
        });
    }
  };

  const subscribePromise = module.subscribe(handle.path, handleBackendCallback, {
    backend,
    // Must agree with the `ignoreRegex` derivation above — same
    // `=== undefined` selector, literally, not by accident (undefined ->
    // default patterns, defined -> override REPLACES defaults); that
    // agreement is the whole per-subscription-override feature. Parcel
    // matches ignore globs against ABSOLUTE event paths, so the
    // excluded-path globs are omitted when the root itself sits inside an
    // excluded tree: they would otherwise swallow the whole subscription at
    // the native layer.
    ignore:
      ignorePatterns === undefined
        ? [
            ...nativeIgnoreGlobs(DEFAULT_IGNORE_PATTERNS),
            ...(rootInsideExcludedTree ? [] : UNCONDITIONAL_EXCLUDED_PATH_IGNORE_GLOBS),
          ]
        : nativeIgnoreGlobs(ignorePatterns),
  });

  let timedOut = false;
  const subscription = await Promise.race([
    subscribePromise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        timedOut = true;
        reject(new ParcelSubscribeTimeoutError(handle.path, timeoutMs));
      }, timeoutMs);
      // Cancel the timer on either outcome of the real subscribe so a
      // completed watch never holds a live timer.
      subscribePromise.then(
        () => clearTimeout(timer),
        () => clearTimeout(timer)
      );
    }),
  ]).catch((error: unknown) => {
    batcher.dispose();
    if (timedOut) {
      // Late-resolution cleanup: if the hung subscribe eventually resolves,
      // release it instead of leaking a live native subscription.
      subscribePromise.then((late) => late.unsubscribe()).catch(() => undefined);
    }
    transitionHealth('failed', {
      code: timedOut ? 'subscribe-timeout' : 'subscribe-failed',
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
      terminal: false,
    });
    throw error;
  });

  logger.info('Started parcel watcher', {
    backend,
    path: handle.path,
    platform: process.platform,
  });
  transitionHealth('healthy');

  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    transitionHealth('stopped');
    batcher.dispose();
    subscription.unsubscribe().catch((error: unknown) => {
      logger.error('Failed to unsubscribe parcel watcher', {
        error,
        path: handle.path,
      });
    });
  };
}
