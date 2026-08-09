/**
 * Per-row file metadata seam for the Explorer tree grid (BST-1207).
 *
 * A per-KEY external store: each tree cell subscribes (via useSyncExternalStore)
 * to only its own composite key, so a token count landing for one file notifies
 * that file's cell — and its enumerated ancestor directories, whose rollup
 * genuinely changed — and nothing else. No row rebuild, no row-array
 * invalidation, no tree-wide notify. Modeled on the per-node selection store
 * (`../tree/optimized-file-tree-selection-store.ts`); the difference is that
 * subscription itself is per key here, because metadata arrives one file at a
 * time instead of in whole-selection sweeps.
 *
 * Keys are the file-explorer composite keys (`rootId|@|path`, see
 * `@brainstrike/file-explorer/selection`), so paths stay unique to their
 * owning workspace root.
 *
 * NO SILENT FALLBACKS: a file that has not been counted reads `pending`, a
 * file the indexer will never count reads `excluded`, and a directory whose
 * subtree is not fully enumerated (or whose descendants are not all measured)
 * reads an explicit `partial` marker. Nothing here ever reports a zero it
 * cannot justify.
 */

import { decodeFileSelection, encodeFileSelection } from '@brainstrike/file-explorer/selection';
import { getFileExtension, isBinaryFile } from '@brainstrike/utils/file-utils';

/**
 * Token state for one file row.
 * - `number` — a real count from the token cache.
 * - `'pending'` — not counted yet (cache miss); NEVER render this as 0.
 * - `'excluded'` — the indexer will never count it. Binaries only, using
 *   `isBinaryFile` so this matches the dispatch planner's own exclusion.
 */
export type FileRowTokenState = number | 'excluded' | 'pending';

export interface FileRowMetadata {
  /** Bytes. Absent when neither the tree node nor the token cache knows it. */
  readonly size?: number;
  readonly tokens: FileRowTokenState;
  /** Lowercase, dot-free extension; `''` when the name has none. */
  readonly type: string;
}

/**
 * Aggregate for a directory row. `partial` is deliberately value-free: a sum
 * over a half-enumerated subtree (or over files whose metadata has not landed)
 * is wrong, and rendering it would be indistinguishable from the truth.
 */
export type FileRowDirectoryRollup =
  | { readonly size: number; readonly status: 'complete'; readonly tokens: number }
  | {
      readonly reason: 'incomplete-subtree' | 'pending-metadata';
      readonly status: 'partial';
    };

export interface FileRowDirectorySubtree {
  /** Composite keys of every file currently enumerated under the directory. */
  readonly fileKeys: readonly string[];
  /**
   * False when any directory in the subtree is not fully loaded — the same
   * guard as `FileTreeRowData.hasIncompleteDescendants`, which is what stops
   * the tri-state checkbox from rendering "all selected" over a partial tree.
   */
  readonly isComplete: boolean;
}

export interface FileRowMetadataSources {
  /** `file_token_cache.file_size`; the fallback when the node has no size. */
  getCachedSize: (compositeKey: string) => number | undefined;
  /** Enumerated subtree for a directory key; `null` when the key is not one. */
  getDirectorySubtree: (compositeKey: string) => FileRowDirectorySubtree | null;
  /** `IFileNode.size` fed by the tree; the preferred size source. */
  getNodeSize: (compositeKey: string) => number | undefined;
  /** Hot-cache (PGlite-warmed) count; `undefined` when not counted yet. */
  getTokenCount: (compositeKey: string) => number | undefined;
}

