import { useToastManager } from '@brainstrike/file-explorer-hooks';
import type { FlattenedNode } from '@brainstrike/file-tree-worker';
import { useEventCallback } from '@brainstrike/hooks';
import type { FileExplorerState, IFileNode } from '@brainstrike/types';
import {
  LightweightCheckbox,
  type TreeNode,
  TreeTable,
  type TreeTableColumn,
} from '@brainstrike/ui';
import { memoizedFileExplorer as fileExplorer } from '@brainstrike/utils/file-explorer-utils';
import { createLogger } from '@brainstrike/utils/logger';
import { encodeFileSelection, isPathSelectedInFolder } from '@brainstrike/utils/selection-utils';
import {
  File as FileIcon,
  Folder,
  FolderOpen,
  Link2 as Link2Icon,
  Loader2,
  MoreHorizontal as MoreHorizontalIcon,
  Sparkles,
} from 'lucide-react';
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import {
  useFileExplorerStoreContext,
  useFileExplorerStoreSelector,
} from './file-explorer-provider';
import { useOptionalFileTreeContext, useOptionalFileTreeIndexContext } from './file-tree-provider';
import { useWorkerFlattenedTree } from './hooks/use-worker-flattened-tree';
// TODO(BST-312): extract ROW_HEIGHT into a shared constant and retire legacy row component.
import { ROW_HEIGHT } from './optimized-file-tree-row';

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

interface FileTreeRowData {
  directoryTotalFiles: number;
  fileNode: IFileNode;
  isChildrenLoading: boolean;
  isFileLoading: boolean;
  isLoadingForSelection: boolean;
  isRuleSelected: boolean;
}

interface BuildFileTreeRowsOptions {
  expandedDirectoryPaths: Set<string>;
  folderId: string;
  isLoadingForSelection?: boolean;
  loadingFiles: Set<string>;
  loadingPathForSelection?: string | null;
  loadingPaths?: Set<string>;
  selectionModel: FileExplorerState['selectionModel'];
}

interface StackEntry {
  depth: number;
  node: IFileNode;
  parentId: string | null;
}

interface NodeSelectionState {
  checkboxState: boolean | 'indeterminate';
  wouldExceedLimit: boolean;
}

type DirectorySelectionMutationAction = 'add' | 'remove' | 'none';

interface DirectorySelectionMutationInput {
  allFilePaths: string[];
  directoryTotalFiles: number;
  folderId: string;
  maxSelectionCount: number;
  selectedCount: number;
  selectedFilePaths: Set<string>;
}

interface DirectorySelectionMutation {
  action: DirectorySelectionMutationAction;
  paths: string[];
}

interface DirectoryToggleState {
  isChildrenLoading: boolean;
  isChildrenLoadingFromStore: boolean;
  isExpanded: boolean;
}

const logger = createLogger('OptimizedFileTree');
// Bound ancestor-path cache growth for large workspaces (15k+ files) while
// keeping hot paths resident across frequent selection changes.
const MAX_SELECTED_PATH_ANCESTOR_CACHE_ENTRIES = 50_000;
// Retain the most recently touched half to avoid a full cold-cache cliff.
const SELECTED_PATH_ANCESTOR_CACHE_RETAIN_ENTRIES = 25_000;
const EMPTY_SELECTION_PATHS: string[] = [];

interface SelectedDirectoryCountBuildResult {
  directoryCounts: Map<string, number>;
  selectedPathAncestorCache: Map<string, string[]>;
}

interface SelectedDirectoryCountSnapshot {
  folderId: string;
  selectedDirectoryCounts: Map<string, number>;
  selectedFilePaths: Set<string> | null;
  selectedPathAncestorCache: Map<string, string[]>;
}

interface SelectedPathAncestorResolver {
  getAncestorPaths: (filePath: string) => string[];
  getResolvedCache: () => Map<string, string[]>;
}

function incrementDirectoryCount(
  directoryCounts: Map<string, number>,
  directoryPath: string
): void {
  directoryCounts.set(directoryPath, (directoryCounts.get(directoryPath) ?? 0) + 1);
}

