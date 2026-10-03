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
//   The unconditional excluded-path globs still feed the native layer: that
//   is the run-5189 overflow guard and those trees are deliberately not live.
//   DEFAULT_IGNORE_PATTERNS remain native by default. Only the concrete main
//   Explorer owner opts into `reportDefaultFilteredChanges` (BST-1180): that
//   one subscription broadens bounded `dist`, `build`, and `.DS_Store`
//   activity into root-relative boundary evidence for Git views while
//   Explorer/indexing keep detailed records filtered. High-cardinality
//   dependency/cache trees stay native-suppressed; lossless tracked-path
//   support there requires a separate Git-aware watcher architecture.
//   A per-subscription override (BST-1112) still REPLACES all default layers
//   for that non-Explorer caller, including its native ignore globs.
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '@brainstrike/logging';
import {
  isExcludedBackgroundIndexingPath,
  isUnconditionalExcludedNativePath,
  UNCONDITIONAL_EXCLUDED_PATH_IGNORE_GLOBS,
} from '@brainstrike/utils/background-indexing-policy';
import { buildIgnorePatternRegex, DEFAULT_IGNORE_PATTERNS } from '@brainstrike/utils/path-filter';
import type {
  DirectoryHandle,
  FileSystemChange,
  FileSystemWatchBatchMetadata,
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
const REPORTABLE_DEFAULT_FILTER_PATTERNS: ReadonlySet<string> = new Set([
  'dist',
  'build',
  '.DS_Store',
]);
const missingReportableDefaults = [...REPORTABLE_DEFAULT_FILTER_PATTERNS].filter(
  (pattern) => !DEFAULT_IGNORE_PATTERNS.includes(pattern)
);
if (missingReportableDefaults.length > 0) {
  throw new Error(
    `Reportable watcher filters must remain DEFAULT_IGNORE_PATTERNS entries: ${missingReportableDefaults.join(', ')}`
  );
}
/**
 * Keep dependency, cache, and Git-metadata trees out of the recursive native
 * subscription. Broadening these trees would make one Explorer root consume
 * an unbounded number of native descriptors/crawl entries.
 */
const BOUNDED_NATIVE_DEFAULT_IGNORE_PATTERNS = DEFAULT_IGNORE_PATTERNS.filter(
  (pattern) => !REPORTABLE_DEFAULT_FILTER_PATTERNS.has(pattern)
);
const BOUNDED_NATIVE_DEFAULT_IGNORE_PATTERN_SET: ReadonlySet<string> = new Set(
  BOUNDED_NATIVE_DEFAULT_IGNORE_PATTERNS
);

export const PARCEL_SUBSCRIBE_TIMEOUT_MS = 10_000;

export class ParcelSubscribeTimeoutError extends Error {
  readonly code = 'subscribe-timeout';

  constructor(path: string, timeoutMs: number) {
    super(`@parcel/watcher subscribe for ${path} timed out after ${timeoutMs}ms`);
    this.name = 'ParcelSubscribeTimeoutError';
  }
}

/** Failed late acquisition cleanup remains physically owned and retryable. */
export class ParcelWatchRetirementError extends AggregateError {
  constructor(
    errors: readonly unknown[],
    readonly retire: () => Promise<void>
  ) {
    super(errors, 'Parcel subscribe retirement failed.');
    this.name = 'ParcelWatchRetirementError';
  }
}

export interface StartParcelWatchOptions {
  /**
   * Per-subscription ignore override (BST-1112): when provided, REPLACES
   * DEFAULT_IGNORE_PATTERNS for THIS subscription only. Explicit overrides
   * apply at both the native and event-guard layers. `undefined` keeps the
   * legacy default native + JS filtering unless
   * `reportDefaultFilteredChanges` is explicitly true. `[]` means "ignore
   * nothing" — it does NOT fall back to the defaults.
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
  /**
   * Preserve bounded root-relative evidence for reportable default filters.
   * Default false: legacy consumers keep every default at the native boundary.
   * The desktop Explorer fs:watch owner is the sole production opt-in; even
   * there, high-cardinality dependency/cache defaults stay native-suppressed.
   * Mutually exclusive with every explicit `ignorePatterns` override,
   * including `[]`.
   */
  reportDefaultFilteredChanges?: boolean;
  /** Test seam: overrides PARCEL_SUBSCRIBE_TIMEOUT_MS. */
  subscribeTimeoutMs?: number;
}

export function assertValidParcelWatchFilterOptions(
  options: Pick<StartParcelWatchOptions, 'ignorePatterns' | 'reportDefaultFilteredChanges'>
): void {
  if (options.reportDefaultFilteredChanges && options.ignorePatterns !== undefined) {
    throw new Error(
      'reportDefaultFilteredChanges cannot be combined with an explicit ignorePatterns override.'
    );
  }
}

interface ParcelEvent {
  path: string;
  type: 'create' | 'delete' | 'update';
}

async function retireParcelSubscription(
  subscription: { unsubscribe(): Promise<void> },
  eventQueue: Promise<void>
): Promise<void> {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => subscription.unsubscribe()),
    eventQueue,
  ]);
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Parcel watch retirement failed.');
  }
}