export interface FileRowMetadataStore {
  /** Rollup for a directory key. Throws when the key has no enumerated subtree. */
  getDirectorySnapshot: (compositeKey: string) => FileRowDirectoryRollup;
  /**
   * Metadata for a file key. The returned object keeps a STABLE identity until
   * an `invalidate`/`invalidateAll` observes a real change — that is what lets
   * useSyncExternalStore skip unaffected cells and, conversely, guarantees a
   * re-render the moment the value actually moves.
   */
  getSnapshot: (compositeKey: string) => FileRowMetadata;
  /**
   * Re-read the named keys (plus their cached ancestor directories) and notify
   * ONLY the keys whose value changed. Call from an effect, never during render.
   */
  invalidate: (compositeKeys: Iterable<string>) => void;
  /**
   * Re-read every cached key. Entries nobody subscribes to are evicted instead
   * of recomputed, which is what bounds the cache to the rows in play.
   */
  invalidateAll: () => void;
  subscribe: (compositeKey: string, listener: () => void) => () => void;
}

function metadataEquals(a: FileRowMetadata, b: FileRowMetadata): boolean {
  return a.tokens === b.tokens && a.size === b.size && a.type === b.type;
}

function rollupEquals(a: FileRowDirectoryRollup, b: FileRowDirectoryRollup): boolean {
  if (a.status === 'complete') {
    return b.status === 'complete' && a.size === b.size && a.tokens === b.tokens;
  }
  return b.status === 'partial' && a.reason === b.reason;
}

/** Strip the last path segment; handles both posix and windows separators. */
function parentPathOf(path: string): string | null {
  const lastSeparator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (lastSeparator <= 0) {
    return null;
  }
  return path.slice(0, lastSeparator);
}

/** Every enclosing directory key, nearest first. */
function* ancestorDirectoryKeys(compositeKey: string): Generator<string> {
  const { folderId, path } = decodeFileSelection(compositeKey);
  let current = parentPathOf(path);
  while (current !== null) {
    yield encodeFileSelection(folderId, current);
    current = parentPathOf(current);
  }
}

const PARTIAL_INCOMPLETE_SUBTREE: FileRowDirectoryRollup = {
  reason: 'incomplete-subtree',
  status: 'partial',
};
const PARTIAL_PENDING_METADATA: FileRowDirectoryRollup = {
  reason: 'pending-metadata',
  status: 'partial',
};

/**
 * @param sources - Read accessors, held by reference. Callers whose underlying
 *   data changes identity (React props, context) should pass closures that read
 *   the latest values, then `invalidate` the affected keys.
 */
