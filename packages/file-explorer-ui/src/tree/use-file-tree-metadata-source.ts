/**
 * Registers ONE tree's enumeration with the panel-level metadata seam
 * (BST-1208).
 *
 * The store lives at the panel (that is where `onTokenResolved` can be wired),
 * but only a tree knows how to walk its own root: the desktop path reads the
 * normalized tree, the web path walks the display tree's `IFileNode`s. Both
 * mirror `directoryTraversalContext` exactly, so a folder's rollup covers the
 * same file set its tri-state checkbox counts (decision D2: the VISIBLE
 * universe when a filter is on).
 *
 * Two guards keep a rollup from becoming a scroll-time cost:
 *
 * - Incomplete subtrees short-circuit before any enumeration. A folder with an
 *   unloaded descendant cannot have a trustworthy total anyway.
 * - `DIRECTORY_ROLLUP_MAX_FILES` refuses to enumerate a very large subtree.
 *   `invalidateAll` recomputes every cached rollup, so an unbounded walk here
 *   would make a reconciliation O(repo) per visible folder row. The refusal is
 *   reported as `isComplete: false` — which is literally true, the subtree was
 *   not fully enumerated — and renders as an explicit partial marker, never a
 *   number.
 */

import { memoizedFileExplorer as fileExplorer } from '@brainstrike/file-explorer/file-tree';
import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import type { IFileNode } from '@brainstrike/types';
import type { MutableRefObject } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useOptionalFileRowMetadata } from '../indexing/file-row-metadata-context';
import {
  type FileRowMetadataSource,
  RECOMPUTING_DIRECTORY_SUBTREE,
  UNENUMERATED_DIRECTORY_SUBTREE,
} from '../indexing/file-row-metadata-source-registry';
import type {
  FileRowDirectorySubtree,
  FileRowMetadataStore,
} from '../indexing/file-row-metadata-store';
import { collectVisibleFileSelectionKeys } from '../indexing/visible-file-selection-keys';
import {
  hasNormalizedIncompleteDescendants,
  type VisibleDirectoryAggregates,
} from '../utils/normalized-file-tree';
import type { useOptionalFileTreeNormalizedContext } from './file-tree-provider';
import { indexFileNodesByPath } from './optimized-file-tree-model';

/**
 * Above this many descendant files a folder total is not computed.
 *
 * MEASURED at the cap (`__tests__/explorer-directory-rollup-cost.test.ts`): a
 * full viewport of 30 directory rows, each with 2000 already-counted
 * descendants, costs **21-29ms** of synchronous aggregation. That is the
 * worst case — a rollup short-circuits on the first `pending` file, so a
 * mid-index tree is far cheaper — but it is several frames, which is why the
 * first read of a rollup is deferred off the paint path below rather than
 * computed inline.
 */
export const DIRECTORY_ROLLUP_MAX_FILES = 2000;

/** Withdrawal sentinel; shared so an unmount never allocates. */
const EMPTY_VISIBLE_FILE_KEYS: ReadonlySet<string> = Object.freeze(new Set<string>()) as Readonly<
  Set<string>
>;

type NormalizedTreeContext = ReturnType<typeof useOptionalFileTreeNormalizedContext>;

export interface FileTreeMetadataSourceParams {
  /**
   * The display tree. Only consulted on the web path, where it is the only
   * enumeration available; the desktop path reads the normalized tree instead.
   */
  fileTree: IFileNode[];
  /** Display-filter universe, or null when nothing is filtered out. */
  filteredPathSet: ReadonlySet<string> | null;
  folderId: string;
  normalizedTreeContext: NormalizedTreeContext;
  /**
   * Change signal for rollups. Tree structure (a directory loading its
   * children, a filter changing) moves totals without naming a key, so the
   * store is reconciled whenever the row model changes. Row identity is
   * stabilized upstream, so scrolling does NOT trigger this.
   *
   * A revision rather than the rows array ON PURPOSE (BST-1209): once the rows
   * can be SORTED, array identity also changes on a pure reorder — and
   * reconciling on a reorder flips every rollup to partial, which bumps the
   * sort's metadata revision, which reorders the rows again, forever. The
   * revision counts structure (`FileTreeRowReuseCache.getStructureRevision`)
   * and is invariant under reordering, so the ring cannot close.
   */
  rowStructureRevision: number;
  visibleAggregates: VisibleDirectoryAggregates | null;
}

