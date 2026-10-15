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
 * time instead of in whole-selection sweeps. For the same reason there are two
 * invalidation entry points: `invalidate(keys)` for the common case where the
 * changed key is known (a token arrival), and `invalidateAll()` only for the
 * bulk events where it is not.
 *
 * Keys are the file-explorer composite keys (`rootId|@|path`, see
 * `@brainstrike/file-explorer/selection`), so paths stay unique to their
 * owning workspace root.
 *
 * NO SILENT FALLBACKS: a file that has not been counted reads `pending`, a
 * file the indexer will never count reads `excluded` WITH the reason, and a
 * directory whose subtree is not fully enumerated (or whose descendants are not
 * all measured) reads an explicit `partial` marker. Nothing here ever reports a
 * zero it cannot justify.
 *
 * The store cannot observe the tree. It caches what it computes and only
 * recomputes when told to, so a caller that changes the tree's SHAPE (expand,
 * collapse, refresh, root switch) MUST call `invalidateAll()` — see
 * `getDirectorySubtree` below and the consumer note on `useFileRowMetadataStore`.
 */

import { decodeFileSelection, encodeFileSelection } from '@brainstrike/file-explorer/selection';
import { DEFAULT_MAX_FILE_SIZE } from '@brainstrike/file-system';
import { getFileExtension, isBinaryFile } from '@brainstrike/utils/file-utils';
import { EXTENSIONLESS_FILE_TYPE } from '../utils/metadata-formatters';

/**
 * Why the indexer will never produce a count for a row. These mirror the two
 * permanent retirements in `planTokenIndexingDispatch` — a file it excludes is
 * added to `indexedKeysToAdd`, so it is never revisited and its count never
 * arrives. Rendering either as `pending` would be a lie that also pins every
 * ancestor rollup to `partial` forever.
 *
 * - `'binary'` — `isBinaryFile`, the planner's own first check.
 * - `'too-large'` — over `DEFAULT_MAX_FILE_SIZE`, the same shared constant the
 *   planner defaults `maxIndexableFileSize` to.
 */
export type FileRowTokenExclusionReason = 'binary' | 'too-large';

/**
 * Token state for one file row.
 * - `number` — a real count from the token cache.
 * - `'pending'` — not counted yet (cache miss); NEVER render this as 0.
 * - `'excluded'` — the indexer will never count it; `exclusionReason` says why.
 */
export type FileRowTokenState = number | 'excluded' | 'pending';

interface FileRowMetadataCommon {
  /** Bytes. Absent when neither the tree node nor the token cache knows it. */
  readonly size?: number;
  /** Lowercase, dot-free extension; `file` when the name has none. */
  readonly type: string;
}

/**
 * Structurally enforces the no-silent-state contract: an excluded row always
 * names the planner retirement that caused it, while countable rows cannot
 * carry a stale exclusion reason.
 */
export type FileRowMetadata =
  | (FileRowMetadataCommon & {
      readonly exclusionReason: FileRowTokenExclusionReason;
      readonly tokens: 'excluded';
    })
  | (FileRowMetadataCommon & {
      readonly exclusionReason?: never;
      readonly tokens: number | 'pending';
    });

/**
 * Aggregate for a directory row. `partial` is deliberately value-free: a sum
 * over a half-enumerated subtree (or over files whose metadata has not landed)
 * is wrong, and rendering it would be indistinguishable from the truth.
 */
export type FileRowDirectoryRollup =
  | { readonly size: number; readonly status: 'complete'; readonly tokens: number }
  | {
      readonly reason: 'incomplete-subtree' | 'pending-metadata' | 'recomputing';
      readonly status: 'partial';
    };

export type FileRowDirectorySubtree =
  | {
      /** Composite keys of every file currently enumerated under the directory. */
      readonly fileKeys: readonly string[];
      readonly incompleteReason?: never;
      readonly isComplete: true;
    }
  | {
      readonly fileKeys: readonly string[];
      /** Distinguishes queued work from a permanent/inert incomplete subtree. */
      readonly incompleteReason: 'not-enumerated' | 'recomputing';
      readonly isComplete: false;
    };