export function createFileRowMetadataStore(sources: FileRowMetadataSources): FileRowMetadataStore {
  const listenersByKey = new Map<string, Set<() => void>>();
  const fileSnapshots = new Map<string, FileRowMetadata>();
  const directoryRollups = new Map<string, FileRowDirectoryRollup>();

  const notifyKey = (compositeKey: string): void => {
    const listeners = listenersByKey.get(compositeKey);
    if (!listeners) {
      return;
    }
    // Copy before iterating: a listener may synchronously unmount a sibling
    // subscriber, mutating the Set mid-loop (Zustand/Redux-internals pattern).
    for (const listener of [...listeners]) {
      listener();
    }
  };

  const computeFileMetadata = (compositeKey: string): FileRowMetadata => {
    const { path } = decodeFileSelection(compositeKey);
    // getFileExtension / isBinaryFile both scan back to the last separator, so
    // the full path is a valid argument — no basename allocation needed.
    const size = sources.getNodeSize(compositeKey) ?? sources.getCachedSize(compositeKey);
    const tokens: FileRowTokenState = isBinaryFile(path)
      ? 'excluded'
      : (sources.getTokenCount(compositeKey) ?? 'pending');
    return {
      ...(size === undefined ? {} : { size }),
      tokens,
      type: getFileExtension(path),
    };
  };

  const readFileMetadata = (compositeKey: string): FileRowMetadata => {
    const cached = fileSnapshots.get(compositeKey);
    if (cached) {
      return cached;
    }
    const computed = computeFileMetadata(compositeKey);
    fileSnapshots.set(compositeKey, computed);
    return computed;
  };

  const computeDirectoryRollup = (compositeKey: string): FileRowDirectoryRollup => {
    const subtree = sources.getDirectorySubtree(compositeKey);
    if (!subtree) {
      throw new Error(`No enumerated subtree for directory key "${compositeKey}"`);
    }
    if (!subtree.isComplete) {
      return PARTIAL_INCOMPLETE_SUBTREE;
    }

    let size = 0;
    let tokens = 0;
    for (const fileKey of subtree.fileKeys) {
      const metadata = readFileMetadata(fileKey);
      if (metadata.tokens === 'pending' || metadata.size === undefined) {
        return PARTIAL_PENDING_METADATA;
      }
      size += metadata.size;
      if (metadata.tokens !== 'excluded') {
        tokens += metadata.tokens;
      }
    }
    return { size, status: 'complete', tokens };
  };

  /**
   * Re-read one cached key. Subscribed keys are recomputed and notified only on
   * a real change; unsubscribed keys are evicted so the caches stay bounded by
   * the rows actually in play.
   */
  const refreshCachedKey = (compositeKey: string, cache: 'directory' | 'file'): boolean => {
    const isDirectory = cache === 'directory';
    const store = isDirectory ? directoryRollups : fileSnapshots;
    if (!store.has(compositeKey)) {
      return false;
    }
    if (!listenersByKey.has(compositeKey)) {
      store.delete(compositeKey);
      return false;
    }
    if (isDirectory) {
      const previous = directoryRollups.get(compositeKey) as FileRowDirectoryRollup;
      const next = computeDirectoryRollup(compositeKey);
      if (rollupEquals(previous, next)) {
        return false;
      }
      directoryRollups.set(compositeKey, next);
      return true;
    }
    const previous = fileSnapshots.get(compositeKey) as FileRowMetadata;
    const next = computeFileMetadata(compositeKey);
    if (metadataEquals(previous, next)) {
      return false;
    }
    fileSnapshots.set(compositeKey, next);
    return true;
  };

  /**
   * Files first, then directories: a directory rollup reads its descendants'
   * snapshots, so refreshing files up front keeps the rollup from summing a
   * value it is about to be told is stale.
   */
  const refreshKeys = (fileKeys: Iterable<string>, directoryKeys: Iterable<string>): void => {
    const changed: string[] = [];
    for (const compositeKey of fileKeys) {
      if (refreshCachedKey(compositeKey, 'file')) {
        changed.push(compositeKey);
      }
    }
    for (const compositeKey of directoryKeys) {
      if (refreshCachedKey(compositeKey, 'directory')) {
        changed.push(compositeKey);
      }
    }
    for (const compositeKey of changed) {
      notifyKey(compositeKey);
    }
  };

  return {
    getDirectorySnapshot: (compositeKey) => {
      const cached = directoryRollups.get(compositeKey);
      if (cached) {
        return cached;
      }
      const computed = computeDirectoryRollup(compositeKey);
      directoryRollups.set(compositeKey, computed);
      return computed;
    },
    getSnapshot: readFileMetadata,
    invalidate: (compositeKeys) => {
      const fileKeys = new Set<string>();
      const directoryKeys = new Set<string>();
      for (const compositeKey of compositeKeys) {
        fileKeys.add(compositeKey);
        if (directoryRollups.has(compositeKey)) {
          directoryKeys.add(compositeKey);
        }
        // Only enclosing directories the tree has actually rendered can change.
        for (const ancestor of ancestorDirectoryKeys(compositeKey)) {
          if (directoryRollups.has(ancestor)) {
            directoryKeys.add(ancestor);
          }
        }
      }
      refreshKeys(fileKeys, directoryKeys);
    },
    invalidateAll: () => {
      refreshKeys([...fileSnapshots.keys()], [...directoryRollups.keys()]);
    },
    subscribe: (compositeKey, listener) => {
      const listeners = listenersByKey.get(compositeKey) ?? new Set<() => void>();
      listeners.add(listener);
      listenersByKey.set(compositeKey, listeners);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          listenersByKey.delete(compositeKey);
        }
      };
    },
  };
}