function toCompositeKeys(folderId: string, paths: readonly string[]): string[] {
  return paths.map((path) => encodeFileSelection(folderId, path));
}

function resolveNormalizedSubtree(
  params: FileTreeMetadataSourceParams,
  normalizedTreeContext: NonNullable<NormalizedTreeContext>,
  path: string
): FileRowDirectorySubtree {
  const { filteredPathSet, folderId, visibleAggregates } = params;
  const hasIncompleteDescendants = visibleAggregates
    ? (visibleAggregates.incompleteDirCountByPath.get(path) ?? 0) > 0
    : hasNormalizedIncompleteDescendants(normalizedTreeContext.normalizedTreeRef.current, path);
  if (hasIncompleteDescendants) {
    return UNENUMERATED_DIRECTORY_SUBTREE;
  }
  const fileCount = visibleAggregates
    ? (visibleAggregates.fileCountByPath.get(path) ?? 0)
    : normalizedTreeContext.getDescendantFileCount(path);
  if (fileCount > DIRECTORY_ROLLUP_MAX_FILES) {
    return UNENUMERATED_DIRECTORY_SUBTREE;
  }
  const descendantPaths = normalizedTreeContext.getDescendantFilePaths(path);
  const visiblePaths = filteredPathSet
    ? descendantPaths.filter((descendantPath) => filteredPathSet.has(descendantPath))
    : descendantPaths;
  return { fileKeys: toCompositeKeys(folderId, visiblePaths), isComplete: true };
}

function resolveDisplayTreeSubtree(
  resolved: ResolvedSourceState,
  path: string
): FileRowDirectorySubtree {
  const node = resolved.displayNodeByPath?.get(path);
  if (node?.type !== 'directory') {
    return UNENUMERATED_DIRECTORY_SUBTREE;
  }
  const folderFileCount = fileExplorer.getFolderFileCount(node);
  if (!folderFileCount.isComplete || folderFileCount.count > DIRECTORY_ROLLUP_MAX_FILES) {
    return UNENUMERATED_DIRECTORY_SUBTREE;
  }
  return {
    fileKeys: toCompositeKeys(
      resolved.params.folderId,
      fileExplorer.getAllFilePathsInDirectory(node)
    ),
    isComplete: true,
  };
}

function resolveDirectorySubtree(
  resolved: ResolvedSourceState,
  path: string
): FileRowDirectorySubtree {
  const { normalizedTreeContext, folderId } = resolved.params;
  if (!folderId) {
    return UNENUMERATED_DIRECTORY_SUBTREE;
  }
  if (normalizedTreeContext) {
    return resolveNormalizedSubtree(resolved.params, normalizedTreeContext, path);
  }
  return resolveDisplayTreeSubtree(resolved, path);
}

function resolveNodeSize(resolved: ResolvedSourceState, path: string): number | undefined {
  const { normalizedTreeContext } = resolved.params;
  if (normalizedTreeContext) {
    return normalizedTreeContext.normalizedTreeRef.current.nodeByPath.get(path)?.size;
  }
  // Descendant sizes must resolve for files the tree has NOT rendered as rows —
  // a collapsed folder's rollup reads every file under it — so the web path
  // indexes the whole display tree rather than the visible row set.
  return resolved.displayNodeByPath?.get(path)?.size;
}

interface ResolvedSourceState {
  /** Path → node over the WHOLE display tree; null on the normalized path. */
  displayNodeByPath: ReadonlyMap<string, IFileNode> | null;
  params: FileTreeMetadataSourceParams;
}

/**
 * Deferred-rollup state, created once per mounted tree.
 *
 * MEASURED (BST-1208 review item 2,
 * `__tests__/explorer-directory-rollup-cost.test.ts`): a full viewport of 30
 * directory rows, each at the 2000-file cap with every descendant already
 * counted, costs **21-29ms** of synchronous aggregation on the dev machine.
 * That is several frames, and it would land squarely on the first paint of a
 * scroll into a folder-dense region — so the first read is NOT allowed to
 * compute. It answers "not enumerated yet" (an honest, already-supported
 * state), the real subtrees are resolved one task later in a single batch, and
 * the affected keys are invalidated so exactly those cells repaint.
 *
 * The recurring `invalidateAll` reconciliation still aggregates synchronously,
 * which is fine: it runs in a timer rather than on the paint path, and during
 * an index run almost every rollup short-circuits on the first pending file.
 */