function nativeIgnoreGlobs(patterns: readonly string[]): string[] {
  return patterns.flatMap((segment) => [`**/${segment}`, `**/${segment}/**`]);
}

async function startParcelWatchOwned(
  handle: DirectoryHandle,
  callback: (changes: FileSystemChange[], metadata?: FileSystemWatchBatchMetadata) => void,
  options: StartParcelWatchOptions,
  joinRetirement: boolean
): Promise<() => Promise<void>> {
  assertValidParcelWatchFilterOptions(options);
  const backend = selectParcelBackend();
  const timeoutMs = options.subscribeTimeoutMs ?? PARCEL_SUBSCRIBE_TIMEOUT_MS;
  const reportDefaultFilteredChanges = options.reportDefaultFilteredChanges ?? false;
  const ignorePatterns = options.ignorePatterns;
  // A provided array (including []) REPLACES the default at both native and
  // JS layers. Undefined uses the shared defaults; only the explicit report
  // option broadens bounded native delivery for Git freshness.
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

  const relativeEventPath = (eventPath: string): string | null => {
    if (eventPath === rootPath) {
      return '';
    }
    if (!eventPath.startsWith(rootPath + path.sep)) {
      return null;
    }
    return eventPath
      .slice(rootPath.length + 1)
      .split(path.sep)
      .join('/');
  };

  // Root-RELATIVE exclusion, reusing the index-side predicate: a subscription
  // root deliberately opened INSIDE an excluded tree (a worktree copy as the
  // workspace root — Explorer visibility of worktrees is pinned product
  // behavior) must watch normally; only a nested excluded tree under the
  // root is silenced. An absolute-path match here would drop EVERY event for
  // such roots — the silent-total-failure class git-inventory-watcher.ts
  // documents for a subscription rooted at `.git`.
  const rootInsideExcludedTree = isUnconditionalExcludedNativePath(rootPath);
  const isExcludedEventPath = (relativePath: string | null): boolean => {
    if (rootInsideExcludedTree || relativePath === null) {
      return false;
    }
    return isExcludedBackgroundIndexingPath(relativePath);
  };
  type EventDisposition =
    | { boundary: string; kind: 'default-filtered' }
    | { kind: 'silenced' | 'visible' };
  const classifyEventPath = (eventPath: string): EventDisposition => {
    const relativePath = relativeEventPath(eventPath);
    if (ignoreRegex) {
      return {
        kind: relativePath !== null && ignoreRegex.test(relativePath) ? 'silenced' : 'visible',
      };
    }
    if (isExcludedEventPath(relativePath)) {
      return { kind: 'silenced' };
    }
    if (relativePath === null || relativePath.length === 0) {
      return { kind: 'visible' };
    }
    const segments = relativePath.split('/');
    if (segments.some((segment) => BOUNDED_NATIVE_DEFAULT_IGNORE_PATTERN_SET.has(segment))) {
      return { kind: 'silenced' };
    }
    const matchedSegmentIndex = segments.findIndex((segment) =>
      REPORTABLE_DEFAULT_FILTER_PATTERNS.has(segment)
    );
    if (matchedSegmentIndex === -1) {
      return { kind: 'visible' };
    }
    const matchedPattern = segments[matchedSegmentIndex];
    if (
      reportDefaultFilteredChanges &&
      matchedPattern !== undefined &&
      REPORTABLE_DEFAULT_FILTER_PATTERNS.has(matchedPattern)
    ) {
      return {
        boundary: segments.slice(0, matchedSegmentIndex + 1).join('/'),
        kind: 'default-filtered',
      };
    }
    return { kind: 'silenced' };
  };

  const processEvent = async (event: ParcelEvent, eventPath: string): Promise<void> => {
    if (stopped) {
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
      const eventPath = rerootEventPath(event.path);
      const disposition = classifyEventPath(eventPath);
      if (disposition.kind === 'default-filtered') {
        batcher.markFilteredChangeBoundary(disposition.boundary);
        continue;
      }
      if (disposition.kind === 'silenced') {
        continue;
      }
      eventQueue = eventQueue
        .then(() => processEvent(event, eventPath))
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
    // Explicit overrides still agree with `ignoreRegex` exactly. Legacy
    // default consumers retain DEFAULT_IGNORE_PATTERNS natively. The opted-in
    // Explorer owner broadens only bounded output defaults. Parcel matches
    // glob patterns against paths RELATIVE to the watched root, so an ancestor
    // segment named build/dist/node_modules cannot swallow the subscription.
    ignore:
      ignorePatterns === undefined
        ? [
            ...nativeIgnoreGlobs(
              reportDefaultFilteredChanges
                ? BOUNDED_NATIVE_DEFAULT_IGNORE_PATTERNS
                : DEFAULT_IGNORE_PATTERNS
            ),
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
  ]).catch(async (error: unknown) => {
    stopped = true;
    batcher.dispose();
    transitionHealth('failed', {
      code: timedOut ? 'subscribe-timeout' : 'subscribe-failed',
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
      terminal: false,
    });
    if (timedOut) {
      if (!joinRetirement) {
        subscribePromise
          .then(
            (late) => retireParcelSubscription(late, eventQueue),
            () => eventQueue
          )
          .catch(() => undefined);
        throw error;
      }
      // A rejected acquisition owns no subscription. Join admitted event work
      // and preserve both startup failures without inventing an unsubscribe retry.
      const acquisition = await subscribePromise.then(
        (late) => ({ status: 'acquired' as const, subscription: late }),
        (acquisitionError: unknown) => ({ error: acquisitionError, status: 'failed' as const })
      );
      if (acquisition.status === 'failed') {
        const results = await Promise.allSettled([eventQueue]);
        const failures = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : []
        );
        throw new AggregateError(
          [error, acquisition.error, ...failures],
          'Parcel subscription acquisition failed after timeout.'
        );
      }
      // An acquired subscription remains owned until actual unsubscribe succeeds.
      let cleanup: Promise<void> | undefined;
      const retire = (): Promise<void> => {
        cleanup ??= retireParcelSubscription(acquisition.subscription, eventQueue);
        cleanup.catch(() => {
          cleanup = undefined;
        });
        return cleanup;
      };
      try {
        await retire();
      } catch (cleanupError) {
        throw new ParcelWatchRetirementError([error, cleanupError], retire);
      }
    } else if (joinRetirement) {
      await eventQueue;
    }
    throw error;
  });

  logger.info('Started parcel watcher', {
    backend,
    path: handle.path,
    platform: process.platform,
  });
  transitionHealth('healthy');

  let retiring: Promise<void> | undefined;
  return () => {
    if (retiring) {
      return retiring;
    }
    if (!stopped) {
      stopped = true;
      transitionHealth('stopped');
      batcher.dispose();
    }
    retiring = retireParcelSubscription(subscription, eventQueue);
    retiring.catch(() => {
      retiring = undefined;
    });
    return retiring;
  };
}

/** Existing producer with physical unsubscribe/event-stat retirement acknowledgment. */
export function startJoinedParcelWatch(
  handle: DirectoryHandle,
  callback: (changes: FileSystemChange[], metadata?: FileSystemWatchBatchMetadata) => void,
  options: StartParcelWatchOptions = {}
): Promise<() => Promise<void>> {
  return startParcelWatchOwned(handle, callback, options, true);
}

/** Preserve the legacy void disposer contract for existing Explorer callers. */
export async function startParcelWatch(
  handle: DirectoryHandle,
  callback: (changes: FileSystemChange[], metadata?: FileSystemWatchBatchMetadata) => void,
  options: StartParcelWatchOptions = {}
): Promise<() => void> {
  const retire = await startParcelWatchOwned(handle, callback, options, false);
  return () => {
    retire().catch((error: unknown) => {
      logger.error('Failed to unsubscribe parcel watcher', { error, path: handle.path });
    });
  };
}