function evictOldestAncestorCacheEntries(selectedPathAncestorCache: Map<string, string[]>): void {
  if (selectedPathAncestorCache.size < MAX_SELECTED_PATH_ANCESTOR_CACHE_ENTRIES) {
    return;
  }

  // Keep the most recently touched half to avoid a full cache cliff.
  // Linear key-iterator eviction is intentional here to avoid allocating a
  // large transient key array during high-cardinality cache churn.
  let entriesToEvict = Math.max(
    1,
    selectedPathAncestorCache.size - SELECTED_PATH_ANCESTOR_CACHE_RETAIN_ENTRIES
  );
  while (entriesToEvict > 0) {
    const oldestEntry = selectedPathAncestorCache.keys().next();
    if (oldestEntry.done) {
      break;
    }
    selectedPathAncestorCache.delete(oldestEntry.value);
    entriesToEvict -= 1;
  }
}

function computeAncestorDirectoryPaths(filePath: string): string[] {
  const ancestorPaths: string[] = [];
  let separatorIndex = filePath.lastIndexOf('/');
  while (separatorIndex > 0) {
    ancestorPaths.push(filePath.slice(0, separatorIndex));
    separatorIndex = filePath.lastIndexOf('/', separatorIndex - 1);
  }

  return ancestorPaths;
}

function createSelectedPathAncestorResolver(
  selectedPathAncestorCache: Map<string, string[]>
): SelectedPathAncestorResolver {
  let nextCache: Map<string, string[]> | null = null;
  const touchedCacheHitPaths = new Set<string>();

  const getMutableCache = (): Map<string, string[]> => {
    if (!nextCache) {
      nextCache = new Map(selectedPathAncestorCache);
    }
    return nextCache;
  };

  const applyTouchedCacheHits = (cache: Map<string, string[]>): void => {
    for (const touchedPath of touchedCacheHitPaths) {
      const cachedAncestors = cache.get(touchedPath);
      if (!cachedAncestors) {
        continue;
      }
      // Refresh insertion order on hits so eviction remains LRU-oriented.
      cache.delete(touchedPath);
      cache.set(touchedPath, cachedAncestors);
    }
  };

  return {
    getAncestorPaths(filePath: string): string[] {
      const sourceCache = nextCache ?? selectedPathAncestorCache;
      const cachedAncestors = sourceCache.get(filePath);
      if (cachedAncestors) {
        touchedCacheHitPaths.add(filePath);
        return cachedAncestors;
      }

      const ancestorPaths = computeAncestorDirectoryPaths(filePath);
      const mutableCache = getMutableCache();
      // Guard long-running sessions against unbounded path growth.
      evictOldestAncestorCacheEntries(mutableCache);
      mutableCache.set(filePath, ancestorPaths);
      return ancestorPaths;
    },
    getResolvedCache(): Map<string, string[]> {
      if (nextCache) {
        if (touchedCacheHitPaths.size > 0) {
          applyTouchedCacheHits(nextCache);
        }
        return nextCache;
      }
      if (touchedCacheHitPaths.size === 0) {
        return selectedPathAncestorCache;
      }

      const refreshedCache = new Map(selectedPathAncestorCache);
      applyTouchedCacheHits(refreshedCache);
      return refreshedCache;
    },
  };
}

function buildSelectedDirectoryCounts(
  selectedFilePaths: Set<string>,
  folderId: string,
  selectedPathAncestorCache: Map<string, string[]>
): SelectedDirectoryCountBuildResult {
  const directoryCounts = new Map<string, number>();
  if (!(folderId && selectedFilePaths.size > 0)) {
    return {
      directoryCounts,
      selectedPathAncestorCache,
    };
  }

  const selectedPathResolver = createSelectedPathAncestorResolver(selectedPathAncestorCache);
  const folderPrefix = `${folderId}|@|`;
  for (const selectionKey of selectedFilePaths) {
    if (!selectionKey.startsWith(folderPrefix)) {
      continue;
    }

    // Avoid decode/split work for keys outside this folder.
    const selectedPath = selectionKey.slice(folderPrefix.length);
    if (!selectedPath) {
      continue;
    }

    const ancestorPaths = selectedPathResolver.getAncestorPaths(selectedPath);
    for (const ancestorPath of ancestorPaths) {
      incrementDirectoryCount(directoryCounts, ancestorPath);
    }
  }

  return {
    directoryCounts,
    selectedPathAncestorCache: selectedPathResolver.getResolvedCache(),
  };
}

