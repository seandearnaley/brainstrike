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
import { useEffect, useMemo, useRef } from 'react';
import { useOptionalFileRowMetadata } from '../indexing/file-row-metadata-context';
import {
  type FileRowMetadataSource,
  UNENUMERATED_DIRECTORY_SUBTREE,
} from '../indexing/file-row-metadata-source-registry';
import type { FileRowDirectorySubtree } from '../indexing/file-row-metadata-store';
import {
  hasNormalizedIncompleteDescendants,
  type VisibleDirectoryAggregates,
} from '../utils/normalized-file-tree';
import type { useOptionalFileTreeNormalizedContext } from './file-tree-provider';
import { indexFileNodesByPath } from './optimized-file-tree-model';

/**
 * Above this many descendant files a folder total is not computed. Chosen so a
 * full reconciliation over a screenful of folder rows stays in the low
 * hundreds of thousands of reads even in a large monorepo.
 */
export const DIRECTORY_ROLLUP_MAX_FILES = 2000;

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
   */
  treeRows: unknown;
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

  // Latest-value ref: the source closures below are created ONCE (the registry
  // holds them for as long as the tree is mounted), so they must read through
  // a ref rather than capture this render's props. Written after commit — a
  // render React discards must not leak into the registry — and declared
  // BEFORE the registration/reconciliation effects so those observe this
  // commit's values.
  const resolvedRef = useRef<ResolvedSourceState>({ displayNodeByPath, params });
  useEffect(() => {
    resolvedRef.current = { displayNodeByPath, params };
  });

  const source = useMemo<FileRowMetadataSource>(
    () => ({
      getDirectorySubtree: (path) => resolveDirectorySubtree(resolvedRef.current, path),
      getNodeSize: (path) => resolveNodeSize(resolvedRef.current, path),
    }),
    []
  );

  const { folderId, treeRows } = params;
  const registerSource = metadata?.registerSource;
  useEffect(() => {
    if (!(registerSource && folderId)) {
      return;
    }
    return registerSource(folderId, source);
  }, [folderId, registerSource, source]);

  const store = metadata?.store;
  useEffect(() => {
    // Runs on mount too, which is what turns the first render's "no source yet"
    // reads into real values once registration has landed.
    store?.invalidateAll();
  }, [store, treeRows]);
}