export interface FileRowMetadataSources {
  /** `file_token_cache.file_size`; the fallback when the node has no size. */
  getCachedSize: (compositeKey: string) => number | undefined;
  /**
   * Enumerated subtree for a directory key. TOTAL by contract: a key the caller
   * knows nothing about — an unexpanded directory, an unregistered key, or a
   * FILE key reached by mistake — answers an incomplete subtree with the
   * explicit `not-enumerated` reason,
   * which reads as `partial`. Returning a sentinel rather than `null` is what
   * keeps a cell from throwing mid-render, and it removes the old ambiguity
   * where "this is a file" and "this directory is not enumerated yet" were the
   * same `null`.
   *
   * The store CACHES the rollup this produces and cannot see the tree change
   * underneath it, so a caller whose enumeration shifts (expand, collapse,
   * refresh, root switch) MUST follow with `invalidateAll()`. See
   * `use-file-tree-metadata-source` for the tree-side implementation.
   */
  getDirectorySubtree: (compositeKey: string) => FileRowDirectorySubtree;
  /** `IFileNode.size` fed by the tree; the preferred size source. */
  getNodeSize: (compositeKey: string) => number | undefined;
  /** Hot-cache (PGlite-warmed) count; `undefined` when not counted yet. */
  getTokenCount: (compositeKey: string) => number | undefined;
}

export interface FileRowMetadataStore {
  /**
   * Rollup for a directory key. Never throws: a key with no enumerated subtree
   * reads `partial` (see `FileRowMetadataSources.getDirectorySubtree`).
   */
  getDirectorySnapshot: (compositeKey: string) => FileRowDirectoryRollup;
  /**
   * Monotonic per-root revision used only while that root is metadata-sorted.
   * Moves once per invalidation batch that touches the root — see
   * `subscribeFolder` for why it is not narrowed to observed value changes.
   */
  getFolderRevision: (folderId: string) => number;
  /**
   * Metadata for a file key. The returned object keeps a STABLE identity until
   * an `invalidate`/`invalidateAll` observes a real change — that is what lets
   * useSyncExternalStore skip unaffected cells and, conversely, guarantees a
   * re-render the moment the value actually moves.
   */
  getSnapshot: (compositeKey: string) => FileRowMetadata;
  /**
   * Re-read the named keys (plus their cached ancestor directories) and notify
   * ONLY the keys whose value changed. This is the PRECISE path and the one a
   * token arrival must use: its cost is O(keys + affected rollups), not
   * O(rendered rows). Call from an effect or a callback, never during render.
   *
   * Takes an array, not an `Iterable`, on purpose: a bare `string` is itself an
   * iterable of characters, and `invalidate(key)` would silently iterate
   * letters instead of failing.
   */
  invalidate: (compositeKeys: readonly string[]) => void;
  /**
   * Re-read every cached key — the RECONCILIATION path, for when the store
   * cannot know which keys moved (a bulk cache warm, a disk refresh). Costs
   * O(rendered rows + cached subtrees), so prefer `invalidate` whenever the
   * changed key is known.
   *
   * Entries nobody subscribes to are evicted rather than recomputed: that is
   * what bounds the caches to the rows in play, and it is also what keeps a
   * directory rollup honest, since the rollup recomputes its descendants from
   * source on the next read instead of summing stale snapshots.
   */
  invalidateAll: () => void;
  /**
   * Re-read named DIRECTORY keys and notify — including the per-root sort
   * revision — ONLY where a rollup actually moved. For the deferred rollup
   * flush, which re-resolves subtrees it queued and usually lands on the same
   * totals.
   *
   * Why this can be honest where `invalidate` cannot (whole-branch review F4):
   * `invalidate`'s unconditional per-root bump exists because a sorted tree
   * reads FILE values the cache does not hold — the comparator goes through the
   * non-caching `peekSnapshot`. Directory rollups are the opposite:
   * `getDirectorySnapshot` populates the cache on every read, so every
   * directory in the projection IS cached, and "no cached rollup moved" really
   * does mean "the order cannot have moved". MEASURED
   * (`__tests__/explorer-sort-structural-cost.integration.test.tsx`): this
   * removes one of THREE full 10k-row rebuild+sorts per expand/collapse.
   */
  invalidateDirectories: (compositeKeys: readonly string[]) => void;
  /**
   * Metadata for a file key WITHOUT caching it. For readers that sweep the
   * whole projection instead of one row — the sort comparator — where caching
   * would grow the store past the subscribed rows and disable eviction. The
   * returned object has no identity guarantee; never feed it to
   * useSyncExternalStore.
   */
  peekSnapshot: (compositeKey: string) => FileRowMetadata;
  subscribe: (compositeKey: string, listener: () => void) => () => void;
  /**
   * One notification per invalidation batch that touches this root. Explorer
   * row sorting uses this instead of N per-row renders.
   *
   * Coarser than the per-key path ON PURPOSE: an ordered tree compares values
   * across its whole expanded projection, most of which is off-screen and
   * therefore uncached, so "a cached snapshot changed" would miss real order
   * changes. A listener also PINS this root's directory rollups against
   * eviction (recomputing one walks an enumerated subtree); file snapshots stay
   * bounded by the subscribed rows.
   */
  subscribeFolder: (folderId: string, listener: () => void) => () => void;
}