function applySelectionKeyDirectoryCountDelta(
  directoryCounts: Map<string, number>,
  selectionKey: string,
  folderPrefix: string,
  delta: 1 | -1,
  selectedPathResolver: SelectedPathAncestorResolver
): void {
  if (!selectionKey.startsWith(folderPrefix)) {
    return;
  }

  const selectedPath = selectionKey.slice(folderPrefix.length);
  if (!selectedPath) {
    return;
  }

  const ancestorPaths = selectedPathResolver.getAncestorPaths(selectedPath);
  for (const ancestorPath of ancestorPaths) {
    const nextCount = (directoryCounts.get(ancestorPath) ?? 0) + delta;
    if (nextCount <= 0) {
      directoryCounts.delete(ancestorPath);
      continue;
    }
    directoryCounts.set(ancestorPath, nextCount);
  }
}

function applySelectedDirectoryCountDiff(
  previousSelectedFilePaths: Set<string>,
  nextSelectedFilePaths: Set<string>,
  folderId: string,
  currentDirectoryCounts: Map<string, number>,
  selectedPathAncestorCache: Map<string, string[]>
): SelectedDirectoryCountBuildResult {
  const nextDirectoryCounts = new Map(currentDirectoryCounts);
  const selectedPathResolver = createSelectedPathAncestorResolver(selectedPathAncestorCache);
  const folderPrefix = `${folderId}|@|`;

  for (const selectionKey of previousSelectedFilePaths) {
    if (nextSelectedFilePaths.has(selectionKey)) {
      continue;
    }
    applySelectionKeyDirectoryCountDelta(
      nextDirectoryCounts,
      selectionKey,
      folderPrefix,
      -1,
      selectedPathResolver
    );
  }

  for (const selectionKey of nextSelectedFilePaths) {
    if (previousSelectedFilePaths.has(selectionKey)) {
      continue;
    }
    applySelectionKeyDirectoryCountDelta(
      nextDirectoryCounts,
      selectionKey,
      folderPrefix,
      1,
      selectedPathResolver
    );
  }

  return {
    directoryCounts: nextDirectoryCounts,
    selectedPathAncestorCache: selectedPathResolver.getResolvedCache(),
  };
}

function createSelectedDirectoryCountSnapshot(folderId: string): SelectedDirectoryCountSnapshot {
  return {
    folderId,
    selectedFilePaths: null,
    selectedDirectoryCounts: new Map(),
    selectedPathAncestorCache: new Map(),
  };
}

function computeSelectedDirectoryCountSnapshot(
  previousSnapshot: SelectedDirectoryCountSnapshot,
  selectedFilePaths: Set<string>,
  folderId: string
): SelectedDirectoryCountSnapshot {
  if (
    previousSnapshot.folderId === folderId &&
    previousSnapshot.selectedFilePaths === selectedFilePaths
  ) {
    return previousSnapshot;
  }

  const hasFolderChanged = previousSnapshot.folderId !== folderId;

  if (!(folderId && selectedFilePaths.size > 0)) {
    return {
      folderId,
      selectedFilePaths,
      selectedDirectoryCounts: new Map(),
      selectedPathAncestorCache: hasFolderChanged
        ? new Map()
        : previousSnapshot.selectedPathAncestorCache,
    };
  }

  if (hasFolderChanged || !previousSnapshot.selectedFilePaths) {
    const rebuiltCounts = buildSelectedDirectoryCounts(
      selectedFilePaths,
      folderId,
      hasFolderChanged ? new Map() : previousSnapshot.selectedPathAncestorCache
    );
    return {
      folderId,
      selectedFilePaths,
      selectedDirectoryCounts: rebuiltCounts.directoryCounts,
      selectedPathAncestorCache: rebuiltCounts.selectedPathAncestorCache,
    };
  }

  const updatedCounts = applySelectedDirectoryCountDiff(
    previousSnapshot.selectedFilePaths,
    selectedFilePaths,
    folderId,
    previousSnapshot.selectedDirectoryCounts,
    previousSnapshot.selectedPathAncestorCache
  );

  return {
    folderId,
    selectedFilePaths,
    selectedDirectoryCounts: updatedCounts.directoryCounts,
    selectedPathAncestorCache: updatedCounts.selectedPathAncestorCache,
  };
}

