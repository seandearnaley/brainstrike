// Recursive root watch engine on Node's own `fs.watch` (libuv), behind the
// `watchDirectory(handle, cb) => disposer` contract.
//
// Why not @parcel/watcher: its Windows backend destroyed a subscription on a
// libuv pool thread while the backend thread's ReadDirectoryChangesW was still
// pending on memory inside it, so every unsubscribe could hand freed memory to
// the kernel and to the completion APC (EXCEPTION_ACCESS_VIOLATION in Electron
// Main). libuv issues, completes and closes the read on the event-loop thread
// and frees nothing until the close completes, so `watcher.close()` is the
// whole retirement: no native thread outlives it.
//
// Invariants:
// - One `fs.watch` per root. `fs.watch` arms synchronously: once it returns the
//   watch is live; a missing root throws, which is the `failed` health
//   transition and a rejected start (visible to the caller), never a crash.
// - The ignore predicate is passed to `fs.watch` itself, so on Linux (Node's
//   userland per-directory inotify walk) an ignored tree is never walked or
//   watched, and on macOS/Windows its events never reach JS. The JS event guard
//   classifies every delivered path again with the same rules.
// - Normalization reuses the safe-invalidation idiom: any removed or
//   unstat-able path becomes `directory`/`removed`, which invalidates the
//   same-path record plus stale descendants without a full-tree rescan.
// - A dropped-events report (libuv delivers a change with no filename when the
//   OS buffer overflowed) degrades health and invalidates the root; the next
//   clean batch recovers to healthy. A watcher `error` ends the OS watch, so it
//   is the `failed` transition plus a root invalidation; recovery is the
//   owner's manual retry.
// - The DEFAULT ignore check is `fileFilter.shouldIgnorePath` PLUS the
//   background-indexing policy's unconditional excluded-path prefixes
//   (`.claude/worktrees`, BST-1342): trees no consumer may ever index also
//   never emit watch events, because worktree churn flooding the OS watcher is
//   what drove the run-5189 overflow → full-refresh → DB-saturation failure
//   (2026-08-17). The prefix check is ROOT-RELATIVE and gated on the
//   subscription root: a root deliberately opened inside an excluded tree
//   watches normally. Nested excluded trees stay ignored at the watch itself.
//   DEFAULT_IGNORE_PATTERNS stay ignored at the watch by default. Only the
//   concrete main Explorer owner opts into `reportDefaultFilteredChanges`
//   (BST-1180): that one subscription broadens bounded `dist`, `build`, and
//   `.DS_Store` activity into root-relative boundary evidence for Git views
//   while Explorer/indexing keep detailed records filtered. High-cardinality
//   dependency/cache trees stay ignored at the watch.
//   A per-subscription override (BST-1112) still REPLACES all default layers
//   for that non-Explorer caller, including the watch-level ignore.
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '@brainstrike/logging';
import {
  isExcludedBackgroundIndexingPath,
  isUnconditionalExcludedNativePath,
} from '@brainstrike/utils/background-indexing-policy';
import { buildIgnorePatternRegex, DEFAULT_IGNORE_PATTERNS } from '@brainstrike/utils/path-filter';
import type {
  DirectoryHandle,
  FileSystemChange,
  FileSystemWatchBatchMetadata,
  WatcherBackendKind,
  WatcherFailure,
  WatcherHealthState,
  WatcherHealthTransition,
} from '../types.ts';
import { createFileSystemChangeBatcher } from './electron-watchers.ts';

const logger = createLogger('RootWatchers');
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
 * Keep dependency, cache, and Git-metadata trees out of the recursive watch.
 * Broadening these trees would make one Explorer root consume an unbounded
 * number of inotify watches (Linux) and OS events (every platform).
 */
const BOUNDED_NATIVE_DEFAULT_IGNORE_PATTERN_SET: ReadonlySet<string> = new Set(
  DEFAULT_IGNORE_PATTERNS.filter((pattern) => !REPORTABLE_DEFAULT_FILTER_PATTERNS.has(pattern))
);

