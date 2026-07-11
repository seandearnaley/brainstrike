import { getForeignSelectionCount } from '@brainstrike/file-explorer';
import { useToastManager } from '@brainstrike/file-explorer-hooks';
import { useEventCallback } from '@brainstrike/hooks';
import type { FileExplorerState, IFileNode } from '@brainstrike/types';
import { createEmptySelectionModel } from '@brainstrike/types';
import {
  ActionContextMenu,
  LightweightCheckbox,
  type TreeNode,
  TreeTable,
  type TreeTableColumn,
  useContextMenuTarget,
  useIdeFileEditor,
} from '@brainstrike/ui';
import { memoizedFileExplorer as fileExplorer } from '@brainstrike/utils/file-explorer-utils';
import { createLogger } from '@brainstrike/utils/logger';
import { encodeFileSelection } from '@brainstrike/utils/selection-utils';
import {
  File as FileIcon,
  Folder,
  FolderOpen,
  Link2 as Link2Icon,
  Loader2,
  MoreHorizontal as MoreHorizontalIcon,
} from 'lucide-react';
import {
  createContext,
  type MouseEvent,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import { fileNodeToTarget } from '../context-actions/file-entry-target';
import { useWorkerFlattenedTree } from '../hooks/use-worker-flattened-tree';
import {
  useFileExplorerStoreContext,
  useFileExplorerStoreSelector,
} from '../shell/file-explorer-provider';
import { measureFileTreeOperation, recordFileTreeTelemetry } from '../utils/file-tree-telemetry';
import { hasNormalizedIncompleteDescendants } from '../utils/normalized-file-tree';
import { getSelectionCount } from '../utils/selection-projection';
import {
  useOptionalFileTreeContext,
  useOptionalFileTreeIndexContext,
  useOptionalFileTreeNormalizedContext,
} from './file-tree-provider';
import {
  applyDirectorySelectionMutation,
  applyFileSelectionMutation,
  type BuildFileTreeRowsOptions,
  buildFileTreeRows,
  buildRowsFromNormalizedTree,
  buildRowsFromWorkerNodes,
  computeNodeSelectionState,
  type DirectorySelectionTraversalContext,
  type DirectoryToggleState,
  type FileTreeRowBuildSource,
  type FileTreeRowData,
  type FileTreeRowsBuildResult,
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

/** Pixel height of one virtualized tree row. */
const ROW_HEIGHT = 32;
// Stable empty fallbacks for foreign (non-focused) trees whose folderState
// does not exist yet — fresh objects per render would defeat memoization.
const EMPTY_SELECTION_SET = new Set<string>();
const EMPTY_EXPLICIT_SELECTION_MODEL = createEmptySelectionModel();
interface IOptimizedFileTreeProps {
  /** Cancel loading for a directory (called on collapse) */
  cancelChildLoading?: ((path: string) => void) | undefined;
  fileTree: IFileNode[];
  folderId: string;
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
}

const logger = createLogger('OptimizedFileTree');
interface TreeNodeIconProps {
  isExpanded: boolean;
  isLoading: boolean;
  nodeName: string;
  nodeType: IFileNode['type'];
}

function TreeNodeIcon({ isLoading, nodeType, nodeName, isExpanded }: TreeNodeIconProps) {
  if (isLoading) {
    return (
      <Loader2
        aria-label={`Loading ${nodeName}`}
        className="animate-spin text-blue-500 dark:text-blue-400"
        size={16}
      />
    );
  }
  if (nodeType === 'file' || nodeType === 'loadMore') {
    return <FileIcon className="text-gray-500 dark:text-gray-400" size={16} />;
  }
  if (nodeType === 'directory') {
    if (isExpanded) {
      return <FolderOpen className="text-blue-500 dark:text-blue-400" size={16} />;
    }
    return <Folder className="text-blue-500 dark:text-blue-400" size={16} />;
  }
  return null;
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
 * Context for directory selection counts — allows directory cells to access
 * aggregate selection state without embedding it in the columns definition.
 * File cells use per-path Zustand selectors instead (more granular).
 */
interface FileTreeSelectionContextValue {
  directoryTraversalContext: DirectorySelectionTraversalContext;
  folderId: string;
  isDirectorySelectionLocked: boolean;
  maxSelectionCount: number;
  /**
   * Opens a file as a workspace tab. Hoisted into the shared selection context so each
   * virtualized row reuses the parent's single useIdeFileEditor subscription instead of
   * paying for one per visible row.
   */
  openFileInTab: ((compositeKey: string) => void) | undefined;
  querySelectionManifest: FileExplorerState['querySelectionManifest'];
  selectedCount: number;
  selectedDirectoryCounts: Map<string, number>;
  selectedFilePaths: Set<string>;
  selectionModel: FileExplorerState['selectionModel'];
}

const FileTreeSelectionContext = createContext<FileTreeSelectionContextValue | null>(null);

function useFileTreeSelection(): FileTreeSelectionContextValue {
  const ctx = useContext(FileTreeSelectionContext);
  if (!ctx) {
    throw new Error('useFileTreeSelection must be used within FileTreeSelectionContext');
  }
  return ctx;
}

/**
 * Cell content component with per-row store subscriptions.
 *
 * File nodes use a per-path Zustand selector for O(1) re-render on selection.
 * Directory nodes read from FileTreeSelectionContext for aggregate counts.
 *
 * This component re-renders independently of TreeTableRow — columns stay stable,
 * so TreeTableRow's React.memo prevents row-level re-renders on selection changes.
 */
interface FileTreeCellContentProps {
  isExpanded: boolean;
  onSelectionChange: (rowData: FileTreeRowData) => void;
  rowData: FileTreeRowData;
}

function FileTreeCellContent({ rowData, isExpanded, onSelectionChange }: FileTreeCellContentProps) {
  const fileNode = rowData.fileNode;
  const {
    directoryTraversalContext,
    folderId,
    isDirectorySelectionLocked,
    maxSelectionCount,
    openFileInTab,
    querySelectionManifest,
    selectedCount,
    selectedDirectoryCounts,
    selectedFilePaths,
    selectionModel,
  } = useFileTreeSelection();

  /**
   * VS Code-style open semantics. The mouse and keyboard paths are intentionally
   * routed through different DOM nodes for different reasons — both end up calling
   * `openFileInTab` with the same compositeKey:
   *
   * - Mouse: this `handleFileNameClick` fires on the file-name span. We
   *   `stopPropagation()` so the click does NOT bubble to the parent TreeTable row,
   *   which would otherwise also fire `onSelect` and trigger a duplicate open.
   * - Keyboard: TreeTable's row owns focus. Enter/Space on a focused file row fires
   *   TreeTable's `onSelect`, which the parent `OptimizedFileTree` wires to
   *   `handleTreeRowSelect` → `openFileInTab`.
   *
   * Selection (the per-row checkbox) is the multi-select affordance for context
   * export and is independent of both paths.
   *
   * a11y: we deliberately do NOT mark this label `role="button"` because the parent
   * TreeTable row already owns treegrid row semantics; nesting interactive roles
   * announces awkwardly on some screen-reader + browser combos.
   */
  const handleFileNameClick = useEventCallback((event: MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
    // folderId guard: the FileTreeSelectionContext provider falls back to '' when
    // upstream folderId is undefined (line ~2200). An empty folderId would produce
    // a malformed compositeKey like '|@|src/index.ts'; skip the open instead.
    if (fileNode.type !== 'file' || !openFileInTab || !folderId) {
      return;
    }
    openFileInTab(encodeFileSelection(folderId, fileNode.path));
  });

  const selectionState = computeNodeSelectionState(
    rowData,
    directoryTraversalContext,
    folderId,
    querySelectionManifest,
    selectionModel,
    selectedFilePaths,
    selectedDirectoryCounts,
    selectedCount,
    maxSelectionCount
  );
  const isRuleSelected =
    fileNode.type === 'file' &&
    selectionModel.mode === 'rules' &&
    (selectionModel.materializedPaths?.has(fileNode.path) ?? false);

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      <div
        className="flex w-4 flex-shrink-0 items-center justify-center"
        title={
          rowData.isLoadingForSelection
            ? 'Loading folder contents...'
            : selectionState.wouldExceedLimit
              ? `Cannot select more than ${maxSelectionCount} files`
              : undefined
        }
      >
        {rowData.isLoadingForSelection ? (
          <Loader2
            aria-label={`Loading ${fileNode.name} for selection`}
            className="h-4 w-4 animate-spin text-blue-500"
          />
        ) : (
          <LightweightCheckbox
            aria-label={`Select ${fileNode.name}`}
            checked={selectionState.checkboxState}
            className="h-4 w-4"
            disabled={
              selectionState.wouldExceedLimit ||
              (isDirectorySelectionLocked && fileNode.type === 'directory')
            }
            id={fileNode.path}
            onCheckedChange={() => onSelectionChange(rowData)}
          />
        )}
      </div>

      <div className="flex w-4 flex-shrink-0 items-center justify-center">
        <TreeNodeIcon
          isExpanded={isExpanded}
          isLoading={rowData.isFileLoading}
          nodeName={fileNode.name}
          nodeType={fileNode.type}
        />
      </div>

      {/* The parent TreeTable row owns treegrid semantics; avoid adding a nested button role here. */}
      <div
        {...(fileNode.type === 'file' && openFileInTab
          ? {
              // cursor-pointer + hover underline only when the click actually does
              // something: if openFileInTab isn't registered (no IdeFileEditor host
              // wired up), the visual affordance would lie about the row's behavior.
              className: 'group/file-row flex min-w-0 flex-1 cursor-pointer items-center',
              onClick: handleFileNameClick,
            }
          : { className: 'flex min-w-0 flex-1 items-center' })}
      >
        {fileNode.isSymbolicLink && (
          <Link2Icon className="mr-1.5 h-4 w-4 flex-shrink-0 text-blue-500" />
        )}
        <span className="truncate text-sm leading-4 group-hover/file-row:underline">
          {fileNode.name}
        </span>
        {isRuleSelected ? <span className="sr-only">Selected by rule</span> : null}
        {fileNode.type === 'directory' && fileNode.isDepthTruncated && (
          <MoreHorizontalIcon className="ml-1.5 h-4 w-4 flex-shrink-0 text-gray-500" />
        )}
      </div>
    </div>
  );
}

/**
 * TreeTable adapter for file explorer panel.
 * Maintains lazy-loading and recursive selection behavior while converging on shared tree-grid UI.
 */
const OptimizedFileTree = memo<IOptimizedFileTreeProps>(
  ({
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
  }) => {
    const store = useFileExplorerStoreContext();
    const { showToast } = useToastManager();
    // Keep a subscribed expansion snapshot for TreeTable render state.
    // Event handlers still use `store.getState()` to avoid stale async toggles.
    const expandedDirectoryPaths = useFileExplorerStoreSelector((s) => s.expandedDirectoryPaths);
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
    const contextMenuRootPath = useFileExplorerStoreSelector(
      (s) => s.rootDescriptors[folderId]?.path ?? null
    );
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

      const pathSet = new Set<string>();
      collectTreePaths(fileTree, pathSet);
      return pathSet;
    }, [normalizedTreeContext, fileTree]);

    // Keep row structure independent from selectedFilePaths so checkbox toggles
    // do not trigger full tree row reconstruction for large trees.
    const treeRowsBuild = useMemo(() => {
      const measured = measureFileTreeOperation<FileTreeRowsBuildResult>(() => {
        const options: BuildFileTreeRowsOptions = {
          expandedDirectoryPaths,
          folderId,
          loadingFiles,
          ...(loadingPaths ? { loadingPaths } : {}),
          ...(isLoadingForSelection === undefined ? {} : { isLoadingForSelection }),
          ...(loadingPathForSelection === undefined ? {} : { loadingPathForSelection }),
        };

        if (normalizedTreeContext) {
          return {
            rows: buildRowsFromNormalizedTree(
              normalizedTreeContext.normalizedTreeRef.current,
              options,
              normalizedTreeContext.getDescendantFileCount,
              filteredPathSet
            ),
            source: 'normalized' satisfies FileTreeRowBuildSource,
          };
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

      return {
        rows: measured.result.rows,
        telemetry: {
          durationMs: measured.durationMs,
          event: 'file-tree.row-build' as const,
          rowCount: measured.result.rows.length,
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
              directoryTotalFiles: normalizedTreeContext.getDescendantFileCount(node.path),
              hasIncompleteDescendants: hasNormalizedIncompleteDescendants(
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
      [filteredPathSet, normalizedTreeContext]
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
        if (selectionState.wouldExceedLimit) {
          logger.warn('selection click ignored: would exceed selection limit', {
            maxSelectionCount,
            path: node.path,
            selectedCount,
          });
          return;
        }

        if (node.type !== 'directory') {
          applyFileSelectionMutation({
            addMultipleSelectedFiles,
            folderId,
            nodePath: node.path,
            removeMultipleSelectedFiles,
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

        if (selectionState.checkboxState !== false && selectedDescendantPaths.length > 0) {
          removeMultipleSelectedFiles(folderId, selectedDescendantPaths);
          return;
        }

        if (shouldLoadDirectoryRecursively(directoryNode) && onSelectFolderRecursively) {
          void onSelectFolderRecursively(directoryNode);
          return;
        }

        const directoryTotalFiles = rowData.directoryTotalFiles;
        if (directoryTotalFiles === 0) {
          // No-silent-fallbacks: a loaded-but-empty (or fully filtered)
          // directory checkbox click must be diagnosable.
          logger.warn('selection click ignored: directory has no selectable files', {
            path: node.path,
          });
          return;
        }

        const directorySelectedCount = selectedDirectoryCounts.get(node.path) ?? 0;

        const allFilePaths = normalizedTreeContext
          ? normalizedTreeContext.getDescendantFilePaths(node.path)
          : fileExplorer.getAllFilePathsInDirectory(directoryNode);

        const selectionMutation = resolveDirectorySelectionMutation({
          allFilePaths,
          currentSelectionSize: selectedCount,
          directoryTotalFiles,
          folderId,
          maxSelectionCount,
          selectedCount: directorySelectedCount,
          selectedFilePaths,
        });

        applyDirectorySelectionMutation({
          addMultipleSelectedFiles,
          folderId,
          mutation: selectionMutation,
          removeMultipleSelectedFiles,
        });
      },
      [
        folderId,
        getNodeSelectionState,
        toggleSelectedFile,
        onSelectFolderRecursively,
        selectedFilePaths,
        selectedDirectoryCounts,
        removeMultipleSelectedFiles,
        maxSelectionCount,
        addMultipleSelectedFiles,
        normalizedTreeContext,
        selectedCount,
        isLoadingForSelection,
        selectionModel.mode,
      ]
    );
    const handleNodeSelectionEvent = useEventCallback(handleNodeSelection);

    // Right-click context-menu target plumbing. Depend on the destructured
    // `setTarget` (stable) rather than the controller object, which is NOT
    // referentially stable across renders — keeping handleRowContextMenu
    // stable preserves TreeTable row memoization.
    const contextMenuController = useContextMenuTarget();
    const { setTarget: setContextMenuTarget } = contextMenuController;
    const handleRowContextMenu = useCallback(
      (_nodeId: string, node: TreeNode<FileTreeRowData>, _event: MouseEvent) => {
        setContextMenuTarget(fileNodeToTarget(node.data.fileNode, contextMenuRootPath));
      },
      [contextMenuRootPath, setContextMenuTarget]
    );

    // Columns are now STABLE across selection changes. Selection state is handled
    // inside FileTreeCellContent via context, not via column cell closures.
    // This prevents all visible rows from re-rendering on every checkbox toggle.
    const columns = useMemo<TreeTableColumn<FileTreeRowData>[]>(() => {
      fileTreeTelemetry.columnsRebuildCount++;
      return [
        {
          cell: ({ node, isExpanded }) => (
            <FileTreeCellContent
              isExpanded={isExpanded}
              onSelectionChange={handleNodeSelectionEvent}
              rowData={node.data}
            />
          ),
          className: '!p-0',
          id: 'name',
        },
      ];
    }, [handleNodeSelectionEvent]);

    useEffect(() => {
      onRender?.();
    }, [onRender]);

    // Selection context value — changes when selection state changes, causing
    // FileTreeCellContent components to re-render (but NOT TreeTableRow components,
    // because columns stays stable).
    const selectionContextValue = useMemo<FileTreeSelectionContextValue>(
      () => ({
        directoryTraversalContext,
        folderId: folderId ?? '',
        isDirectorySelectionLocked: Boolean(isLoadingForSelection),
        maxSelectionCount,
        openFileInTab,
        querySelectionManifest,
        selectedCount,
        selectedDirectoryCounts,
        selectedFilePaths,
        selectionModel,
      }),
      [
        directoryTraversalContext,
        folderId,
        isLoadingForSelection,
        maxSelectionCount,
        openFileInTab,
        querySelectionManifest,
        selectedCount,
        selectedDirectoryCounts,
        selectedFilePaths,
        selectionModel,
      ]
    );

    return (
      <FileTreeSelectionContext.Provider value={selectionContextValue}>
        <ActionContextMenu controller={contextMenuController}>
          {/* Capture-phase reset: runs before any row's onContextMenu so every
              right-click starts with a clean target; rows then claim it via
              handleRowContextMenu. An unclaimed right-click leaves the target
              null and ActionContextMenu suppresses the empty menu. */}
          <div
            className="relative h-full min-h-0 flex-1 overflow-y-auto"
            data-testid="file-tree-scroll-container"
            onContextMenuCapture={() => setContextMenuTarget(null)}
          >
            <div className="relative h-full" data-testid="file-tree">
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
                ariaLabel="File tree"
                className="file-tree h-full min-h-0 flex-1"
                columns={columns}
                expandedIds={renderedExpandedDirectoryPaths}
                maxHeight="none"
                nodes={treeRows}
                nodesArePreFlattened={true}
                onRowContextMenu={handleRowContextMenu}
                onSelect={handleTreeRowSelect}
                onToggleExpand={handleToggleExpand}
                overscan={10}
                rowHeight={ROW_HEIGHT}
                selectedId={null}
                selectionMode="single"
                showHeader={false}
                windowingStrategy="virtual"
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