interface DeferredRollupState {
  cache: Map<string, FileRowDirectorySubtree>;
  pending: Set<string>;
  /**
   * Paths the STORE has asked about since the last `refreshAll` — the liveness
   * mark for the sweep in `refreshAll` (whole-branch review F3).
   *
   * Every read of this cache arrives through the store: a cell or the sort
   * comparator calls `getDirectorySnapshot`, which on a miss calls
   * `computeDirectoryRollup` → `getDirectorySubtree` → `read` here, and the
   * store's own `invalidateAll` re-reads exactly the rollups it still holds. So
   * "read since the last refresh" IS "the store still holds this rollup", which
   * is the bound the cache needs and the reason it does not need a store API to
   * ask.
   */
  readSinceRefresh: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
}

interface DeferredRollupSources {
  resolvedRef: MutableRefObject<ResolvedSourceState>;
  storeRef: MutableRefObject<FileRowMetadataStore | undefined>;
}

export interface DeferredRollupController {
  /** Drop any queued work. Used on unmount and before re-arming. */
  cancel: () => void;
  /**
   * Subtree for `path`: the cached one when present — which may be at most one
   * commit stale while a refresh is in flight — otherwise the explicit
   * unenumerated marker plus a queued resolution.
   */
  read: (path: string) => FileRowDirectorySubtree;
  /**
   * Re-resolve every cached subtree WITHOUT dropping the current ones.
   *
   * Clearing the cache here is what made every expand/collapse, filter
   * keystroke and lazy child load repaint each visible directory row twice:
   * the store's synchronous `invalidateAll` immediately after would miss the
   * cache, take the deferral branch, and flip a settled `complete` rollup to
   * PARTIAL — a visible blink behind a tooltip that was momentarily untrue —
   * before the flush restored the number a macrotask later.
   *
   * Stale-while-recompute instead: keep serving the previous subtree (at most
   * one commit old) until its replacement lands in the same macrotask. Rollups
   * whose content did not actually move then compare equal in the store and
   * notify nobody, so the common interaction repaints nothing at all.
   *
   * This is ALSO the sweep point (whole-branch review F3). The cache used to
   * only ever grow — nothing removed a path once read — so after one expand-all
   * it held every directory in the repo and `refreshAll` re-resolved all of
   * them on every later keystroke, collapse and lazy child load. Entries the
   * store has not asked about since the previous refresh are dropped: they are
   * no longer projected, so nothing is serving them.
   */
  refreshAll: () => void;
}

export function createDeferredRollupController({
  resolvedRef,
  storeRef,
}: DeferredRollupSources): DeferredRollupController {
  const state: DeferredRollupState = {
    cache: new Map(),
    pending: new Set(),
    readSinceRefresh: new Set(),
    timer: null,
  };

  const cancel = (): void => {
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    state.pending.clear();
  };

  const flush = (): void => {
    state.timer = null;
    const paths = [...state.pending];
    state.pending.clear();
    if (paths.length === 0) {
      return;
    }
    const { folderId } = resolvedRef.current.params;
    const invalidatedKeys: string[] = [];
    for (const path of paths) {
      state.cache.set(path, resolveDirectorySubtree(resolvedRef.current, path));
      if (folderId) {
        invalidatedKeys.push(encodeFileSelection(folderId, path));
      }
    }
    // DIRECTORY entry point: the store re-reads these rollups and notifies —
    // including the per-root sort revision — only where a value actually moved.
    // `invalidate` would bump every named key's root unconditionally, which
    // made an expand/collapse cost a THIRD full projection rebuild+sort for a
    // flush that resolved the same totals (whole-branch review F4).
    storeRef.current?.invalidateDirectories(invalidatedKeys);
  };

  const schedule = (): void => {
    state.timer ??= setTimeout(flush, 0);
  };

  return {
    cancel,
    read: (path) => {
      state.readSinceRefresh.add(path);
      const cached = state.cache.get(path);
      if (cached) {
        return cached;
      }
      state.pending.add(path);
      schedule();
      return RECOMPUTING_DIRECTORY_SUBTREE;
    },
    refreshAll: () => {
      if (state.cache.size === 0) {
        return;
      }
      // Sweep FIRST, then re-queue the survivors: an entry nothing has read
      // since the previous refresh is no longer projected, and re-resolving it
      // would be work for a row that does not exist.
      //
      // A refresh with no reads at all in between (two structural changes in
      // one macrotask, before anything painted) keeps everything: an empty mark
      // set means "no evidence", not "nothing is live".
      if (state.readSinceRefresh.size > 0) {
        for (const path of state.cache.keys()) {
          if (!state.readSinceRefresh.has(path)) {
            state.cache.delete(path);
            state.pending.delete(path);
          }
        }
      }
      state.readSinceRefresh.clear();
      if (state.cache.size === 0) {
        return;
      }
      for (const path of state.cache.keys()) {
        state.pending.add(path);
      }
      schedule();
    },
  };
}

