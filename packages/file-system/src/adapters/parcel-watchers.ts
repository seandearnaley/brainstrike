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
// - `fileFilter.shouldIgnorePath` stays the authoritative ignore check;
//   DEFAULT_IGNORE_PATTERNS also feed native-level ignore globs purely as a
//   resource saving (same names, no broadening).
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '@brainstrike/utils';
import { DEFAULT_IGNORE_PATTERNS, fileFilter } from '@brainstrike/utils/path-filter';
import type { DirectoryHandle, FileSystemChange } from '../types';
import { createFileSystemChangeBatcher } from './electron-watchers';
import { loadParcelWatcher, type ParcelWatcherModule, selectParcelBackend } from './parcel-backend';

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
  /** Test seam: overrides the lazy binding load. */
  loadModule?: () => Promise<ParcelWatcherModule>;
  /** Test seam: overrides PARCEL_SUBSCRIBE_TIMEOUT_MS. */
  subscribeTimeoutMs?: number;
}

interface ParcelEvent {
  path: string;
  type: 'create' | 'delete' | 'update';
}

function nativeIgnoreGlobs(): string[] {
  return DEFAULT_IGNORE_PATTERNS.flatMap((segment) => [`**/${segment}`, `**/${segment}/**`]);
}

export async function startParcelWatch(
  handle: DirectoryHandle,
  callback: (changes: FileSystemChange[]) => void,
  options: StartParcelWatchOptions = {}
): Promise<() => void> {
  const backend = selectParcelBackend();
  const timeoutMs = options.subscribeTimeoutMs ?? PARCEL_SUBSCRIBE_TIMEOUT_MS;
  const module = await (options.loadModule ?? loadParcelWatcher)();

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

  const processEvent = async (event: ParcelEvent): Promise<void> => {
    const eventPath = rerootEventPath(event.path);
    if (fileFilter.shouldIgnorePath(eventPath)) {
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
      // ROOT-INVALIDATION SENTINEL: type 'added' on the root path, NOT
      // 'modified'. The Explorer refresh consumer deliberately skips
      // 'modified' as content-only (use-file-tree-refresh-events.ts), while a
      // root-path membership change triggers a full root re-enumeration —
      // exactly what "file system must be re-scanned" requires. The indexer
      // path-scopes either type identically (mtime+hash skip keeps it cheap).
      batcher.enqueue({ kind: 'directory', path: handle.path, type: 'added' });
      return;
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
    ignore: nativeIgnoreGlobs(),
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
    throw error;
  });

  logger.info('Started parcel watcher', {
    backend,
    path: handle.path,
    platform: process.platform,
  });

  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    batcher.dispose();
    subscription.unsubscribe().catch((error: unknown) => {
      logger.error('Failed to unsubscribe parcel watcher', {
        error,
        path: handle.path,
      });
    });
  };
}
