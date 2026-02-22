import type { FileExplorerState, IFileNode } from '@brainstrike/types';
import {
  LightweightCheckbox,
  type TreeNode,
  TreeTable,
  type TreeTableColumn,
} from '@brainstrike/ui';
import {
  countSelectedInDirectory,
  encodeFileSelection,
  memoizedFileExplorer as fileExplorer,
  isPathSelectedInFolder,
} from '@brainstrike/utils';
import {
  File as FileIcon,
  Folder,
  FolderOpen,
  Link2 as Link2Icon,
  Loader2,
  MoreHorizontal as MoreHorizontalIcon,
  Sparkles,
} from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { useFileExplorerStoreContext } from './file-explorer-provider';
import { ROW_HEIGHT } from './optimized-file-tree-row';

interface IOptimizedFileTreeProps {
  fileTree: IFileNode[];
  loadingFiles: Set<string>;
  onRender?: (() => void) | undefined;
  folderId: string;
  /** Set of directory paths currently loading their children (lazy loading) */
  loadingPaths?: Set<string> | undefined;
  /** Callback to load children of a directory on expand (lazy loading) */
  onLoadChildren?: ((path: string) => Promise<void>) | undefined;
  /** Cancel loading for a directory (called on collapse) */
  cancelChildLoading?: ((path: string) => void) | undefined;
  /** Select all files in a folder recursively, loading if needed */
  onSelectFolderRecursively?:
    | ((node: IFileNode) => Promise<{ success: boolean; filePaths: string[] }>)
    | undefined;
  /** Whether a folder is being loaded for selection */
  isLoadingForSelection?: boolean | undefined;
  /** Path of the folder being loaded for selection */
  loadingPathForSelection?: string | null | undefined;
}

interface FileTreeRowData {
  fileNode: IFileNode;
  isChildrenLoading: boolean;
  isFileLoading: boolean;
  isLoadingForSelection: boolean;
  isRuleSelected: boolean;
  checkboxState: boolean | 'indeterminate';
  wouldExceedLimit: boolean;
}

interface BuildFileTreeRowsOptions {
  folderId: string;
  loadingFiles: Set<string>;
  loadingPaths?: Set<string>;
  selectedFilePaths: Set<string>;
  maxSelectionCount: number;
  selectionModel: FileExplorerState['selectionModel'];
  isLoadingForSelection?: boolean;
  loadingPathForSelection?: string | null;
}

interface StackEntry {
  node: IFileNode;
  parentId: string | null;
  depth: number;
}

interface NodeSelectionState {
  checkboxState: boolean | 'indeterminate';
  wouldExceedLimit: boolean;
}

interface DirectoryToggleState {
  isExpanded: boolean;
  isChildrenLoading: boolean;
  isChildrenLoadingFromStore: boolean;
}