function useSelectedDirectoryCounts(
  selectedFilePaths: Set<string>,
  folderId: string
): Map<string, number> {
  const selectedDirectoryCountSnapshotRef = useRef<SelectedDirectoryCountSnapshot>(
    createSelectedDirectoryCountSnapshot(folderId)
  );

  const nextSnapshot = useMemo(
    () =>
      computeSelectedDirectoryCountSnapshot(
        selectedDirectoryCountSnapshotRef.current,
        selectedFilePaths,
        folderId
      ),
    [selectedFilePaths, folderId]
  );

  useEffect(() => {
    selectedDirectoryCountSnapshotRef.current = nextSnapshot;
  }, [nextSnapshot]);

  useEffect(() => {
    return () => {
      selectedDirectoryCountSnapshotRef.current = createSelectedDirectoryCountSnapshot(
        selectedDirectoryCountSnapshotRef.current.folderId
      );
    };
  }, []);

  return nextSnapshot.selectedDirectoryCounts;
}

function computeDirectoryCheckboxState(
  directoryPath: string,
  totalFiles: number,
  folderId: string,
  selectedDirectoryCounts: Map<string, number>
): { checkboxState: boolean | 'indeterminate'; selectedCount: number } {
  if (totalFiles === 0) {
    return {
      checkboxState: false,
      selectedCount: 0,
    };
  }

  const selectedCount = folderId ? (selectedDirectoryCounts.get(directoryPath) ?? 0) : 0;
  if (selectedCount === 0) {
    return {
      checkboxState: false,
      selectedCount,
    };
  }

  return {
    checkboxState: selectedCount === totalFiles ? true : 'indeterminate',
    selectedCount,
  };
}

function computeFileSelectionState(
  node: IFileNode,
  folderId: string,
  selectedFilePaths: Set<string>,
  maxSelectionCount: number
): NodeSelectionState {
  const isSelected = folderId
    ? isPathSelectedInFolder(selectedFilePaths, folderId, node.path)
    : false;
  return {
    checkboxState: isSelected,
    wouldExceedLimit: !isSelected && selectedFilePaths.size >= maxSelectionCount,
  };
}

function computeDirectorySelectionState(
  directoryPath: string,
  directoryTotalFiles: number,
  folderId: string,
  selectedFilePaths: Set<string>,
  selectedDirectoryCounts: Map<string, number>,
  maxSelectionCount: number
): NodeSelectionState {
  const directoryState = computeDirectoryCheckboxState(
    directoryPath,
    directoryTotalFiles,
    folderId,
    selectedDirectoryCounts
  );
  const unselectedCount = Math.max(0, directoryTotalFiles - directoryState.selectedCount);
  return {
    checkboxState: directoryState.checkboxState,
    wouldExceedLimit: selectedFilePaths.size + unselectedCount > maxSelectionCount,
  };
}

function computeNodeSelectionState(
  rowData: FileTreeRowData,
  folderId: string,
  selectedFilePaths: Set<string>,
  selectedDirectoryCounts: Map<string, number>,
  maxSelectionCount: number
): NodeSelectionState {
  const node = rowData.fileNode;
  if (node.type === 'file') {
    return computeFileSelectionState(node, folderId, selectedFilePaths, maxSelectionCount);
  }
  if (node.type === 'directory') {
    return computeDirectorySelectionState(
      node.path,
      rowData.directoryTotalFiles,
      folderId,
      selectedFilePaths,
      selectedDirectoryCounts,
      maxSelectionCount
    );
  }
  return {
    checkboxState: false,
    wouldExceedLimit: false,
  };
}