function metadataEquals(a: FileRowMetadata, b: FileRowMetadata): boolean {
  return (
    a.tokens === b.tokens &&
    a.size === b.size &&
    a.type === b.type &&
    a.exclusionReason === b.exclusionReason
  );
}

/**
 * The indexer's permanent retirements, in the planner's own order (binary is
 * checked before size). Classification WINS over any count already in the
 * cache: these rows are ones the indexer will not (re)count, so a leftover
 * value is stale by construction — content-hash invalidation means a live count
 * cannot coexist with a size that now exceeds the limit.
 */
function resolveExclusionReason(
  path: string,
  size: number | undefined
): FileRowTokenExclusionReason | null {
  if (isBinaryFile(path)) {
    return 'binary';
  }
  if (size !== undefined && size > DEFAULT_MAX_FILE_SIZE) {
    return 'too-large';
  }
  return null;
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
const PARTIAL_RECOMPUTING: FileRowDirectoryRollup = {
  reason: 'recomputing',
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
  const listenersByFolder = new Map<string, Set<() => void>>();
  const revisionByFolder = new Map<string, number>();
  const fileSnapshots = new Map<string, FileRowMetadata>();
  const directoryRollups = new Map<string, FileRowDirectoryRollup>();
  /**
   * Directory keys an OUTSIDE caller has read since the last sweep — the
   * liveness mark for folder-pinned rollups (whole-branch review F3).
   *
   * A folder (sort) listener pins every directory rollup for its root, and the
   * sort comparator reads `getDirectorySnapshot` for every directory row in the
   * PROJECTION, so both caches filled to the projection's high-water mark and
   * collapsing never shrank them again: every later expand, collapse and
   * quick-filter keystroke then recomputed every rollup the session had ever
   * shown. Only EXTERNAL reads mark — `refreshCachedKey`'s own recompute must
   * not, or a rollup would keep itself alive forever.
   */
  const directoriesReadSinceSweep = new Set<string>();

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

  /**
   * Bump ONE revision per root per invalidation batch and notify its folder
   * listeners.
   *
   * The signal is deliberately "this root's metadata batch may have moved the
   * ordering", not "a cached snapshot changed". A sorted tree orders by values
   * for the whole expanded projection, which is far larger than the subscribed
   * window — deriving the signal from cached-and-changed keys would only be
   * honest if the store cached the whole projection, and pinning the whole
   * projection is exactly the unbounded cache this store exists to avoid
   * (BST-1209 review, important finding 2). Over-notifying costs at most one
   * coalesced row rebuild per batch; under-notifying leaves a visibly stale
   * order with nothing to say so.
   */
  const bumpFolders = (folderIds: Iterable<string>): void => {
    for (const folderId of new Set(folderIds)) {
      revisionByFolder.set(folderId, (revisionByFolder.get(folderId) ?? 0) + 1);
      const listeners = listenersByFolder.get(folderId);
      if (!listeners) {
        continue;
      }
      for (const listener of [...listeners]) {
        listener();
      }
    }
  };

  const computeFileMetadata = (compositeKey: string): FileRowMetadata => {
    const { path } = decodeFileSelection(compositeKey);
    // getFileExtension / isBinaryFile both scan back to the last separator, so
    // the full path is a valid argument — no basename allocation needed.
    const size = sources.getNodeSize(compositeKey) ?? sources.getCachedSize(compositeKey);
    const exclusionReason = resolveExclusionReason(path, size);
    const common = {
      ...(size === undefined ? {} : { size }),
      type: getFileExtension(path) || EXTENSIONLESS_FILE_TYPE,
    };
    if (exclusionReason !== null) {
      return { ...common, exclusionReason, tokens: 'excluded' };
    }
    return {
      ...common,
      tokens: sources.getTokenCount(compositeKey) ?? 'pending',
    };
  };

  /** Cache-populating read: the identity a subscribed cell needs. */
  const readFileMetadata = (compositeKey: string): FileRowMetadata => {
    const cached = fileSnapshots.get(compositeKey);
    if (cached) {
      return cached;
    }
    const computed = computeFileMetadata(compositeKey);
    fileSnapshots.set(compositeKey, computed);
    return computed;
  };

  /**
   * VALUE-only read: answers from the cache when it is there, computes without
   * populating it when it is not. Used by every caller that wants a number
   * rather than a stable object — a sort comparator, and rollup aggregation
   * over descendants that may be nowhere near the viewport. Those callers read
   * the whole projection, so letting them populate the cache would grow it past
   * the subscribed rows and disable the eviction that bounds it.
   */
  const peekFileMetadata = (compositeKey: string): FileRowMetadata =>
    fileSnapshots.get(compositeKey) ?? computeFileMetadata(compositeKey);

  const computeDirectoryRollup = (compositeKey: string): FileRowDirectoryRollup => {
    const subtree = sources.getDirectorySubtree(compositeKey);
    if (!subtree.isComplete) {
      return subtree.incompleteReason === 'recomputing'
        ? PARTIAL_RECOMPUTING
        : PARTIAL_INCOMPLETE_SUBTREE;
    }

    let size = 0;
    let tokens = 0;
    for (const fileKey of subtree.fileKeys) {
      const metadata = peekFileMetadata(fileKey);
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
   *
   * A folder (sort) listener pins DIRECTORY rollups only. Recomputing a rollup
   * is the expensive read — it walks a whole enumerated subtree — so an ordered
   * tree keeps those, bounding that cache by the projection's directory rows.
   * File snapshots stay bounded by the SUBSCRIBED rows exactly as documented:
   * the comparator reads them through `peekFileMetadata`, which neither
   * populates nor needs the cache.
   */
  const refreshCachedKey = (compositeKey: string, cache: 'directory' | 'file'): boolean => {
    const isDirectory = cache === 'directory';
    const store = isDirectory ? directoryRollups : fileSnapshots;
    if (!store.has(compositeKey)) {
      return false;
    }
    const { folderId } = decodeFileSelection(compositeKey);
    const isPinned =
      listenersByKey.has(compositeKey) || (isDirectory && listenersByFolder.has(folderId));
    if (!isPinned) {
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
   * Drop folder-pinned rollups for directories nothing has read since the last
   * sweep — they are no longer in the projection, so nothing is serving them.
   *
   * Runs at the START of `invalidateAll`, before any recompute, so a rollup
   * cannot mark itself live. Keys with their OWN listener (a rendered cell) are
   * never swept; they are bounded by the subscribed rows already.
   *
   * A sweep with no external reads at all in between is skipped: an empty mark
   * set is "no evidence" — two reconciliations back to back, with no render
   * between them, would otherwise evict the whole live projection.
   */
  const sweepUnreadFolderPinnedRollups = (): void => {
    if (directoriesReadSinceSweep.size === 0) {
      return;
    }
    for (const compositeKey of [...directoryRollups.keys()]) {
      if (directoriesReadSinceSweep.has(compositeKey) || listenersByKey.has(compositeKey)) {
        continue;
      }
      directoryRollups.delete(compositeKey);
    }
    directoriesReadSinceSweep.clear();
  };

  /**
   * Files first, then directories: a directory rollup reads its descendants'
   * snapshots, so refreshing files up front keeps the rollup from summing a
   * value it is about to be told is stale.
   */
  const refreshKeys = (
    fileKeys: Iterable<string>,
    directoryKeys: Iterable<string>,
    touchedFolderIds: Iterable<string>
  ): void => {
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
    // Folders named by the batch, PLUS any folder a cached value actually moved
    // in — the latter covers a root whose listener has not attached yet, so a
    // sort that mounts mid-batch still sees a revision it can react to.
    bumpFolders([
      ...touchedFolderIds,
      ...changed.map((compositeKey) => decodeFileSelection(compositeKey).folderId),
    ]);
  };

  return {
    getDirectorySnapshot: (compositeKey) => {
      // Liveness mark: this key is in something's projection right now.
      directoriesReadSinceSweep.add(compositeKey);
      const cached = directoryRollups.get(compositeKey);
      if (cached) {
        return cached;
      }
      const computed = computeDirectoryRollup(compositeKey);
      directoryRollups.set(compositeKey, computed);
      return computed;
    },
    getFolderRevision: (folderId) => revisionByFolder.get(folderId) ?? 0,
    getSnapshot: readFileMetadata,
    invalidate: (compositeKeys) => {
      const fileKeys = new Set<string>();
      const directoryKeys = new Set<string>();
      const touchedFolderIds = new Set<string>();
      for (const compositeKey of compositeKeys) {
        fileKeys.add(compositeKey);
        // The NAMED key's root, whether or not that key is cached: an ordered
        // tree reads values the cache does not hold (see `bumpFolders`).
        touchedFolderIds.add(decodeFileSelection(compositeKey).folderId);
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
      refreshKeys(fileKeys, directoryKeys, touchedFolderIds);
    },
    invalidateAll: () => {
      // Let go of the projection's leftovers BEFORE recomputing, so a
      // reconciliation costs the rows in play rather than the high-water mark.
      sweepUnreadFolderPinnedRollups();
      // Everything may have moved, so every ordered root is told so.
      refreshKeys(
        [...fileSnapshots.keys()],
        [...directoryRollups.keys()],
        listenersByFolder.keys()
      );
    },
    invalidateDirectories: (compositeKeys) => {
      const directoryKeys = new Set<string>();
      for (const compositeKey of compositeKeys) {
        // A key the store does not cache is a key nothing has read, so nothing
        // is rendering or ordering by it.
        if (directoryRollups.has(compositeKey)) {
          directoryKeys.add(compositeKey);
        }
      }
      if (directoryKeys.size === 0) {
        return;
      }
      // NO `touchedFolderIds`: the bump is derived from real changes only. See
      // the interface comment for why that is honest for directory keys.
      refreshKeys([], directoryKeys, []);
    },
    peekSnapshot: peekFileMetadata,
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
    subscribeFolder: (folderId, listener) => {
      const listeners = listenersByFolder.get(folderId) ?? new Set<() => void>();
      listeners.add(listener);
      listenersByFolder.set(folderId, listeners);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          listenersByFolder.delete(folderId);
        }
      };
    },
  };
}