export function useFileTreeMetadataSource(params: FileTreeMetadataSourceParams): void {
  const metadata = useOptionalFileRowMetadata();

  const { fileTree, normalizedTreeContext } = params;
  const displayNodeByPath = useMemo<ReadonlyMap<string, IFileNode> | null>(() => {
    if (normalizedTreeContext) {
      return null;
    }
    const index = new Map<string, IFileNode>();
    indexFileNodesByPath(fileTree, index);
    return index;
  }, [fileTree, normalizedTreeContext]);

  // Latest-value refs: the source closures below are created ONCE (the registry
  // holds them for as long as the tree is mounted), so they must read through
  // refs rather than capture this render's props. Written after commit — a
  // render React discards must not leak into the registry — and declared
  // BEFORE the registration/reconciliation effects so those observe this
  // commit's values.
  const resolvedRef = useRef<ResolvedSourceState>({ displayNodeByPath, params });
  const storeRef = useRef(metadata?.store);
  useEffect(() => {
    resolvedRef.current = { displayNodeByPath, params };
    storeRef.current = metadata?.store;
  });

  // Create-once via the lazy useState initializer (the repo's idiom, and the
  // one that does not allocate a throwaway controller on every render).
  const [deferredRollups] = useState(() =>
    createDeferredRollupController({ resolvedRef, storeRef })
  );

  const source = useMemo<FileRowMetadataSource>(
    () => ({
      getDirectorySubtree: (path) => deferredRollups.read(path),
      getNodeSize: (path) => resolveNodeSize(resolvedRef.current, path),
    }),
    [deferredRollups]
  );

  const { folderId, rowStructureRevision } = params;
  const registerSource = metadata?.registerSource;
  useEffect(() => {
    if (!(registerSource && folderId)) {
      return;
    }
    return registerSource(folderId, source);
  }, [folderId, registerSource, source]);

  // Visible/expanded token indexing is published PER ROOT (whole-branch review
  // F2). The panel used to build this set from its own `useFileExplorer()`
  // tree — the FOCUSED root only — so in a forest every other section's Tokens
  // cells stayed `pending` forever and, because a rollup goes partial on the
  // first pending descendant, its folder Size totals with them. Only a mounted
  // tree knows its own display enumeration, which is exactly why the other two
  // lookups above already live here.
  //
  // `fileTree` is the DISPLAY tree (view + quick filters already applied) — the
  // same input the panel used — so a single-root workspace's key set is
  // unchanged by the move.
  const visibleFileKeys = useMemo(() => collectVisibleFileSelectionKeys(fileTree), [fileTree]);
  const publishVisibleFileKeys = metadata?.publishVisibleFileKeys;
  useEffect(() => {
    if (!(publishVisibleFileKeys && folderId)) {
      return;
    }
    publishVisibleFileKeys(folderId, visibleFileKeys);
    // Withdraw on unmount: a collapsed section (or a removed root) must stop
    // asking the indexer for files nobody is looking at.
    return () => publishVisibleFileKeys(folderId, EMPTY_VISIBLE_FILE_KEYS);
  }, [folderId, publishVisibleFileKeys, visibleFileKeys]);

  const store = metadata?.store;
  useEffect(() => {
    // A structural change moves rollups without naming a key, so every resolved
    // subtree is queued for re-resolution — but the previous ones keep being
    // served until their replacements land, so `invalidateAll` here sees real
    // values rather than a cache it just emptied. Runs on mount too, which is
    // what turns the first render's "no source yet" reads into real values once
    // registration lands.
    deferredRollups.refreshAll();
    store?.invalidateAll();
    // Cleanup runs before the next pass AND on unmount, so a queued flush can
    // never outlive the tree that scheduled it.
    // LOAD-BEARING DEPENDENCY (BST-1209 review): key on the structure revision,
    // never on row-array identity — a pure reorder must not reach this effect,
    // or the sort→invalidate→revision→re-sort ring closes into a rebuild loop.
    return deferredRollups.cancel;
  }, [deferredRollups, rowStructureRevision, store]);
}