function isNodeChildrenLoading(node: IFileNode, loadingPaths?: Set<string>): boolean {
  return (loadingPaths?.has(node.path) ?? false) || node.loadState === 'loading';
}

function isNodeFileLoading(node: IFileNode, folderId: string, loadingFiles: Set<string>): boolean {
  if (!folderId) {
    return false;
  }
  return loadingFiles.has(encodeFileSelection(folderId, node.path));
}

function isNodeRuleSelected(
  node: IFileNode,
  selectionModel: FileExplorerState['selectionModel']
): boolean {
  return (
    node.type === 'file' &&
    selectionModel.mode === 'rules' &&
    (selectionModel.materializedPaths?.has(node.path) ?? false)
  );
}

function createTreeRowData(node: IFileNode, options: BuildFileTreeRowsOptions): FileTreeRowData {
  const {
    folderId,
    loadingFiles,
    loadingPaths,
    selectionModel,
    isLoadingForSelection,
    loadingPathForSelection,
  } = options;

  return {
    fileNode: node,
    directoryTotalFiles:
      node.type === 'directory' ? fileExplorer.getFolderFileCount(node).count : 0,
    isChildrenLoading: isNodeChildrenLoading(node, loadingPaths),
    isFileLoading: isNodeFileLoading(node, folderId, loadingFiles),
    isLoadingForSelection: Boolean(isLoadingForSelection && loadingPathForSelection === node.path),
    isRuleSelected: isNodeRuleSelected(node, selectionModel),
  };
}

function shouldLoadDirectoryRecursively(node: IFileNode): boolean {
  return (
    node.loadState !== 'loaded' ||
    (node.children?.some((child) => child.type === 'directory' && child.loadState !== 'loaded') ??
      false)
  );
}

function resolveDirectorySelectionMutation({
  allFilePaths,
  folderId,
  selectedFilePaths,
  selectedCount,
  directoryTotalFiles,
  maxSelectionCount,
}: DirectorySelectionMutationInput): DirectorySelectionMutation {
  if (allFilePaths.length === 0) {
    return {
      action: 'none',
      paths: EMPTY_SELECTION_PATHS,
    };
  }

  if (selectedCount === directoryTotalFiles) {
    return {
      action: 'remove',
      paths: allFilePaths,
    };
  }

  const availableSlots = Math.max(0, maxSelectionCount - selectedFilePaths.size);
  if (availableSlots === 0) {
    return {
      action: 'none',
      paths: EMPTY_SELECTION_PATHS,
    };
  }

  const pathsToSelect: string[] = [];
  for (const path of allFilePaths) {
    if (isPathSelectedInFolder(selectedFilePaths, folderId, path)) {
      continue;
    }
    pathsToSelect.push(path);
    if (pathsToSelect.length >= availableSlots) {
      break;
    }
  }

  if (pathsToSelect.length === 0) {
    return {
      action: 'none',
      paths: EMPTY_SELECTION_PATHS,
    };
  }

  return {
    action: 'add',
    paths: pathsToSelect,
  };
}

function addChildrenToStack(
  entry: StackEntry,
  stack: StackEntry[],
  expandedDirectoryPaths: Set<string>
): void {
  const { node, depth } = entry;
  // Only descend into expanded directories whose children are fully loaded.
  if (
    node.type !== 'directory' ||
    node.loadState !== 'loaded' ||
    !node.children ||
    node.children.length === 0
  ) {
    return;
  }
  if (!expandedDirectoryPaths.has(node.path)) {
    return;
  }

  for (let index = node.children.length - 1; index >= 0; index -= 1) {
    const child = node.children[index];
    if (!child) {
      continue;
    }
    stack.push({
      node: child,
      parentId: node.path,
      depth: depth + 1,
    });
  }
}

/**
 * Recursively index all IFileNode by path for O(1) lookup.
 * Used by the worker-flattened path to map WorkerFileNode paths back
 * to full IFileNode references.
 */
function indexFileNodesByPath(nodes: IFileNode[], out: Map<string, IFileNode>): void {
  for (const node of nodes) {
    out.set(node.path, node);
    if (node.children) {
      indexFileNodesByPath(node.children, out);
    }
  }
}