function computeDirectoryCheckboxState(
  node: IFileNode,
  folderId: string,
  selectedFilePaths: Set<string>
): { checkboxState: boolean | 'indeterminate'; selectedCount: number; totalFiles: number } {
  const totalFiles = fileExplorer.getFolderFileCount(node).count;
  if (totalFiles === 0) {
    return {
      checkboxState: false,
      selectedCount: 0,
      totalFiles,
    };
  }

  const selectedCount = folderId
    ? countSelectedInDirectory(selectedFilePaths, folderId, node.path)
    : 0;
  if (selectedCount === 0) {
    return {
      checkboxState: false,
      selectedCount,
      totalFiles,
    };
  }

  return {
    checkboxState: selectedCount === totalFiles ? true : 'indeterminate',
    selectedCount,
    totalFiles,
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
  node: IFileNode,
  folderId: string,
  selectedFilePaths: Set<string>,
  maxSelectionCount: number
): NodeSelectionState {
  const directoryState = computeDirectoryCheckboxState(node, folderId, selectedFilePaths);
  const unselectedCount = Math.max(0, directoryState.totalFiles - directoryState.selectedCount);
  return {
    checkboxState: directoryState.checkboxState,
    wouldExceedLimit: selectedFilePaths.size + unselectedCount > maxSelectionCount,
  };
}

function computeNodeSelectionState(
  node: IFileNode,
  folderId: string,
  selectedFilePaths: Set<string>,
  maxSelectionCount: number
): NodeSelectionState {
  if (node.type === 'file') {
    return computeFileSelectionState(node, folderId, selectedFilePaths, maxSelectionCount);
  }
  if (node.type === 'directory') {
    return computeDirectorySelectionState(node, folderId, selectedFilePaths, maxSelectionCount);
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
    selectedFilePaths,
    maxSelectionCount,
    selectionModel,
    isLoadingForSelection,
    loadingPathForSelection,
  } = options;
  const { checkboxState, wouldExceedLimit } = computeNodeSelectionState(
    node,
    folderId,
    selectedFilePaths,
    maxSelectionCount
  );

  return {
    fileNode: node,
    isChildrenLoading: isNodeChildrenLoading(node, loadingPaths),
    isFileLoading: isNodeFileLoading(node, folderId, loadingFiles),
    isLoadingForSelection: Boolean(isLoadingForSelection && loadingPathForSelection === node.path),
    isRuleSelected: isNodeRuleSelected(node, selectionModel),
    checkboxState,
    wouldExceedLimit,
  };
}

function addChildrenToStack(entry: StackEntry, stack: StackEntry[]): void {
  const { node, depth } = entry;
  if (node.type !== 'directory' || !node.children || node.children.length === 0) {
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

function buildFileTreeRows(
  fileTree: IFileNode[],
  options: BuildFileTreeRowsOptions
): TreeNode<FileTreeRowData>[] {
  const rows: TreeNode<FileTreeRowData>[] = [];
  const stack: StackEntry[] = fileTree
    .slice()
    .reverse()
    .map((node) => ({
      node,
      parentId: null,
      depth: 0,
    }));

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

    addChildrenToStack(entry, stack);
  }

  return rows;
}

interface TreeNodeIconProps {
  isLoading: boolean;
  nodeType: IFileNode['type'];
  nodeName: string;
  isExpanded: boolean;
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
    const expandedDirectoryPaths = store((s) => s.expandedDirectoryPaths);
    const toggleDirectoryExpansion = store((s) => s.toggleDirectoryExpansion);
    const toggleSelectedFile = store((s) => s.toggleSelectedFile);
    const addMultipleSelectedFiles = store((s) => s.addMultipleSelectedFiles);
    const removeMultipleSelectedFiles = store((s) => s.removeMultipleSelectedFiles);
    const selectedFilePaths = store((s) => s.selectedFilePaths);
    const maxSelectionCount = store((s) => s.maxSelectionCount);
    const selectionModel = store((s) => s.selectionModel);
    const pendingChildLoadPathsRef = useRef<Set<string>>(new Set());

    const treeRows = useMemo(() => {
      const options: BuildFileTreeRowsOptions = {
        folderId,
        loadingFiles,
        selectedFilePaths,
        maxSelectionCount,
        selectionModel,
        ...(loadingPaths ? { loadingPaths } : {}),
        ...(isLoadingForSelection !== undefined ? { isLoadingForSelection } : {}),
        ...(loadingPathForSelection !== undefined ? { loadingPathForSelection } : {}),
      };
      return buildFileTreeRows(fileTree, options);
    }, [
      fileTree,
      folderId,
      loadingFiles,
      loadingPaths,
      selectedFilePaths,
      maxSelectionCount,
      selectionModel,
      isLoadingForSelection,
      loadingPathForSelection,
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

    const shouldAbortCollapsedToggle = useCallback(
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

    const toggleDirectoryNode = useCallback(
      async (node: IFileNode, state: DirectoryToggleState): Promise<void> => {
        if (state.isExpanded) {
          if (state.isChildrenLoading && cancelChildLoading) {
            cancelChildLoading(node.path);
          }
          toggleDirectoryExpansion(node.path);
          return;
        }

        if (shouldAbortCollapsedToggle(node, state)) {
          return;
        }

        const needsLoad =
          (node.loadState === 'unloaded' || node.loadState === undefined) && onLoadChildren;
        if (needsLoad) {
          pendingChildLoadPathsRef.current.add(node.path);
          try {
            await onLoadChildren(node.path);
          } finally {
            pendingChildLoadPathsRef.current.delete(node.path);
          }
        }

        if (!store.getState().expandedDirectoryPaths.has(node.path)) {
          toggleDirectoryExpansion(node.path);
        }
      },
      [
        cancelChildLoading,
        onLoadChildren,
        shouldAbortCollapsedToggle,
        store,
        toggleDirectoryExpansion,
      ]
    );

    const handleToggleExpand = useCallback(
      (nodeId: string) => {
        const node = fileNodeByPath.get(nodeId);
        if (!node || node.type !== 'directory') {
          return;
        }
        const toggleState = getDirectoryToggleState(node);
        void toggleDirectoryNode(node, toggleState);
      },
      [fileNodeByPath, getDirectoryToggleState, toggleDirectoryNode]
    );

    const handleNodeSelection = useCallback(
      (rowData: FileTreeRowData) => {
        if (rowData.wouldExceedLimit || !folderId) {
          return;
        }

        const node = rowData.fileNode;
        if (node.type !== 'directory') {
          toggleSelectedFile(folderId, node.path);
          return;
        }

        const needsRecursiveLoad =
          node.loadState !== 'loaded' ||
          (node.children?.some(
            (child) => child.type === 'directory' && child.loadState !== 'loaded'
          ) ??
            false);

        if (needsRecursiveLoad && onSelectFolderRecursively) {
          void onSelectFolderRecursively(node);
          return;
        }

        const allFilePaths = fileExplorer.getAllFilePathsInDirectory(node);
        if (allFilePaths.length === 0) {
          return;
        }

        const selectedCount = countSelectedInDirectory(selectedFilePaths, folderId, node.path);
        const isFullySelected = selectedCount === allFilePaths.length;
        if (isFullySelected) {
          removeMultipleSelectedFiles(folderId, allFilePaths);
          return;
        }

        const unselectedPaths = allFilePaths.filter(
          (path) => !isPathSelectedInFolder(selectedFilePaths, folderId, path)
        );
        const availableSlots = Math.max(0, maxSelectionCount - selectedFilePaths.size);
        const pathsToSelect = unselectedPaths.slice(0, availableSlots);
        if (pathsToSelect.length > 0) {
          addMultipleSelectedFiles(folderId, pathsToSelect);
        }
      },
      [
        folderId,
        toggleSelectedFile,
        onSelectFolderRecursively,
        selectedFilePaths,
        removeMultipleSelectedFiles,
        maxSelectionCount,
        addMultipleSelectedFiles,
      ]
    );

    const columns = useMemo<TreeTableColumn<FileTreeRowData>[]>(
      () => [
        {
          id: 'name',
          header: <span className="sr-only">File Tree</span>,
          headerClassName: '!h-0 !border-0 !p-0 [&>div]:hidden',
          className: '!p-0',
          cell: ({ node, isExpanded }) => {
            const rowData = node.data;
            const fileNode = rowData.fileNode;

            return (
              <div className="flex min-w-0 flex-1 items-center">
                <div
                  className="mr-2 flex w-4 items-center justify-center"
                  title={
                    rowData.isLoadingForSelection
                      ? 'Loading folder contents...'
                      : rowData.wouldExceedLimit
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
                      checked={rowData.checkboxState}
                      className="h-4 w-4"
                      disabled={rowData.wouldExceedLimit}
                      id={fileNode.path}
                      onCheckedChange={() => handleNodeSelection(rowData)}
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
          },
        },
      ],
      [handleNodeSelection, maxSelectionCount]
    );

    useEffect(() => {
      onRender?.();
    }, [onRender]);

    return (
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
            windowingStrategy="virtual"
          />
        </div>
      </div>
    );
  }
);

OptimizedFileTree.displayName = 'OptimizedFileTree';

const OptimizedFileTreeMemoized = memo(OptimizedFileTree, (prevProps, nextProps) => {
  if (prevProps.folderId !== nextProps.folderId) {
    return false;
  }
  if (prevProps.onRender !== nextProps.onRender) {
    return false;
  }
  if (prevProps.fileTree !== nextProps.fileTree) {
    return false;
  }
  if (prevProps.loadingFiles !== nextProps.loadingFiles) {
    return false;
  }
  if (prevProps.loadingPaths !== nextProps.loadingPaths) {
    return false;
  }
  if (prevProps.onLoadChildren !== nextProps.onLoadChildren) {
    return false;
  }
  if (prevProps.cancelChildLoading !== nextProps.cancelChildLoading) {
    return false;
  }
  if (prevProps.onSelectFolderRecursively !== nextProps.onSelectFolderRecursively) {
    return false;
  }
  if (prevProps.isLoadingForSelection !== nextProps.isLoadingForSelection) {
    return false;
  }
  if (prevProps.loadingPathForSelection !== nextProps.loadingPathForSelection) {
    return false;
  }
  return true;
});

export default OptimizedFileTreeMemoized;