/**
 * The OS mechanism Node's recursive `fs.watch` runs on, reported in health
 * transitions for diagnostics: FSEvents (macOS), inotify (Linux) and
 * ReadDirectoryChangesW (Windows).
 */
const BACKEND_BY_PLATFORM: Partial<Record<NodeJS.Platform, WatcherBackendKind>> = {
  darwin: 'fs-events',
  linux: 'inotify',
  win32: 'windows',
};

function watchBackend(platform: NodeJS.Platform = process.platform): WatcherBackendKind {
  const backend = BACKEND_BY_PLATFORM[platform];
  if (!backend) {
    throw new Error(`No recursive file watcher for platform ${platform}`);
  }
  return backend;
}

/** A watch owner's failed retirement of an acquired subscription: still owned, and retryable. */
export class ParcelWatchRetirementError extends AggregateError {
  readonly retire: () => Promise<void>;

  constructor(errors: readonly unknown[], retire: () => Promise<void>) {
    super(errors, 'Root watch retirement failed.');
    this.retire = retire;
    this.name = 'ParcelWatchRetirementError';
  }
}

/** The part of `fs.FSWatcher` the engine uses. */
export interface RootWatchHandle {
  close(): void;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

/** `fs.watch` as the engine calls it: recursive, UTF-8 names, an ignore predicate. */
export type RootWatchFunction = (
  directory: string,
  options: { readonly ignore: (relativePath: string) => boolean },
  listener: (eventType: fs.WatchEventType, filename: string | null) => void
) => RootWatchHandle;

const watchRecursively: RootWatchFunction = (directory, options, listener) =>
  fs.watch(directory, { encoding: 'utf8', ignore: options.ignore, recursive: true }, listener);

export interface StartParcelWatchOptions {
  /**
   * E2E seam: awaited before the watch starts, so a test can make it as slow
   * as a loaded machine (Main's `parcel-subscribe` lifecycle delay).
   */
  beforeSubscribe?: () => Promise<void>;
  /**
   * Per-subscription ignore override (BST-1112): when provided, REPLACES
   * DEFAULT_IGNORE_PATTERNS for THIS subscription only. Explicit overrides
   * apply at both the watch and event-guard layers. `undefined` keeps the
   * default watch + JS filtering unless `reportDefaultFilteredChanges` is
   * explicitly true. `[]` means "ignore nothing" — it does NOT fall back to
   * the defaults.
   */
  ignorePatterns?: readonly string[] | undefined;
  /**
   * Receives typed health transitions on state or failure-class change:
   * starting -> healthy | failed; healthy <-> degraded per dropped-events
   * episode (a clean batch recovers degraded to healthy); failed when the OS
   * watch ends with an error; stopped once.
   */
  onHealth?: (event: WatcherHealthTransition) => void;
  /**
   * Preserve bounded root-relative evidence for reportable default filters.
   * Default false: legacy consumers keep every default at the watch boundary.
   * The desktop Explorer fs:watch owner is the sole production opt-in; even
   * there, high-cardinality dependency/cache defaults stay ignored.
   * Mutually exclusive with every explicit `ignorePatterns` override,
   * including `[]`.
   */
  reportDefaultFilteredChanges?: boolean;
  /** Test seam: replaces Node's recursive `fs.watch`. */
  watch?: RootWatchFunction;
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

async function startRootWatch(
  handle: DirectoryHandle,
  callback: (changes: FileSystemChange[], metadata?: FileSystemWatchBatchMetadata) => void,
  options: StartParcelWatchOptions
): Promise<() => Promise<void>> {
  assertValidParcelWatchFilterOptions(options);
  const backend = watchBackend();
  const reportDefaultFilteredChanges = options.reportDefaultFilteredChanges ?? false;
  const ignorePatterns = options.ignorePatterns;
  // A provided array (including []) REPLACES the default at both the watch
  // and JS layers. Undefined uses the shared defaults; only the explicit report
  // option broadens bounded delivery for Git freshness.
  const ignoreRegex = ignorePatterns === undefined ? null : buildIgnorePatternRegex(ignorePatterns);

  // Health transitions fire on state or failure-class change; a repeated cause
  // (e.g. an overflow storm) cannot re-emit the same classification.
  let healthState: WatcherHealthState | null = null;
  let healthFailureCode: string | undefined;
  const transitionHealth = (state: WatcherHealthState, failure?: WatcherFailure): void => {
    if (healthState === state && healthFailureCode === failure?.code) {
      return;
    }
    healthState = state;
    healthFailureCode = failure?.code;
    options.onHealth?.({
      backend,
      ...(failure ? { failure } : {}),
      state,
      timestamp: Date.now(),
    });
  };

  transitionHealth('starting');

  // Consumers match change paths against the handle-rooted prefix; `fs.watch`
  // reports names relative to the watched directory, so events are joined onto
  // the handle path as given. Root paths are normalized without a trailing
  // separator so joined children can never gain a doubled separator.
  const rootPath =
    handle.path.length > 1 && handle.path.endsWith(path.sep)
      ? handle.path.slice(0, -1)
      : handle.path;

  const toRelativePosix = (relativePath: string): string => relativePath.split(path.sep).join('/');

  // Root-RELATIVE exclusion, reusing the index-side predicate: a subscription
  // root deliberately opened INSIDE an excluded tree (a worktree copy as the
  // workspace root — Explorer visibility of worktrees is pinned product
  // behavior) must watch normally; only a nested excluded tree under the root
  // is silenced. An absolute-path match here would drop EVERY event for such
  // roots — the silent-total-failure class git-inventory-watcher.ts documents
  // for a subscription rooted at `.git`.
  const rootInsideExcludedTree = isUnconditionalExcludedNativePath(rootPath);
  type EventDisposition =
    | { boundary: string; kind: 'default-filtered' }
    | { kind: 'silenced' | 'visible' };
  const classifyRelativePath = (relativePath: string): EventDisposition => {
    if (ignoreRegex) {
      return { kind: ignoreRegex.test(relativePath) ? 'silenced' : 'visible' };
    }
    if (!rootInsideExcludedTree && isExcludedBackgroundIndexingPath(relativePath)) {
      return { kind: 'silenced' };
    }
    if (relativePath.length === 0) {
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
    if (reportDefaultFilteredChanges) {
      return {
        boundary: segments.slice(0, matchedSegmentIndex + 1).join('/'),
        kind: 'default-filtered',
      };
    }
    return { kind: 'silenced' };
  };
  // Watch-level ignore: everything the event guard would silence, plus a
  // nested unconditional excluded tree (`a/.claude/worktrees`), which the
  // root-relative guard leaves to this layer.
  const ignoredByWatch = (relativeNativePath: string): boolean => {
    const relativePath = toRelativePosix(relativeNativePath);
    if (classifyRelativePath(relativePath).kind === 'silenced') {
      return true;
    }
    return (
      ignoreRegex === null &&
      !rootInsideExcludedTree &&
      isUnconditionalExcludedNativePath(relativePath)
    );
  };

  const batcher = createFileSystemChangeBatcher(callback);
  let stopped = false;

  const processEvent = async (eventType: fs.WatchEventType, eventPath: string): Promise<void> => {
    if (stopped) {
      return;
    }
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(eventPath);
    } catch {
      // The path is gone; kind is unknowable. Directory removal is the safe
      // invalidation shape (same-path record plus stale descendants).
      batcher.enqueue({ kind: 'directory', path: eventPath, type: 'removed' });
      return;
    }
    batcher.enqueue({
      kind: stat.isDirectory() ? 'directory' : 'file',
      path: eventPath,
      // A rename that leaves the path present is a membership change.
      type: eventType === 'rename' ? 'added' : 'modified',
    });
  };

  // ROOT-INVALIDATION SENTINEL: type 'added' on the root path, NOT 'modified'.
  // The Explorer refresh consumer deliberately skips 'modified' as
  // content-only (use-file-tree-refresh-events.ts), while a root-path
  // membership change triggers a full root re-enumeration — exactly what lost
  // events require. The indexer path-scopes either type identically.
  const invalidateRoot = (): void => {
    batcher.enqueue({ kind: 'directory', path: handle.path, type: 'added' });
  };

  // Serialize async stat ordering so a batch keeps the OS's event order.
  let eventQueue = Promise.resolve();
  const onWatchEvent = (eventType: fs.WatchEventType, filename: string | null): void => {
    if (stopped) {
      return;
    }
    if (filename === null) {
      transitionHealth('degraded', {
        code: 'rescan-required',
        message: 'The file system watcher dropped events; the root must be re-scanned.',
        retryable: true,
        terminal: false,
      });
      logger.warn('Root watcher events lost; root rescan required', {
        backend,
        path: handle.path,
      });
      invalidateRoot();
      return;
    }
    if (healthState === 'degraded') {
      // A clean event after a dropped-events episode returns the watch to
      // healthy (PR #1774 review — degraded must not be sticky for the chip).
      transitionHealth('healthy');
    }
    const relativePath = toRelativePosix(filename);
    const disposition = classifyRelativePath(relativePath);
    if (disposition.kind === 'default-filtered') {
      batcher.markFilteredChangeBoundary(disposition.boundary);
      return;
    }
    if (disposition.kind === 'silenced') {
      return;
    }
    const eventPath = relativePath.length === 0 ? rootPath : path.join(rootPath, filename);
    eventQueue = eventQueue
      .then(() => processEvent(eventType, eventPath))
      .catch((processError: unknown) => {
        logger.error('Root watcher event processing failed', {
          error: processError,
          path: handle.path,
        });
      });
  };

  let watcher: RootWatchHandle;
  try {
    if (options.beforeSubscribe) {
      await options.beforeSubscribe();
    }
    watcher = (options.watch ?? watchRecursively)(
      rootPath,
      { ignore: ignoredByWatch },
      onWatchEvent
    );
  } catch (error) {
    stopped = true;
    batcher.dispose();
    transitionHealth('failed', {
      code: 'subscribe-failed',
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
      terminal: false,
    });
    throw error;
  }
  // The OS watch has ended (its handle is already closed). Without this
  // listener the 'error' event would throw in the owning process.
  watcher.on('error', (error) => {
    if (stopped) {
      return;
    }
    logger.error('Root watcher ended with an error; root invalidated', {
      backend,
      errorMessage: error.message,
      path: handle.path,
    });
    transitionHealth('failed', {
      code: 'backend-error',
      message: error.message,
      retryable: true,
      terminal: false,
    });
    invalidateRoot();
  });

  logger.info('Started root watcher', {
    backend,
    path: handle.path,
    platform: process.platform,
  });
  transitionHealth('healthy');

  let retiring: Promise<void> | undefined;
  return () => {
    if (!retiring) {
      stopped = true;
      watcher.close();
      transitionHealth('stopped');
      batcher.dispose();
      retiring = eventQueue;
    }
    return retiring;
  };
}

/** Starts a root watch; its disposer closes the watch and settles once queued event stats have. */
export function startJoinedParcelWatch(
  handle: DirectoryHandle,
  callback: (changes: FileSystemChange[], metadata?: FileSystemWatchBatchMetadata) => void,
  options: StartParcelWatchOptions = {}
): Promise<() => Promise<void>> {
  return startRootWatch(handle, callback, options);
}

/** Preserve the legacy void disposer contract for existing Explorer callers. */
export async function startParcelWatch(
  handle: DirectoryHandle,
  callback: (changes: FileSystemChange[], metadata?: FileSystemWatchBatchMetadata) => void,
  options: StartParcelWatchOptions = {}
): Promise<() => void> {
  const retire = await startRootWatch(handle, callback, options);
  return () => {
    retire().catch((error: unknown) => {
      logger.error('Failed to close root watcher', { error, path: handle.path });
    });
  };
}
