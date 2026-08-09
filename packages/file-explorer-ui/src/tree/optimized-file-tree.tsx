import { useExplorerColumnSizesStore } from '@brainstrike/app-state/stores/explorer-column-sizes-store';
import {
  isExplorerMetadataSortField,
  isExplorerSortField,
} from '@brainstrike/app-state/stores/explorer-sort-state-store';
import { getForeignSelectionCount } from '@brainstrike/file-explorer';
import { memoizedFileExplorer as fileExplorer } from '@brainstrike/file-explorer/file-tree';
import { encodeFileSelection, isPathSelectedInFolder } from '@brainstrike/file-explorer/selection';
import { useToastManager } from '@brainstrike/file-explorer-hooks';
import { useEventCallback } from '@brainstrike/hooks';
import { createLogger } from '@brainstrike/logging';
import type { FileExplorerState, IFileNode } from '@brainstrike/types';
import { createEmptySelectionModel } from '@brainstrike/types';
import {
  ActionContextMenu,
  type TreeNode,
  TreeTable,
  type TreeTableColumn,
  useContextMenuTarget,
  useIdeFileEditor,
} from '@brainstrike/ui';
import {
  type MouseEvent,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { fileNodeToTarget } from '../context-actions/file-entry-target';
import { useWorkerFlattenedTree } from '../hooks/use-worker-flattened-tree';
import { useOptionalFileRowMetadata } from '../indexing/file-row-metadata-context';
import { useExplorerColumns } from '../shell/explorer-columns-context';
import { useOptionalExplorerSort } from '../shell/explorer-sort-context';
import {
  useFileExplorerStoreContext,
  useFileExplorerStoreSelector,
} from '../shell/file-explorer-provider';
import { measureFileTreeOperation, recordFileTreeTelemetry } from '../utils/file-tree-telemetry';
import {
  buildVisibleDirectoryAggregates,
  hasNormalizedIncompleteDescendants,
  type VisibleDirectoryAggregates,
} from '../utils/normalized-file-tree';
import { scopeExpandedPathsToRoot } from '../utils/root-scoped-paths';
import { getSelectionCount } from '../utils/selection-projection';
import { setsEqual } from '../utils/sets-equal';
import { buildFileTreeColumns } from './file-tree-columns';
import {
  useOptionalFileTreeContext,
  useOptionalFileTreeIndexContext,
  useOptionalFileTreeNormalizedContext,
} from './file-tree-provider';
import {
  FileTreeSelectionContext,
  type FileTreeSelectionContextValue,
} from './file-tree-selection-context';
import {
  applyDirectorySelectionMutation,
  applyFileSelectionMutation,
  type BuildFileTreeRowsOptions,
  buildFileTreeRows,
  buildRowsFromNormalizedTree,
  buildRowsFromWorkerNodes,
  computeNodeSelectionState,
  createFileTreeRowReuseCache,
  type DirectorySelectionTraversalContext,
  type DirectoryToggleState,
  type FileTreeRowBuildSource,
  type FileTreeRowData,
  type FileTreeRowsBuildResult,
  type FileTreeSortMetadata,
  type FileTreeSortOptions,
  getNormalizedImmediateChildren,
  getSelectedDescendantPathsForDirectory,
  hasNormalizedUnloadedDirectoryChildren,
  hasUnloadedDirectoryChildren,
  indexFileNodesByPath,
  type NodeSelectionState,
  resolveDirectorySelectionMutation,
  shouldLoadDirectoryRecursively,
} from './optimized-file-tree-model';
import {
  collectTreePaths,
  useSelectedDirectoryCounts,
} from './optimized-file-tree-selection-counts';
import {
  createFileTreeSelectionStore,
  type FileTreeSelectionInputs,
} from './optimized-file-tree-selection-store';
import { useFileTreeMetadataSource } from './use-file-tree-metadata-source';

/**
 * Painted pitch of one virtualized tree row, in px: a 28px content line (the
 * 24px `h-6` disclosure/checkbox control plus its `my-0.5` margins) and the 1px
 * collapsed `border-b` between rows.
 *
 * This is a MEASURED value, not a design target, and TreeTable takes it
 * literally: a numeric `rowHeight` disables per-row measurement, so the
 * virtualizer's spacer/offset math is only correct while this constant equals
 * what the browser paints. It read 32 for a long time while rows painted 29,
 * which left the scrollport ~110px shorter than the model and put the wrong row
 * under every computed scroll offset. Note that a single row's
 * `getBoundingClientRect().height` reports 28.5 — border collapsing splits the
 * 1px rule across neighbours — so verify changes against the top-to-top pitch,
 * as `file-explorer.test.ts` does.
 */
const ROW_HEIGHT = 29;
// Stable empty fallbacks for foreign (non-focused) trees whose folderState
// does not exist yet — fresh objects per render would defeat memoization.
const EMPTY_SELECTION_SET = new Set<string>();
const EMPTY_EXPLICIT_SELECTION_MODEL = createEmptySelectionModel();
interface IOptimizedFileTreeProps {
  /**
   * Accessible name for this treegrid. Forest sections name their ROOT here:
   * N grids all announcing "File tree" leave a screen-reader user unable to
   * tell which workspace folder they are in.
   */
  ariaLabel?: string | undefined;
  /** Cancel loading for a directory (called on collapse) */
  cancelChildLoading?: ((path: string) => void) | undefined;
  fileTree: IFileNode[];
  folderId: string;
  /**
   * Whether `fileTree` had anything removed by display filtering (view/quick
   * filters) relative to the canonical provider tree. `false` skips the O(N)
   * filtered-path-set build on the normalized (desktop) path — the raw O(1)
   * maps already cover the whole visible universe. Omit when the caller
   * cannot tell (conservative: the set is built).
   */
  isDisplayTreeFiltered?: boolean | undefined;
  /** Whether a folder is being loaded for selection */
  isLoadingForSelection?: boolean | undefined;
  loadingFiles: Set<string>;
  /** Path of the folder being loaded for selection */
  loadingPathForSelection?: string | null | undefined;
  /** Set of directory paths currently loading their children (lazy loading) */
  loadingPaths?: Set<string> | undefined;
  /** Callback to load children of a directory on expand (lazy loading) */
  onLoadChildren?: ((path: string) => Promise<void>) | undefined;
  onRender?: (() => void) | undefined;
  /** Select all files in a folder recursively, loading if needed */
  onSelectFolderRecursively?:
    | ((node: IFileNode) => Promise<{ success: boolean; filePaths: string[] }>)
    | undefined;
  /**
   * Shared-scroller mode (forest sections): forward to TreeTable so this
   * tree virtualizes against the sections column instead of its own viewport.
   */
  scrollParentRef?: React.RefObject<HTMLElement | null> | undefined;
  /**
   * Render TreeTable's own sticky column header. Only the SINGLE-ROOT layout
   * sets this: it owns its viewport, so the header sticks to the scrollport it
   * belongs to. Forest sections stay headerless and the panel renders one
   * header above the shared scroller instead.
   */
  showColumnHeader?: boolean | undefined;
}

const logger = createLogger('OptimizedFileTree');
/**
 * A click on a FILE checkbox. Adding a single file at the cap is a genuine
 * no-op — the checkbox is disabled with a tooltip; the guard here is its
 * keyboard backstop. (Directory clicks are never cap-blocked: deselect must
 * always work, and adds partial-fill with a toast — decision D3.)
 */
function runFileSelectionClick(args: {
  addMultipleSelectedFiles: (folderId: string, paths: string[]) => void;
  folderId: string;
  maxSelectionCount: number;
  nodePath: string;
  removeMultipleSelectedFiles: (folderId: string, paths: string[]) => void;
  selectedCount: number;
  selectionMode: FileExplorerState['selectionModel']['mode'];
  selectionState: NodeSelectionState;
  toggleSelectedFile: (folderId: string, path: string) => void;
}): void {
  if (args.selectionState.wouldExceedLimit) {
    logger.warn('selection click ignored: would exceed selection limit', {
      maxSelectionCount: args.maxSelectionCount,
      path: args.nodePath,
      selectedCount: args.selectedCount,
    });
    return;
  }
  applyFileSelectionMutation({
    addMultipleSelectedFiles: args.addMultipleSelectedFiles,
    folderId: args.folderId,
    nodePath: args.nodePath,
    removeMultipleSelectedFiles: args.removeMultipleSelectedFiles,
    selectionMode: args.selectionMode,
    selectionState: args.selectionState,
    toggleSelectedFile: args.toggleSelectedFile,
  });
}

/**
 * Normalized-path row build: when visible aggregates are active (a filter
 * hides part of the tree), row denominators and completeness flags come from
 * the visible universe; otherwise the raw O(1) maps apply.
 */
function buildNormalizedRowsResult(
  normalizedTreeContext: NonNullable<ReturnType<typeof useOptionalFileTreeNormalizedContext>>,
  options: BuildFileTreeRowsOptions,
  filteredPathSet: Set<string> | null,
  visibleAggregates: VisibleDirectoryAggregates | null
): FileTreeRowsBuildResult {
  return {
    rows: buildRowsFromNormalizedTree(
      normalizedTreeContext.normalizedTreeRef.current,
      options,
      visibleAggregates
        ? (path) => visibleAggregates.fileCountByPath.get(path) ?? 0
        : normalizedTreeContext.getDescendantFileCount,
      filteredPathSet,
      visibleAggregates
        ? (path) => (visibleAggregates.incompleteDirCountByPath.get(path) ?? 0) > 0
        : undefined
    ),
    source: 'normalized' satisfies FileTreeRowBuildSource,
  };
}

/**
 * The add/deselect resolution for a click on a LOADED directory: resolve the
 * mutation against the cap OVER THE VISIBLE FILE SET, apply it, and surface
 * any cap truncation (decision D3: partial-fill is allowed but never silent).
 *
 * Decision D2: `visibleFilePaths` is the (view+quick-filtered) universe the
 * click SELECTS from; the totals and selected-count fed to the resolver come
 * from that same universe so the resolved action matches what the checkbox
 * shows. A resolved REMOVE applies `fullSweepSelectedPaths` instead — deselect
 * always clears hidden residue too.
 */
function runLoadedDirectorySelectionMutation(args: {
  addMultipleSelectedFiles: (folderId: string, paths: string[]) => void;
  folderId: string;
  fullSweepSelectedPaths: string[];
  maxSelectionCount: number;
  nodePath: string;
  removeMultipleSelectedFiles: (folderId: string, paths: string[]) => void;
  selectedCount: number;
  selectedFilePaths: Set<string>;
  showToast: (toast: { description: string; title: string }) => void;
  visibleFilePaths: string[];
}): void {
  if (args.visibleFilePaths.length === 0) {
    // No-silent-fallbacks: a loaded-but-empty (or fully filtered)
    // directory checkbox click must be diagnosable.
    logger.warn('selection click ignored: directory has no selectable files', {
      path: args.nodePath,
    });
    return;
  }

  let visibleSelectedCount = 0;
  for (const path of args.visibleFilePaths) {
    if (isPathSelectedInFolder(args.selectedFilePaths, args.folderId, path)) {
      visibleSelectedCount += 1;
    }
  }

  const selectionMutation = resolveDirectorySelectionMutation({
    allFilePaths: args.visibleFilePaths,
    currentSelectionSize: args.selectedCount,
    directoryTotalFiles: args.visibleFilePaths.length,
    folderId: args.folderId,
    maxSelectionCount: args.maxSelectionCount,
    selectedCount: visibleSelectedCount,
    selectedFilePaths: args.selectedFilePaths,
  });

  if (selectionMutation.action === 'remove') {
    args.removeMultipleSelectedFiles(args.folderId, args.fullSweepSelectedPaths);
    return;
  }

  applyDirectorySelectionMutation({
    addMultipleSelectedFiles: args.addMultipleSelectedFiles,
    folderId: args.folderId,
    mutation: selectionMutation,
    removeMultipleSelectedFiles: args.removeMultipleSelectedFiles,
  });

  if (selectionMutation.limitTruncated) {
    args.showToast({
      description:
        selectionMutation.action === 'add'
          ? `Selected ${selectionMutation.paths.length} more file${
              selectionMutation.paths.length === 1 ? '' : 's'
            } before hitting the limit. Deselect some files or raise the limit to select the rest.`
          : 'Deselect some files or raise the limit to select this folder.',
      title: `Selection limit reached (${args.maxSelectionCount})`,
    });
  }
}

/**
 * Performance telemetry counters for the file tree.
 * Exposed for tests and browser devtools inspection.
 */
export const fileTreeTelemetry = {
  columnsRebuildCount: 0,
  treeRowsRebuildCount: 0,
};

export function resetFileTreeTelemetry(): void {
  fileTreeTelemetry.columnsRebuildCount = 0;
  fileTreeTelemetry.treeRowsRebuildCount = 0;
}

/**
 * TreeTable adapter for file explorer panel.
 * Maintains lazy-loading and recursive selection behavior while converging on shared tree-grid UI.
 */
const OptimizedFileTree = memo<IOptimizedFileTreeProps>(
  ({
    ariaLabel = 'File tree',
    fileTree,
    loadingFiles,
    onRender,
    folderId,
    loadingPaths,
    onLoadChildren,
    cancelChildLoading,
    onSelectFolderRecursively,
    isLoadingForSelection,
    loadingPathForSelection,
    scrollParentRef,
    isDisplayTreeFiltered,
    showColumnHeader = false,
  }) => {
    const store = useFileExplorerStoreContext();
    const { showToast } = useToastManager();
    // This tree's root path — identity scope for expansion selection below and
    // the base for context-menu relative paths.
    const rootPath = useFileExplorerStoreSelector((s) => s.rootDescriptors[folderId]?.path ?? null);
    // Keep a subscribed expansion snapshot for TreeTable render state.
    // Event handlers still use `store.getState()` to avoid stale async toggles.
    // Content equality (#1594b): a selection toggle triggers a secondary store
    // commit that replaces this set's identity without changing its membership.
    // Comparing by content keeps the reference stable across that spurious churn
    // so tree rows do not rebuild on selection; a real expand/collapse changes
    // membership and still yields a fresh reference.
    // Root scoping (#1734 follow-up): the store set is workspace-global across
    // every forest root, so an expansion toggle in ONE root used to invalidate
    // EVERY section. Scoping to this tree's root before the content compare
    // confines row rebuilds to the section that actually changed. With no
    // known root path the set passes through unscoped (single-root behavior).
    const expandedDirectoryPaths = useFileExplorerStoreSelector(
      (s) => scopeExpandedPathsToRoot(s.expandedDirectoryPaths, rootPath),
      setsEqual
    );
    const toggleDirectoryExpansion = useFileExplorerStoreSelector(
      (s) => s.toggleDirectoryExpansion
    );
    const toggleSelectedFile = useFileExplorerStoreSelector((s) => s.toggleSelectedFile);
    const addMultipleSelectedFiles = useFileExplorerStoreSelector(
      (s) => s.addMultipleSelectedFiles
    );
    const removeMultipleSelectedFiles = useFileExplorerStoreSelector(
      (s) => s.removeMultipleSelectedFiles
    );
    const topLevelSelectedFilePaths = useFileExplorerStoreSelector((s) => s.selectedFilePaths);
    const storeCurrentFolderId = useFileExplorerStoreSelector((s) => s.currentFolderId);
    const foreignFolderSelection = useFileExplorerStoreSelector((s) =>
      folderId && s.currentFolderId !== null && folderId !== s.currentFolderId
        ? s.folderStates[folderId]?.selectedFilePaths
        : undefined
    );
    const foreignFolderModel = useFileExplorerStoreSelector((s) =>
      folderId && s.currentFolderId !== null && folderId !== s.currentFolderId
        ? s.folderStates[folderId]?.selectionModel
        : undefined
    );
    // Phase 6 forest hardening: a NON-focused root's tree derives its checks
    // from ITS folderState — the top-level set holds only the FOCUSED root's
    // live selection, so reading it here left foreign sections blank (or
    // flickering through focus switches). The null-focus guard MUST mirror
    // isForeignFolderMutation in the store: with no focused root, writes land
    // top-level, so reads must too.
    const isForeignTree =
      Boolean(folderId) && storeCurrentFolderId !== null && folderId !== storeCurrentFolderId;
    const selectedFilePaths = isForeignTree
      ? (foreignFolderSelection ?? EMPTY_SELECTION_SET)
      : topLevelSelectedFilePaths;
    const maxSelectionCount = useFileExplorerStoreSelector((s) => s.maxSelectionCount);
    const topLevelSelectionModel = useFileExplorerStoreSelector((s) => s.selectionModel);
    const selectionModel = isForeignTree
      ? (foreignFolderModel ?? EMPTY_EXPLICIT_SELECTION_MODEL)
      : topLevelSelectionModel;
    const querySelectionManifest = useFileExplorerStoreSelector((s) => s.querySelectionManifest);
    const contextMenuRootPath = rootPath;
    // The limit math (wouldExceedLimit) uses the WHOLE-FOREST union — the
    // cap is a workspace budget, not a per-tree budget. Per-tree display
    // counts come from selectedDirectoryCounts, not this number.
    const unionSelectionBase = useFileExplorerStoreSelector((s) =>
      getForeignSelectionCount({
        activeRootIds: s.activeRootIds,
        currentFolderId: s.currentFolderId,
        folderStates: s.folderStates,
      })
    );
    const selectedCount = useMemo(() => {
      const focusedEffectiveCount = getSelectionCount(
        topLevelSelectionModel,
        topLevelSelectedFilePaths,
        querySelectionManifest
      );
      return focusedEffectiveCount + unionSelectionBase;
    }, [
      querySelectionManifest,
      topLevelSelectedFilePaths,
      topLevelSelectionModel,
      unionSelectionBase,
    ]);
    // Dedupe in-flight directory loads between rapid expand interactions.
    // Visual loading state still comes from `loadingPaths` or each node's `loadState`.
    const pendingChildLoadPathsRef = useRef<Set<string>>(new Set());
    const isMountedRef = useRef(true);
    useEffect(() => {
      isMountedRef.current = true;
      return () => {
        isMountedRef.current = false;
        pendingChildLoadPathsRef.current.clear();
      };
    }, []);

    const selectedDirectoryCounts = useSelectedDirectoryCounts(
      selectedFilePaths,
      folderId,
      selectionModel,
      querySelectionManifest
    );

    // BST-375: Worker-based tree flattening for large trees.
    // Uses the worker to compute visible nodes off the main thread,
    // falling back to main-thread DFS for small trees.
    const treeContext = useOptionalFileTreeContext();
    const indexContext = useOptionalFileTreeIndexContext();
    const normalizedTreeContext = useOptionalFileTreeNormalizedContext();
    const nullPortRef = useRef<null>(null);
    const workerPortRef = treeContext?.workerPortRef ?? nullPortRef;
    const approximateNodeCount = indexContext?.stats.totalNodes ?? 0;

    const { flattenedNodes, isWorkerEnabled } = useWorkerFlattenedTree({
      approximateNodeCount,
      // The normalized-tree render path (desktop) builds rows on the main
      // thread and ignores the worker's flattened output — disable the worker
      // entirely there so it neither round-trips nor triggers a spurious row
      // rebuild when its discarded result lands.
      enabled: !normalizedTreeContext,
      expandedPaths: expandedDirectoryPaths,
      portRef: workerPortRef,
      treeRevision: normalizedTreeContext?.version ?? fileTree,
    });

    // Build a path-indexed map of all IFileNodes for worker result mapping.
    // Only computed when worker flattening is active to avoid overhead for small trees.
    // Note: depends on fileTree only (not flattenedNodes) to avoid reindexing on every
    // expand/collapse — the index maps paths to IFileNode refs which don't change.
    const fileNodeIndex = useMemo(() => {
      if (!(isWorkerEnabled && !normalizedTreeContext)) {
        return null;
      }
      const index = new Map<string, IFileNode>();
      indexFileNodesByPath(fileTree, index);
      return index;
    }, [isWorkerEnabled, normalizedTreeContext, fileTree]);

    const filteredPathSet = useMemo(() => {
      if (!normalizedTreeContext) {
        return null;
      }
      // Caller declared the display tree unfiltered → null means "no
      // restriction" everywhere this set flows, exactly equivalent to a set
      // covering the whole normalized universe, without the O(N) walk.
      if (isDisplayTreeFiltered === false) {
        return null;
      }

      const pathSet = new Set<string>();
      collectTreePaths(fileTree, pathSet);
      return pathSet;
    }, [normalizedTreeContext, fileTree, isDisplayTreeFiltered]);

    // Visible-universe aggregates (decision D2): when a view/quick filter
    // hides part of the normalized tree, tri-state denominators, completeness
    // flags, and folder-click selection must all come from the VISIBLE set.
    // Null when no filter is active (the display tree covers the whole
    // normalized tree) — raw O(1) maps apply then.
    const normalizedTreeVersion = normalizedTreeContext?.version;
    const visibleAggregates = useMemo<VisibleDirectoryAggregates | null>(() => {
      // The normalized tree lives in a mutable ref; `normalizedTreeVersion` is
      // its only change signal, so reading it here is what keys recomputation.
      void normalizedTreeVersion;
      if (!(normalizedTreeContext && filteredPathSet)) {
        return null;
      }
      if (filteredPathSet.size >= normalizedTreeContext.normalizedTreeRef.current.nodeByPath.size) {
        return null;
      }
      return buildVisibleDirectoryAggregates(
        normalizedTreeContext.normalizedTreeRef.current,
        filteredPathSet
      );
    }, [filteredPathSet, normalizedTreeContext, normalizedTreeVersion]);

    const explorerSort = useOptionalExplorerSort();
    const sortState = explorerSort?.sortState ?? null;
    const rowMetadata = useOptionalFileRowMetadata();
    // The seam is optional by design (file-row-metadata-context): a surface
    // without it renders Name only. Ordering by Type/Tokens/Size is therefore a
    // CAPABILITY, not a guarantee — an empty folderId is treated identically,
    // since a root with no id has no composite keys to read either.
    const canReadSortMetadata = Boolean(rowMetadata) && folderId !== '';
    const setExplorerSortState = explorerSort?.setSortState;
    const hasWarnedAboutMissingSeamRef = useRef(false);
    useEffect(() => {
      if (canReadSortMetadata) {
        return;
      }
      if (!(sortState && setExplorerSortState)) {
        return;
      }
      if (!isExplorerMetadataSortField(sortState.field)) {
        return;
      }
      // Visible degradation, not a crash and not a silent no-op: the persisted
      // preference cannot be served here, so it is reset to the default order
      // and said out loud once per tree.
      if (!hasWarnedAboutMissingSeamRef.current) {
        hasWarnedAboutMissingSeamRef.current = true;
        logger.warn(
          `Explorer sort by "${sortState.field}" needs the file-row metadata seam, which this surface does not mount; restoring the default order`
        );
      }
      setExplorerSortState(null);
    }, [canReadSortMetadata, setExplorerSortState, sortState]);
    const tracksMetadataRevision = sortState?.field === 'size' || sortState?.field === 'tokens';
    const subscribeToSortedMetadata = useCallback(
      (listener: () => void): (() => void) => {
        if (!(tracksMetadataRevision && rowMetadata && folderId)) {
          return () => undefined;
        }
        return rowMetadata.store.subscribeFolder(folderId, listener);
      },
      [folderId, rowMetadata, tracksMetadataRevision]
    );
    const getSortedMetadataRevision = useCallback(
      (): number =>
        tracksMetadataRevision && rowMetadata && folderId
          ? rowMetadata.store.getFolderRevision(folderId)
          : 0,
      [folderId, rowMetadata, tracksMetadataRevision]
    );
    const sortedMetadataRevision = useSyncExternalStore(
      subscribeToSortedMetadata,
      getSortedMetadataRevision,
      getSortedMetadataRevision
    );

    const getSortMetadata = useCallback(
      (node: IFileNode): FileTreeSortMetadata => {
        if (!(rowMetadata && folderId)) {
          // Unreachable: `sortOptions` below refuses to build a metadata sort
          // without the seam, so no comparator can call this. Kept as an
          // assertion rather than a fallback — inventing metadata here would
          // silently order the tree by nothing.
          throw new Error(
            `Explorer sort field "${sortState?.field ?? 'unknown'}" requires the file-row metadata seam`
          );
        }
        const compositeKey = encodeFileSelection(folderId, node.path);
        if (node.type === 'directory') {
          const rollup = rowMetadata.store.getDirectorySnapshot(compositeKey);
          return {
            size: rollup.status === 'complete' ? rollup.size : 'pending',
            tokens: rollup.status === 'complete' ? rollup.tokens : 'pending',
            type: '',
          };
        }
        // peek, not get: the comparator sweeps every projected row, and caching
        // that sweep would grow the store past the subscribed rows and switch
        // its eviction off (BST-1209 review, important finding 2).
        const metadata = rowMetadata.store.peekSnapshot(compositeKey);
        return {
          size: metadata.size ?? 'pending',
          tokens: metadata.tokens,
          type: metadata.type,
        };
      },
      [folderId, rowMetadata, sortState?.field]
    );
    const sortOptions = useMemo<FileTreeSortOptions | undefined>(() => {
      if (!sortState) {
        return;
      }
      if (isExplorerMetadataSortField(sortState.field) && !canReadSortMetadata) {
        // Capability gating: this surface has no metadata seam, so it cannot
        // serve this sort. Fall back to the loader's default order — the
        // persisted state is reset (with a warn) by the effect above, so this
        // is the one render before that lands, not a silent permanent no-op.
        return;
      }
      return {
        getMetadata: getSortMetadata,
        // The per-root revision changes at most once per metadata invalidation
        // batch, so a landing count costs exactly one memoized row rebuild.
        // Carried in the VALUE rather than read for its side effect: a memo
        // whose result does not depend on a dependency is one lint autofix away
        // from silently dropping it.
        metadataRevision: sortedMetadataRevision,
        state: sortState,
      };
    }, [canReadSortMetadata, getSortMetadata, sortState, sortedMetadataRevision]);

    // Keep row structure independent from selectedFilePaths so checkbox toggles
    // do not trigger full tree row reconstruction for large trees.
    // Structural-sharing cache across builds, created once via a useState lazy
    // initializer (the create-once idiom used for selectionStore below). See
    // createFileTreeRowReuseCache for the render-phase-write safety argument.
    const [rowReuseCache] = useState(createFileTreeRowReuseCache);
    const treeRowsBuild = useMemo(() => {
      const measured = measureFileTreeOperation<FileTreeRowsBuildResult>(() => {
        const options: BuildFileTreeRowsOptions = {
          expandedDirectoryPaths,
          folderId,
          loadingFiles,
          ...(sortOptions ? { sort: sortOptions } : {}),
          ...(loadingPaths ? { loadingPaths } : {}),
          ...(isLoadingForSelection === undefined ? {} : { isLoadingForSelection }),
          ...(loadingPathForSelection === undefined ? {} : { loadingPathForSelection }),
        };

        if (normalizedTreeContext) {
          return buildNormalizedRowsResult(
            normalizedTreeContext,
            options,
            filteredPathSet,
            visibleAggregates
          );
        }

        // When worker-flattened nodes are available, use them to avoid main-thread DFS
        if (flattenedNodes && fileNodeIndex) {
          return {
            rows: buildRowsFromWorkerNodes(
              flattenedNodes,
              (path) => fileNodeIndex.get(path),
              options
            ),
            source: 'worker' satisfies FileTreeRowBuildSource,
          };
        }

        return {
          rows: buildFileTreeRows(fileTree, options),
          source: 'main-thread' satisfies FileTreeRowBuildSource,
        };
      });

      // Structural sharing: reuse value-equal rows from the previous build so
      // TreeTable's flatten-level reuse (`a.node === b.node`) hits for rows an
      // expansion/loading change did not touch. When EVERY row is reused in
      // order, keep the previous rows ARRAY identity too — downstream memos
      // (fileNodeByPath, rowDataByPath, TreeTable's flatten) then skip
      // entirely on content-equal rebuilds.
      const rows = rowReuseCache.stabilize(measured.result.rows);

      return {
        rows,
        // Structure, NOT array identity: a sort reorders the array without
        // changing which rows exist, and feeding a reorder to the seam's
        // rollup reconciliation is what closed the BST-1209 rebuild loop.
        structureRevision: rowReuseCache.getStructureRevision(),
        telemetry: {
          durationMs: measured.durationMs,
          event: 'file-tree.row-build' as const,
          rowCount: rows.length,
          source: measured.result.source,
        },
      };
    }, [
      fileTree,
      expandedDirectoryPaths,
      folderId,
      loadingFiles,
      loadingPaths,
      isLoadingForSelection,
      loadingPathForSelection,
      flattenedNodes,
      fileNodeIndex,
      filteredPathSet,
      normalizedTreeContext,
      normalizedTreeContext?.version,
      visibleAggregates,
      rowReuseCache,
      sortOptions,
    ]);
    const treeRows = treeRowsBuild.rows;

    useEffect(() => {
      fileTreeTelemetry.treeRowsRebuildCount++;
      recordFileTreeTelemetry(treeRowsBuild.telemetry);
    }, [treeRowsBuild.telemetry]);

    const fileNodeByPath = useMemo(() => {
      const nodeMap = new Map<string, IFileNode>();
      for (const row of treeRows) {
        nodeMap.set(row.id, row.data.fileNode);
      }
      return nodeMap;
    }, [treeRows]);

    // Row-id → row data, so a keyboard Space on the focused row can toggle the
    // export-selection checkbox (see handleRowCheckboxSpace below).
    const rowDataByPath = useMemo(() => {
      const rowMap = new Map<string, FileTreeRowData>();
      for (const row of treeRows) {
        rowMap.set(row.id, row.data);
      }
      return rowMap;
    }, [treeRows]);

    const { openFileInTab } = useIdeFileEditor();
    const handleTreeRowSelect = useCallback(
      (nodeId: string | null): void => {
        // Same folderId guard as the mouse path — a falsy folderId would compose a
        // malformed compositeKey like '|@|src/index.ts'.
        if (!(nodeId && openFileInTab && folderId)) {
          return;
        }
        const fileNode = fileNodeByPath.get(nodeId);
        if (fileNode?.type !== 'file') {
          return;
        }
        openFileInTab(encodeFileSelection(folderId, fileNode.path));
      },
      [fileNodeByPath, folderId, openFileInTab]
    );

    const renderedExpandedDirectoryPaths = useMemo(() => {
      const nextExpandedPaths = new Set<string>();
      for (const row of treeRows) {
        if (!expandedDirectoryPaths.has(row.id) || row.type !== 'directory') {
          continue;
        }
        if (row.data.fileNode.loadState === 'loaded' || row.data.isChildrenLoading) {
          nextExpandedPaths.add(row.id);
        }
      }
      return nextExpandedPaths;
    }, [expandedDirectoryPaths, treeRows]);

    const getDirectoryToggleState = useCallback(
      (node: IFileNode): DirectoryToggleState => {
        const isChildrenLoadingFromStore = loadingPaths?.has(node.path) ?? false;
        return {
          isChildrenLoading:
            isChildrenLoadingFromStore ||
            node.loadState === 'loading' ||
            pendingChildLoadPathsRef.current.has(node.path),
          isChildrenLoadingFromStore,
          // Read expansion state at invocation time to avoid stale closure snapshots
          // across rapid async expand/collapse interactions.
          isExpanded: store.getState().expandedDirectoryPaths.has(node.path),
        };
      },
      [loadingPaths, store]
    );

    const shouldSkipCollapsedExpansion = useCallback(
      (node: IFileNode, state: DirectoryToggleState): boolean => {
        if (!state.isChildrenLoading) {
          return false;
        }
        if (state.isChildrenLoadingFromStore && cancelChildLoading) {
          cancelChildLoading(node.path);
        }
        return true;
      },
      [cancelChildLoading]
    );

    const collapseExpandedDirectory = useCallback(
      (node: IFileNode, state: DirectoryToggleState): void => {
        if (state.isChildrenLoading && cancelChildLoading) {
          cancelChildLoading(node.path);
        }
        toggleDirectoryExpansion(node.path);
      },
      [cancelChildLoading, toggleDirectoryExpansion]
    );

    const loadChildrenForExpansion = useCallback(
      async (node: IFileNode): Promise<void> => {
        const needsLoad =
          (node.loadState === 'unloaded' || node.loadState === undefined) && onLoadChildren;
        if (!needsLoad) {
          return;
        }

        pendingChildLoadPathsRef.current.add(node.path);
        try {
          await onLoadChildren(node.path);
        } finally {
          pendingChildLoadPathsRef.current.delete(node.path);
        }
      },
      [onLoadChildren]
    );

    const toggleDirectoryNode = useCallback(
      async (node: IFileNode, state: DirectoryToggleState): Promise<void> => {
        if (state.isExpanded) {
          collapseExpandedDirectory(node, state);
          return;
        }

        if (shouldSkipCollapsedExpansion(node, state)) {
          return;
        }

        await loadChildrenForExpansion(node);

        if (!isMountedRef.current) {
          return;
        }

        // A stale async load that resolves after a later user interaction should be a no-op.
        // If another action already expanded this path, avoid toggling it again.
        if (!store.getState().expandedDirectoryPaths.has(node.path)) {
          toggleDirectoryExpansion(node.path);
        }
      },
      [
        collapseExpandedDirectory,
        loadChildrenForExpansion,
        shouldSkipCollapsedExpansion,
        store,
        toggleDirectoryExpansion,
      ]
    );

    const reportToggleExpandError = useCallback(
      (node: IFileNode, error: unknown) => {
        logger.error('Failed to toggle directory expansion', {
          error,
          path: node.path,
        });
        showToast({
          description: `Could not expand "${node.name}". Please try again.`,
          title: 'Failed to load folder',
          variant: 'destructive',
        });
      },
      [showToast]
    );

    const handleToggleExpand = useCallback(
      (nodeId: string) => {
        const node = fileNodeByPath.get(nodeId);
        if (node?.type !== 'directory') {
          return;
        }
        try {
          const toggleState = getDirectoryToggleState(node);
          void toggleDirectoryNode(node, toggleState).catch((error: unknown) => {
            reportToggleExpandError(node, error);
          });
        } catch (error: unknown) {
          reportToggleExpandError(node, error);
        }
      },
      [fileNodeByPath, getDirectoryToggleState, reportToggleExpandError, toggleDirectoryNode]
    );

    const directoryTraversalContext = useMemo<DirectorySelectionTraversalContext>(
      () => ({
        getDirectoryMetadata: (node: IFileNode) => {
          if (node.type !== 'directory') {
            return {
              directoryTotalFiles: 0,
              hasIncompleteDescendants: false,
              hasUnloadedDirectoryChildren: false,
              immediateChildren: [],
            };
          }

          if (normalizedTreeContext) {
            return {
              directoryTotalFiles: visibleAggregates
                ? (visibleAggregates.fileCountByPath.get(node.path) ?? 0)
                : normalizedTreeContext.getDescendantFileCount(node.path),
              hasIncompleteDescendants: visibleAggregates
                ? (visibleAggregates.incompleteDirCountByPath.get(node.path) ?? 0) > 0
                : hasNormalizedIncompleteDescendants(
                    normalizedTreeContext.normalizedTreeRef.current,
                    node.path
                  ),
              hasUnloadedDirectoryChildren: hasNormalizedUnloadedDirectoryChildren(
                normalizedTreeContext.normalizedTreeRef.current,
                node.path,
                filteredPathSet
              ),
              immediateChildren: getNormalizedImmediateChildren(
                normalizedTreeContext.normalizedTreeRef.current,
                node.path,
                filteredPathSet
              ),
            };
          }

          const folderFileCount = fileExplorer.getFolderFileCount(node);
          return {
            directoryTotalFiles: folderFileCount.count,
            hasIncompleteDescendants: !folderFileCount.isComplete,
            hasUnloadedDirectoryChildren: hasUnloadedDirectoryChildren(node),
            immediateChildren: node.children ?? [],
          };
        },
      }),
      [filteredPathSet, normalizedTreeContext, visibleAggregates]
    );

    const getNodeSelectionState = useCallback(
      (rowData: FileTreeRowData): NodeSelectionState =>
        computeNodeSelectionState(
          rowData,
          directoryTraversalContext,
          folderId,
          querySelectionManifest,
          selectionModel,
          selectedFilePaths,
          selectedDirectoryCounts,
          selectedCount,
          maxSelectionCount
        ),
      [
        directoryTraversalContext,
        folderId,
        maxSelectionCount,
        selectedCount,
        selectedDirectoryCounts,
        selectedFilePaths,
        querySelectionManifest,
        selectionModel,
      ]
    );

    const handleNodeSelection = useCallback(
      (rowData: FileTreeRowData) => {
        if (!folderId) {
          return;
        }
        if (isLoadingForSelection) {
          logger.warn('selection click ignored: recursive selection in progress', {
            path: rowData.fileNode.path,
          });
          return;
        }

        const node = rowData.fileNode;
        const selectionState = getNodeSelectionState(rowData);

        if (node.type !== 'directory') {
          runFileSelectionClick({
            addMultipleSelectedFiles,
            folderId,
            maxSelectionCount,
            nodePath: node.path,
            removeMultipleSelectedFiles,
            selectedCount,
            selectionMode: selectionModel.mode,
            selectionState,
            toggleSelectedFile,
          });
          return;
        }

        const directoryNode = normalizedTreeContext?.materializeSubtree(node.path) ?? node;
        const selectedDescendantPaths = getSelectedDescendantPathsForDirectory({
          directoryPath: node.path,
          folderId,
          querySelectionManifest,
          selectedFilePaths,
          selectionModel,
        });

        // Mixed-parent click policy (decision D1, docs/explorer-tristate-spike
        // -2026-07-11.md §5): only a fully CHECKED folder deselects on click.
        // An indeterminate folder click COMPLETES the selection — the native-
        // checkbox and file-picker idiom — by falling through to the add path
        // (or the recursive selector when the subtree still needs loading).
        // The mutation resolver still deselects when nothing remains to add.
        if (selectionState.checkboxState === true && selectedDescendantPaths.length > 0) {
          removeMultipleSelectedFiles(folderId, selectedDescendantPaths);
          return;
        }

        if (shouldLoadDirectoryRecursively(directoryNode) && onSelectFolderRecursively) {
          void onSelectFolderRecursively(directoryNode);
          return;
        }

        // Decision D2: the click's selectable universe is the VISIBLE set.
        // The fallback (web) path's directoryNode already comes from the
        // filtered display tree; the normalized (desktop) path enumerates the
        // raw tree, so restrict it to the visible paths when a filter is on.
        const rawFilePaths = normalizedTreeContext
          ? normalizedTreeContext.getDescendantFilePaths(node.path)
          : fileExplorer.getAllFilePathsInDirectory(directoryNode);
        const visibleFilePaths =
          normalizedTreeContext && filteredPathSet && visibleAggregates
            ? rawFilePaths.filter((path) => filteredPathSet.has(path))
            : rawFilePaths;

        runLoadedDirectorySelectionMutation({
          addMultipleSelectedFiles,
          folderId,
          fullSweepSelectedPaths: selectedDescendantPaths,
          maxSelectionCount,
          nodePath: node.path,
          removeMultipleSelectedFiles,
          selectedCount,
          selectedFilePaths,
          showToast,
          visibleFilePaths,
        });
      },
      [
        folderId,
        getNodeSelectionState,
        toggleSelectedFile,
        onSelectFolderRecursively,
        selectedFilePaths,
        removeMultipleSelectedFiles,
        maxSelectionCount,
        addMultipleSelectedFiles,
        normalizedTreeContext,
        selectedCount,
        isLoadingForSelection,
        selectionModel.mode,
        showToast,
        filteredPathSet,
        visibleAggregates,
      ]
    );
    const handleNodeSelectionEvent = useEventCallback(handleNodeSelection);

    // Keyboard parity (APG): Space on the focused row toggles the export
    // selection checkbox and is consumed (return true) so it does NOT fall
    // through to row activation / open. Enter continues to activate via
    // onSelect → handleTreeRowSelect.
    const handleRowCheckboxSpace = useEventCallback((nodeId: string): boolean => {
      const rowData = rowDataByPath.get(nodeId);
      if (!rowData) {
        return false;
      }
      handleNodeSelectionEvent(rowData);
      return true;
    });

    // Right-click context-menu target plumbing. Depend on the destructured
    // `setTarget` (stable) rather than the controller object, which is NOT
    // referentially stable across renders — keeping handleRowContextMenu
    // stable preserves TreeTable row memoization.
    const contextMenuController = useContextMenuTarget();
    const { setTarget: setContextMenuTarget } = contextMenuController;
    const contextMenuOriginNodeIdRef = useRef<string | null>(null);
    const fileTreeElementRef = useRef<HTMLDivElement>(null);
    const handleRowContextMenu = useCallback(
      (nodeId: string, node: TreeNode<FileTreeRowData>, _event: MouseEvent) => {
        const target = fileNodeToTarget(node.data.fileNode, contextMenuRootPath);
        if (!target) {
          contextMenuOriginNodeIdRef.current = null;
          setContextMenuTarget(null);
          return;
        }
        contextMenuOriginNodeIdRef.current = nodeId;
        setContextMenuTarget(target);
      },
      [contextMenuRootPath, setContextMenuTarget]
    );
    const restoreContextMenuFocus = useCallback(() => {
      const fileTreeElement = fileTreeElementRef.current;
      if (!fileTreeElement?.isConnected) {
        return;
      }

      const originNodeId = contextMenuOriginNodeIdRef.current;
      if (originNodeId) {
        const rows = fileTreeElement.querySelectorAll<HTMLElement>('[data-node-id]');
        for (const row of rows) {
          if (row.dataset['nodeId'] === originNodeId) {
            row.focus();
            return;
          }
        }
      }

      const treegrid = fileTreeElement.querySelector<HTMLElement>('[role="treegrid"]');
      if (!treegrid) {
        logger.error('Context menu focus restore failed: file treegrid is unavailable', {
          originNodeId,
        });
        return;
      }
      treegrid.focus();
    }, []);
    const resetContextMenuTarget = useCallback(() => {
      contextMenuOriginNodeIdRef.current = null;
      setContextMenuTarget(null);
    }, [setContextMenuTarget]);

    // Register THIS root's enumeration with the panel-level metadata seam so
    // the Tokens/Size cells can read real values (and folder rollups) for this
    // tree without the panel knowing how any root's tree is shaped.
    useFileTreeMetadataSource({
      fileTree,
      filteredPathSet,
      folderId,
      normalizedTreeContext,
      rowStructureRevision: treeRowsBuild.structureRevision,
      visibleAggregates,
    });

    // Columns stay STABLE across selection changes: selection state is handled
    // inside the cells via context, not via column cell closures. This prevents
    // all visible rows from re-rendering on every checkbox toggle. The only
    // legitimate rebuild trigger is the visible-column set changing.
    const { columnWidths, visibleMetadataColumnIds } = useExplorerColumns();
    const columns = useMemo<TreeTableColumn<FileTreeRowData>[]>(() => {
      fileTreeTelemetry.columnsRebuildCount++;
      return buildFileTreeColumns({
        onSelectionChange: handleNodeSelectionEvent,
        visibleMetadataColumnIds,
      });
    }, [handleNodeSelectionEvent, visibleMetadataColumnIds]);
    const treeTableSortState = useMemo(
      () =>
        sortState
          ? { columnId: sortState.field, direction: sortState.direction }
          : { columnId: null, direction: null },
      [sortState]
    );
    const handleSortChange = useEventCallback(
      (columnId: string, direction: 'asc' | 'desc' | null): void => {
        if (!explorerSort) {
          return;
        }
        if (direction === null) {
          explorerSort.setSortState(null);
          return;
        }
        if (!isExplorerSortField(columnId)) {
          throw new Error(`Unsupported Explorer sort column: ${columnId}`);
        }
        explorerSort.setSortState({ direction, field: columnId });
      }
    );

    // Widths come from the columns context (persisted, then shrunk to fit the
    // panel) so every section and the panel-level forest header render ONE
    // grid. Resizes are forwarded per CHANGED column rather than as the whole
    // map: TreeTable echoes back the widths it was given, so a `setAll` here
    // would persist the shrunk values and permanently lose the width the user
    // actually chose once the panel widened again.
    const setColumn = useExplorerColumnSizesStore((state) => state.setColumn);
    const columnWidthsRef = useRef(columnWidths);
    useEffect(() => {
      columnWidthsRef.current = columnWidths;
    });
    const handleColumnSizesChange = useEventCallback((next: Record<string, number>) => {
      for (const [columnId, width] of Object.entries(next)) {
        if (columnWidthsRef.current[columnId] !== width) {
          setColumn(columnId, width);
        }
      }
    });

    useEffect(() => {
      onRender?.();
    }, [onRender]);

    // Per-node selection store (#1594). All selection-DERIVED inputs are funneled
    // through it so each cell subscribes to only its own state. The current
    // inputs, recomputed each render:
    const selectionInputs = useMemo<FileTreeSelectionInputs>(
      () => ({
        directoryTraversalContext,
        folderId: folderId ?? '',
        maxSelectionCount,
        querySelectionManifest,
        selectedCount,
        selectedDirectoryCounts,
        selectedFilePaths,
        selectionModel,
      }),
      [
        directoryTraversalContext,
        folderId,
        maxSelectionCount,
        querySelectionManifest,
        selectedCount,
        selectedDirectoryCounts,
        selectedFilePaths,
        selectionModel,
      ]
    );
    // The store is created once (stable identity) via a useState lazy
    // initializer — the React-approved create-once idiom (a plain value, not a
    // ref, so it is safe to read + mutate during render). It is never
    // re-created.
    const [selectionStore] = useState(() => createFileTreeSelectionStore(selectionInputs));
    // Render-safe: pure write of the current inputs so a child rendering NOW
    // (e.g. a freshly mounted row) reads fresh state via getNodeState.
    selectionStore.setInputs(selectionInputs);
    // Notify subscribers whenever the inputs change (selection toggles land here).
    useEffect(() => {
      selectionStore.notify();
    }, [selectionStore, selectionInputs]);

    // STABLE context: only fields that do NOT change per toggle, so a cell
    // reading it does not re-render on selection. Selection-derived state is
    // read from `store` per node instead.
    const selectionContextValue = useMemo<FileTreeSelectionContextValue>(
      () => ({
        folderId: folderId ?? '',
        isDirectorySelectionLocked: Boolean(isLoadingForSelection),
        maxSelectionCount,
        openFileInTab,
        store: selectionStore,
      }),
      [folderId, isLoadingForSelection, maxSelectionCount, openFileInTab, selectionStore]
    );

    return (
      <FileTreeSelectionContext.Provider value={selectionContextValue}>
        <ActionContextMenu
          controller={contextMenuController}
          onCloseAutoFocus={restoreContextMenuFocus}
        >
          {/* Capture-phase reset: runs before any row's onContextMenu so every
              right-click starts with a clean target; rows then claim it via
              handleRowContextMenu. An unclaimed right-click leaves the target
              null and ActionContextMenu suppresses the empty menu. */}
          <div
            className="relative h-full min-h-0 min-w-0 flex-1 overflow-hidden"
            data-testid="file-tree-scroll-container"
            onContextMenuCapture={resetContextMenuTarget}
          >
            <div
              className="relative h-full min-h-0 min-w-0"
              data-testid="file-tree"
              ref={fileTreeElementRef}
            >
              {/*
              selectionMode="single" + selectedId={null} is intentional: we use the
              tree's keyboard-driven `onSelect` callback as a one-shot "activate this
              row" gesture (Enter/Space → open file as a tab), not as a persistent
              selection state. The actual multi-select state for context export lives
              on the per-row LightweightCheckbox.

              a11y trade-off: every row therefore announces aria-selected="false",
              which is correct ARIA for a row in a selectable tree — but a future
              full screen-reader audit (VoiceOver / NVDA) should confirm the
              checkbox-state announcement isn't preceded by redundant "not selected"
              chatter on rapid arrow-key navigation. If it is, the cleanest fix is
              to either teach TreeTable to opt out of aria-selected, or to maintain
              a real selectedId that follows the focused row.
            */}
              <TreeTable
                ariaLabel={ariaLabel}
                className="file-tree"
                columnSizes={columnWidths}
                columns={columns}
                expandedIds={renderedExpandedDirectoryPaths}
                maxHeight="none"
                nodes={treeRows}
                nodesArePreFlattened={true}
                onCheckboxSpace={handleRowCheckboxSpace}
                onColumnSizesChange={handleColumnSizesChange}
                onRowContextMenu={handleRowContextMenu}
                onSelect={handleTreeRowSelect}
                onToggleExpand={handleToggleExpand}
                overscan={10}
                rowHeight={ROW_HEIGHT}
                selectedId={null}
                selectionMode="single"
                // Single-root only. In forest mode N sections share ONE
                // scroller, so N sticky headers would stack against the same
                // scrollport; the panel renders one header above it instead.
                showHeader={showColumnHeader}
                sortState={treeTableSortState}
                windowingStrategy="virtual"
                {...(explorerSort ? { onSortChange: handleSortChange } : {})}
                {...(scrollParentRef !== undefined && { scrollParentRef })}
              />
            </div>
          </div>
        </ActionContextMenu>
      </FileTreeSelectionContext.Provider>
    );
  }
);

OptimizedFileTree.displayName = 'OptimizedFileTree';

export default OptimizedFileTree;