/**
 * Build tree rows from worker-flattened nodes.
 * Uses the pre-computed visible node list from the worker, avoiding
 * the main-thread DFS traversal.
 */
function buildRowsFromWorkerNodes(
  flattenedNodes: FlattenedNode[],
  nodeIndex: Map<string, IFileNode>,
  options: BuildFileTreeRowsOptions
): TreeNode<FileTreeRowData>[] {
  const rows: TreeNode<FileTreeRowData>[] = [];

  // Track parent path per depth level for parentId assignment.
  // INVARIANT: flattenedNodes must be in DFS pre-order so that a node at depth N
  // always has a preceding node at depth N-1 already recorded in parentStack.
  const parentStack: (string | null)[] = [null];

  for (const { node: workerNode, depth } of flattenedNodes) {
    const fileNode = nodeIndex.get(workerNode.path);
    if (!fileNode) {
      continue;
    }
    if (fileNode.isVisible === false) {
      continue;
    }

    // Resolve parentId from the depth stack
    const parentId = depth > 0 ? (parentStack[depth - 1] ?? null) : null;

    const rowData = createTreeRowData(fileNode, options);
    rows.push({
      id: fileNode.path,
      type: fileNode.type,
      depth,
      data: rowData,
      parentId,
      hasChildren: fileNode.type === 'directory',
      isLoading: rowData.isChildrenLoading,
    });

    // Update parent stack for children; truncate stale entries from deeper subtrees
    parentStack.length = depth + 1;
    parentStack[depth] = fileNode.path;
  }

  return rows;
}

function buildFileTreeRows(
  fileTree: IFileNode[],
  options: BuildFileTreeRowsOptions
): TreeNode<FileTreeRowData>[] {
  const rows: TreeNode<FileTreeRowData>[] = [];
  const { expandedDirectoryPaths } = options;
  const stack: StackEntry[] = [];
  for (let index = fileTree.length - 1; index >= 0; index -= 1) {
    const node = fileTree[index];
    if (!node) {
      continue;
    }
    stack.push({
      node,
      parentId: null,
      depth: 0,
    });
  }

  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry) {
      continue;
    }

    if (entry.node.isVisible === false) {
      continue;
    }

    const { node, parentId, depth } = entry;
    const rowData = createTreeRowData(node, options);

    rows.push({
      id: node.path,
      type: node.type,
      depth,
      data: rowData,
      parentId,
      // Keep directory rows expandable even when children are currently unloaded.
      hasChildren: node.type === 'directory',
      isLoading: rowData.isChildrenLoading,
    });

    // Only materialize expanded subtrees to avoid rematerializing collapsed descendants.
    addChildrenToStack(entry, stack, expandedDirectoryPaths);
  }

  return rows;
}

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
  folderId: string;
  maxSelectionCount: number;
  selectedDirectoryCounts: Map<string, number>;
  selectedFilePaths: Set<string>;
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
  const { folderId, maxSelectionCount, selectedDirectoryCounts, selectedFilePaths } =
    useFileTreeSelection();

  const selectionState = computeNodeSelectionState(
    rowData,
    folderId,
    selectedFilePaths,
    selectedDirectoryCounts,
    maxSelectionCount
  );

  return (
    <div className="flex min-w-0 flex-1 items-center">
      <div
        className="mr-2 flex w-4 items-center justify-center"
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
            disabled={selectionState.wouldExceedLimit}
            id={fileNode.path}
            onCheckedChange={() => onSelectionChange(rowData)}
          />
        )}
      </div>

      <div className="mr-2 flex w-4 items-center justify-center">
        <TreeNodeIcon
          isExpanded={isExpanded}
          isLoading={rowData.isFileLoading}
          nodeName={fileNode.name}
          nodeType={fileNode.type}
        />
      </div>

      <div className="flex min-w-0 flex-1 items-center">
        {fileNode.isSymbolicLink && (
          <Link2Icon className="mr-1.5 h-4 w-4 flex-shrink-0 text-blue-500" />
        )}
        <span className="truncate text-sm leading-4">{fileNode.name}</span>
        {rowData.isRuleSelected && (
          <Sparkles
            aria-label="Selected by rule"
            className="ml-1.5 h-3.5 w-3.5 flex-shrink-0 text-amber-500 dark:text-amber-400"
          />
        )}
        {fileNode.type === 'directory' && fileNode.isDepthTruncated && (
          <MoreHorizontalIcon className="ml-1.5 h-4 w-4 flex-shrink-0 text-gray-500" />
        )}
      </div>
    </div>
  );
}

/**
 * TreeTable adapter for file explorer left panel.
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
    const selectedFilePaths = useFileExplorerStoreSelector((s) => s.selectedFilePaths);
    const maxSelectionCount = useFileExplorerStoreSelector((s) => s.maxSelectionCount);
    const selectionModel = useFileExplorerStoreSelector((s) => s.selectionModel);
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

    const selectedDirectoryCounts = useSelectedDirectoryCounts(selectedFilePaths, folderId);

    // BST-375: Worker-based tree flattening for large trees.
    // Uses the worker to compute visible nodes off the main thread,
    // falling back to main-thread DFS for small trees.
    const treeContext = useOptionalFileTreeContext();
    const indexContext = useOptionalFileTreeIndexContext();
    const nullPortRef = useRef<null>(null);
    const workerPortRef = treeContext?.workerPortRef ?? nullPortRef;
    const approximateNodeCount = indexContext?.stats.totalNodes ?? 0;

    const { flattenedNodes, isWorkerEnabled } = useWorkerFlattenedTree({
      approximateNodeCount,
      expandedPaths: expandedDirectoryPaths,
      portRef: workerPortRef,
    });

    // Build a path-indexed map of all IFileNodes for worker result mapping.
    // Only computed when worker flattening is active to avoid overhead for small trees.
    // Note: depends on fileTree only (not flattenedNodes) to avoid reindexing on every
    // expand/collapse — the index maps paths to IFileNode refs which don't change.
    const fileNodeIndex = useMemo(() => {
      if (!isWorkerEnabled) {
        return null;
      }
      const index = new Map<string, IFileNode>();
      indexFileNodesByPath(fileTree, index);
      return index;
    }, [isWorkerEnabled, fileTree]);

    // Keep row structure independent from selectedFilePaths so checkbox toggles
    // do not trigger full tree row reconstruction for large trees.
    const treeRows = useMemo(() => {
      fileTreeTelemetry.treeRowsRebuildCount++;
      const options: BuildFileTreeRowsOptions = {
        expandedDirectoryPaths,
        folderId,
        loadingFiles,
        selectionModel,
        ...(loadingPaths ? { loadingPaths } : {}),
        ...(isLoadingForSelection !== undefined ? { isLoadingForSelection } : {}),
        ...(loadingPathForSelection !== undefined ? { loadingPathForSelection } : {}),
      };

      // When worker-flattened nodes are available, use them to avoid main-thread DFS
      if (flattenedNodes && fileNodeIndex) {
        return buildRowsFromWorkerNodes(flattenedNodes, fileNodeIndex, options);
      }

      return buildFileTreeRows(fileTree, options);
    }, [
      fileTree,
      expandedDirectoryPaths,
      folderId,
      loadingFiles,
      loadingPaths,
      selectionModel,
      isLoadingForSelection,
      loadingPathForSelection,
      flattenedNodes,
      fileNodeIndex,
    ]);

    const fileNodeByPath = useMemo(() => {
      const nodeMap = new Map<string, IFileNode>();
      for (const row of treeRows) {
        nodeMap.set(row.id, row.data.fileNode);
      }
      return nodeMap;
    }, [treeRows]);

    const getDirectoryToggleState = useCallback(
      (node: IFileNode): DirectoryToggleState => {
        const isChildrenLoadingFromStore = loadingPaths?.has(node.path) ?? false;
        return {
          // Read expansion state at invocation time to avoid stale closure snapshots
          // across rapid async expand/collapse interactions.
          isExpanded: store.getState().expandedDirectoryPaths.has(node.path),
          isChildrenLoading:
            isChildrenLoadingFromStore ||
            node.loadState === 'loading' ||
            pendingChildLoadPathsRef.current.has(node.path),
          isChildrenLoadingFromStore,
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
          path: node.path,
          error,
        });
        showToast({
          title: 'Failed to load folder',
          description: `Could not expand "${node.name}". Please try again.`,
          variant: 'destructive',
        });
      },
      [showToast]
    );

    const handleToggleExpand = useCallback(
      (nodeId: string) => {
        const node = fileNodeByPath.get(nodeId);
        if (!node || node.type !== 'directory') {
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

    const getNodeSelectionState = useCallback(
      (rowData: FileTreeRowData): NodeSelectionState =>
        computeNodeSelectionState(
          rowData,
          folderId,
          selectedFilePaths,
          selectedDirectoryCounts,
          maxSelectionCount
        ),
      [folderId, selectedFilePaths, selectedDirectoryCounts, maxSelectionCount]
    );

    const handleNodeSelection = useCallback(
      (rowData: FileTreeRowData) => {
        if (!folderId) {
          return;
        }

        const node = rowData.fileNode;
        const selectionState = getNodeSelectionState(rowData);
        if (selectionState.wouldExceedLimit) {
          return;
        }

        if (node.type !== 'directory') {
          toggleSelectedFile(folderId, node.path);
          return;
        }

        if (shouldLoadDirectoryRecursively(node) && onSelectFolderRecursively) {
          void onSelectFolderRecursively(node);
          return;
        }

        const directoryTotalFiles = rowData.directoryTotalFiles;
        if (directoryTotalFiles === 0) {
          return;
        }

        const selectedCount = selectedDirectoryCounts.get(node.path) ?? 0;
        const allFilePaths = fileExplorer.getAllFilePathsInDirectory(node);
        const selectionMutation = resolveDirectorySelectionMutation({
          allFilePaths,
          folderId,
          selectedFilePaths,
          selectedCount,
          directoryTotalFiles,
          maxSelectionCount,
        });

        if (selectionMutation.action === 'remove') {
          removeMultipleSelectedFiles(folderId, selectionMutation.paths);
          return;
        }

        if (selectionMutation.action === 'add') {
          addMultipleSelectedFiles(folderId, selectionMutation.paths);
        }
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
      ]
    );
    const handleNodeSelectionEvent = useEventCallback(handleNodeSelection);

    // Columns are now STABLE across selection changes. Selection state is handled
    // inside FileTreeCellContent via context, not via column cell closures.
    // This prevents all visible rows from re-rendering on every checkbox toggle.
    const columns = useMemo<TreeTableColumn<FileTreeRowData>[]>(() => {
      fileTreeTelemetry.columnsRebuildCount++;
      return [
        {
          id: 'name',
          className: '!p-0',
          cell: ({ node, isExpanded }) => (
            <FileTreeCellContent
              isExpanded={isExpanded}
              onSelectionChange={handleNodeSelectionEvent}
              rowData={node.data}
            />
          ),
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
        folderId: folderId ?? '',
        maxSelectionCount,
        selectedDirectoryCounts,
        selectedFilePaths,
      }),
      [folderId, maxSelectionCount, selectedDirectoryCounts, selectedFilePaths]
    );

    return (
      <FileTreeSelectionContext.Provider value={selectionContextValue}>
        <div
          className="relative h-full min-h-0 flex-1 overflow-y-auto"
          data-testid="file-tree-scroll-container"
        >
          <div className="relative h-full" data-testid="file-tree">
            <TreeTable
              ariaLabel="File tree"
              className="file-tree h-full min-h-0 flex-1"
              columns={columns}
              expandedIds={expandedDirectoryPaths}
              maxHeight="none"
              nodes={treeRows}
              onToggleExpand={handleToggleExpand}
              overscan={10}
              rowHeight={ROW_HEIGHT}
              selectionMode="none"
              showHeader={false}
              windowingStrategy="virtual"
            />
          </div>
        </div>
      </FileTreeSelectionContext.Provider>
    );
  }
);

OptimizedFileTree.displayName = 'OptimizedFileTree';

export default OptimizedFileTree;
