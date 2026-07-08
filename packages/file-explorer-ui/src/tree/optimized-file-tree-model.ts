import { resolveQuerySelection } from '@brainstrike/file-explorer';
import type { FlattenedNode } from '@brainstrike/file-tree-worker';
import type { FileExplorerState, IFileNode } from '@brainstrike/types';
import type { TreeNode } from '@brainstrike/ui';
import { isDescendantPath } from '@brainstrike/utils';
import { memoizedFileExplorer as fileExplorer } from '@brainstrike/utils/file-explorer-utils';
import { encodeFileSelection, isPathSelectedInFolder } from '@brainstrike/utils/selection-utils';
import type { NormalizedFileTreeState } from '../utils/normalized-file-tree';
import {
  getQuerySelectionMatchingCount,
  isDirectoryCoveredByQuerySelection,
  isQuerySelectionPathSelected,
} from '../utils/selection-projection';
import {
  EMPTY_SELECTION_PATHS,
  getWorkspaceSelectionPathCandidates,
  isSameOrDescendantSelectionPath,
  isWorkspacePathSelected,
} from './optimized-file-tree-selection-counts';

export type FileTreeRowBuildSource = 'main-thread' | 'normalized' | 'worker';

export interface FileTreeRowsBuildResult {
  rows: TreeNode<FileTreeRowData>[];
  source: FileTreeRowBuildSource;
}

export interface FileTreeRowData {
  directoryTotalFiles: number;
  fileNode: IFileNode;
  hasUnloadedDirectoryChildren: boolean;
  immediateChildren: IFileNode[];
  isChildrenLoading: boolean;
  isFileLoading: boolean;
  isLoadingForSelection: boolean;
}

export interface BuildFileTreeRowsOptions {
  expandedDirectoryPaths: Set<string>;
  folderId: string;
  isLoadingForSelection?: boolean;
  loadingFiles: Set<string>;
  loadingPathForSelection?: string | null;
  loadingPaths?: Set<string>;
}

interface StackEntry {
  depth: number;
  node: IFileNode;
  parentId: string | null;
}

export interface NodeSelectionState {
  checkboxState: boolean | 'indeterminate';
  wouldExceedLimit: boolean;
}

type DirectorySelectionMutationAction = 'add' | 'remove' | 'none';

interface DirectorySelectionMutationInput {
  allFilePaths: string[];
  currentSelectionSize: number;
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

interface FileSelectionMutationInput {
  addMultipleSelectedFiles: (folderId: string, paths: string[]) => void;
  folderId: string;
  nodePath: string;
  removeMultipleSelectedFiles: (folderId: string, paths: string[]) => void;
  selectionMode: FileExplorerState['selectionModel']['mode'];
  selectionState: NodeSelectionState;
  toggleSelectedFile: (folderId: string, path: string) => void;
}

interface SelectedDirectoryPathsInput {
  directoryPath: string;
  folderId: string;
  querySelectionManifest: FileExplorerState['querySelectionManifest'];
  selectedFilePaths: Set<string>;
  selectionModel: FileExplorerState['selectionModel'];
}

export interface DirectoryToggleState {
  isChildrenLoading: boolean;
  isChildrenLoadingFromStore: boolean;
  isExpanded: boolean;
}

interface LoadedChildSelectionSummary {
  allSelected: boolean;
  anySelected: boolean;
}

export interface DirectorySelectionTraversalContext {
  getDirectoryMetadata: (node: IFileNode) => {
    directoryTotalFiles: number;
    hasUnloadedDirectoryChildren: boolean;
    immediateChildren: IFileNode[];
  };
}

function computeDirectoryCheckboxState(
  directoryPath: string,
  totalFiles: number,
  folderId: string,
  selectedDirectoryCounts: Map<string, number>
): { checkboxState: boolean | 'indeterminate'; selectedCount: number } {
  const selectedCount = folderId ? (selectedDirectoryCounts.get(directoryPath) ?? 0) : 0;
  if (totalFiles === 0) {
    return {
      checkboxState: selectedCount > 0 ? 'indeterminate' : false,
      selectedCount,
    };
  }

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
  querySelectionManifest: FileExplorerState['querySelectionManifest'],
  selectionModel: FileExplorerState['selectionModel'],
  selectedFilePaths: Set<string>,
  selectedCount: number,
  maxSelectionCount: number
): NodeSelectionState {
  const isSelected =
    selectionModel.mode === 'query'
      ? isQuerySelectionPathSelected(
          selectionModel.queryDescriptor,
          querySelectionManifest,
          folderId,
          node.path,
          selectionModel.materializedPaths
        )
      : folderId
        ? isWorkspacePathSelected(selectedFilePaths, folderId, node.path)
        : false;
  return {
    checkboxState: isSelected,
    wouldExceedLimit: !isSelected && selectedCount >= maxSelectionCount,
  };
}

function isReadyQuerySelection(
  selectionModel: FileExplorerState['selectionModel'],
  querySelectionManifest: FileExplorerState['querySelectionManifest'],
  folderId: string
): boolean {
  return Boolean(
    selectionModel.mode === 'query' &&
      selectionModel.queryDescriptor &&
      folderId === selectionModel.queryDescriptor.folderId &&
      querySelectionManifest?.status === 'ready' &&
      querySelectionManifest.fingerprint === selectionModel.queryDescriptor.manifestFingerprint &&
      querySelectionManifest.snapshotId === selectionModel.queryDescriptor.manifestSnapshotId
  );
}

function getQueryDirectorySelectionState(args: {
  directoryPath: string;
  folderId: string;
  querySelectionManifest: FileExplorerState['querySelectionManifest'];
  selectedDirectoryCounts: Map<string, number>;
  selectionModel: FileExplorerState['selectionModel'];
}): boolean | 'indeterminate' {
  const {
    directoryPath,
    folderId,
    querySelectionManifest,
    selectedDirectoryCounts,
    selectionModel,
  } = args;
  const queryRootPath = selectionModel.queryDescriptor?.rootPath ?? null;
  const isAncestorOfQueryRoot = Boolean(
    queryRootPath &&
      directoryPath !== queryRootPath &&
      isDescendantPath(queryRootPath, directoryPath)
  );
  const totalMatchingCount = getQuerySelectionMatchingCount(
    selectionModel.queryDescriptor,
    querySelectionManifest,
    folderId,
    directoryPath,
    selectionModel.materializedPaths
  );
  const selectedMatchingCount = selectedDirectoryCounts.get(directoryPath) ?? 0;
  if (totalMatchingCount === 0 || selectedMatchingCount === 0) {
    return false;
  }
  if (isAncestorOfQueryRoot) {
    return 'indeterminate';
  }
  return selectedMatchingCount === totalMatchingCount ? true : 'indeterminate';
}

function getCoveredQueryDirectorySelectionState(args: {
  directoryState: { checkboxState: boolean | 'indeterminate'; selectedCount: number };
  folderId: string;
  isKnownEmptyDirectory: boolean;
  nodePath: string;
  querySelectionManifest: FileExplorerState['querySelectionManifest'];
  selectionModel: FileExplorerState['selectionModel'];
}): boolean | 'indeterminate' | null {
  const {
    directoryState,
    folderId,
    isKnownEmptyDirectory,
    nodePath,
    querySelectionManifest,
    selectionModel,
  } = args;
  if (
    !(
      selectionModel.mode === 'query' &&
      isDirectoryCoveredByQuerySelection(
        selectionModel.queryDescriptor,
        querySelectionManifest,
        folderId,
        nodePath,
        selectionModel.materializedPaths
      )
    )
  ) {
    return null;
  }

  const hasQueryOverrides = Boolean(
    selectionModel.queryDescriptor &&
      (selectionModel.queryDescriptor.includedPaths.length > 0 ||
        selectionModel.queryDescriptor.excludedPaths.length > 0)
  );
  const queryRootPath = selectionModel.queryDescriptor?.rootPath ?? null;
  const isAncestorOfQueryRoot = Boolean(
    queryRootPath && nodePath !== queryRootPath && isDescendantPath(queryRootPath, nodePath)
  );

  if (isKnownEmptyDirectory) {
    return false;
  }
  if (isAncestorOfQueryRoot) {
    return directoryState.checkboxState === false ? 'indeterminate' : directoryState.checkboxState;
  }
  if (hasQueryOverrides) {
    return directoryState.checkboxState === false ? 'indeterminate' : directoryState.checkboxState;
  }
  return true;
}

function computeLoadedFileCheckboxState(
  node: IFileNode,
  folderId: string,
  querySelectionManifest: FileExplorerState['querySelectionManifest'],
  selectedFilePaths: Set<string>,
  selectionModel: FileExplorerState['selectionModel']
): boolean {
  return selectionModel.mode === 'query'
    ? isQuerySelectionPathSelected(
        selectionModel.queryDescriptor,
        querySelectionManifest,
        folderId,
        node.path,
        selectionModel.materializedPaths
      )
    : isWorkspacePathSelected(selectedFilePaths, folderId, node.path);
}

function computeLoadedDirectoryCheckboxState(
  folderId: string,
  node: IFileNode,
  querySelectionManifest: FileExplorerState['querySelectionManifest'],
  selectionModel: FileExplorerState['selectionModel'],
  selectedDirectoryCounts: Map<string, number>,
  selectedFilePaths: Set<string>,
  directoryTraversalContext: DirectorySelectionTraversalContext
): boolean | 'indeterminate' {
  const isQueryDirectorySelection = selectionModel.mode === 'query';

  const totalFiles = fileExplorer.getFolderFileCount(node).count;
  const selectedCount = selectedDirectoryCounts.get(node.path) ?? 0;
  if (selectionModel.mode !== 'query' && totalFiles > 0 && selectedCount === totalFiles) {
    return true;
  }

  const loadedChildSelectionSummary = summarizeLoadedChildSelection({
    children: directoryTraversalContext.getDirectoryMetadata(node).immediateChildren,
    directoryTraversalContext,
    folderId,
    parentDirectoryPath: node.path,
    querySelectionManifest,
    selectedDirectoryCounts,
    selectedFilePaths,
    selectionModel,
  });

  if (loadedChildSelectionSummary?.allSelected) {
    return true;
  }
  if (loadedChildSelectionSummary?.anySelected) {
    return 'indeterminate';
  }

  if (isQueryDirectorySelection) {
    if (isReadyQuerySelection(selectionModel, querySelectionManifest, folderId)) {
      return getQueryDirectorySelectionState({
        directoryPath: node.path,
        folderId,
        querySelectionManifest,
        selectedDirectoryCounts,
        selectionModel,
      });
    }

    const coveredState = getCoveredQueryDirectorySelectionState({
      directoryState: {
        checkboxState: false,
        selectedCount: selectedDirectoryCounts.get(node.path) ?? 0,
      },
      folderId,
      isKnownEmptyDirectory: false,
      nodePath: node.path,
      querySelectionManifest,
      selectionModel,
    });
    if (coveredState !== null) {
      return coveredState;
    }
  }

  if (totalFiles === 0) {
    return selectedCount > 0 ? 'indeterminate' : false;
  }
  if (selectedCount === 0) {
    return false;
  }
  return selectedCount === totalFiles ? true : 'indeterminate';
}

function computeLoadedChildCheckboxState(
  node: IFileNode,
  folderId: string,
  querySelectionManifest: FileExplorerState['querySelectionManifest'],
  selectionModel: FileExplorerState['selectionModel'],
  selectedDirectoryCounts: Map<string, number>,
  selectedFilePaths: Set<string>,
  directoryTraversalContext: DirectorySelectionTraversalContext
): boolean | 'indeterminate' {
  if (node.type === 'file') {
    return computeLoadedFileCheckboxState(
      node,
      folderId,
      querySelectionManifest,
      selectedFilePaths,
      selectionModel
    );
  }
  return computeLoadedDirectoryCheckboxState(
    folderId,
    node,
    querySelectionManifest,
    selectionModel,
    selectedDirectoryCounts,
    selectedFilePaths,
    directoryTraversalContext
  );
}

function shouldIgnoreLoadedQueryChildDirectory(args: {
  child: IFileNode;
  folderId: string;
  parentDirectoryPath: string;
  querySelectionManifest: FileExplorerState['querySelectionManifest'];
  selectionModel: FileExplorerState['selectionModel'];
}): boolean {
  const { child, folderId, parentDirectoryPath, querySelectionManifest, selectionModel } = args;
  const queryRootPath = selectionModel.queryDescriptor?.rootPath;

  if (
    !(
      queryRootPath &&
      (parentDirectoryPath === queryRootPath ||
        isDescendantPath(parentDirectoryPath, queryRootPath))
    )
  ) {
    return false;
  }

  return !isDirectoryCoveredByQuerySelection(
    selectionModel.queryDescriptor,
    querySelectionManifest,
    folderId,
    child.path,
    selectionModel.materializedPaths
  );
}

function summarizeLoadedChildSelection(args: {
  children: IFileNode[];
  directoryTraversalContext: DirectorySelectionTraversalContext;
  folderId: string;
  parentDirectoryPath: string;
  querySelectionManifest: FileExplorerState['querySelectionManifest'];
  selectedDirectoryCounts: Map<string, number>;
  selectedFilePaths: Set<string>;
  selectionModel: FileExplorerState['selectionModel'];
}): LoadedChildSelectionSummary | null {
  const {
    children,
    directoryTraversalContext,
    folderId,
    parentDirectoryPath,
    querySelectionManifest,
    selectionModel,
    selectedDirectoryCounts,
    selectedFilePaths,
  } = args;

  if (children.length === 0) {
    return null;
  }

  let anySelected = false;
  let allSelected = true;
  let consideredChildren = 0;

  for (const child of children) {
    if (
      selectionModel.mode === 'query' &&
      child.type === 'directory' &&
      shouldIgnoreLoadedQueryChildDirectory({
        child,
        folderId,
        parentDirectoryPath,
        querySelectionManifest,
        selectionModel,
      })
    ) {
      continue;
    }

    consideredChildren += 1;
    const childState = computeLoadedChildCheckboxState(
      child,
      folderId,
      querySelectionManifest,
      selectionModel,
      selectedDirectoryCounts,
      selectedFilePaths,
      directoryTraversalContext
    );
    if (childState !== false) {
      anySelected = true;
    }
    if (childState !== true) {
      allSelected = false;
    }
    if (anySelected && !allSelected) {
      break;
    }
  }

  if (consideredChildren === 0) {
    return null;
  }

  return { allSelected, anySelected };
}

function createQueryDirectoryNodeSelectionState(
  checkboxState: boolean | 'indeterminate'
): NodeSelectionState {
  return {
    checkboxState,
    wouldExceedLimit: false,
  };
}

function computeDirectorySelectionState(
  node: IFileNode,
  directoryTotalFiles: number,
  hasUnloadedDirectoryChildren: boolean,
  immediateChildren: IFileNode[],
  directoryTraversalContext: DirectorySelectionTraversalContext,
  folderId: string,
  querySelectionManifest: FileExplorerState['querySelectionManifest'],
  selectionModel: FileExplorerState['selectionModel'],
  selectedFilePaths: Set<string>,
  selectedDirectoryCounts: Map<string, number>,
  selectedCount: number,
  maxSelectionCount: number
): NodeSelectionState {
  const isKnownEmptyDirectory =
    node.loadState === 'loaded' && directoryTotalFiles === 0 && !hasUnloadedDirectoryChildren;

  const isReadyQueryDirectorySelection = isReadyQuerySelection(
    selectionModel,
    querySelectionManifest,
    folderId
  );

  const directoryState = computeDirectoryCheckboxState(
    node.path,
    directoryTotalFiles,
    folderId,
    selectedDirectoryCounts
  );
  if (
    selectionModel.mode !== 'query' &&
    folderId &&
    isWorkspacePathSelected(selectedFilePaths, folderId, node.path)
  ) {
    return createQueryDirectoryNodeSelectionState(true);
  }
  if (
    selectionModel.mode !== 'query' &&
    directoryTotalFiles > 0 &&
    directoryState.selectedCount === directoryTotalFiles
  ) {
    return createQueryDirectoryNodeSelectionState(true);
  }

  const loadedChildSelectionSummary = summarizeLoadedChildSelection({
    children: immediateChildren,
    directoryTraversalContext,
    folderId,
    parentDirectoryPath: node.path,
    querySelectionManifest,
    selectedDirectoryCounts,
    selectedFilePaths,
    selectionModel,
  });

  if (loadedChildSelectionSummary?.allSelected) {
    return createQueryDirectoryNodeSelectionState(true);
  }
  if (loadedChildSelectionSummary?.anySelected) {
    return createQueryDirectoryNodeSelectionState('indeterminate');
  }

  if (selectionModel.mode === 'query') {
    if (isReadyQueryDirectorySelection) {
      return createQueryDirectoryNodeSelectionState(
        getQueryDirectorySelectionState({
          directoryPath: node.path,
          folderId,
          querySelectionManifest,
          selectedDirectoryCounts,
          selectionModel,
        })
      );
    }

    const coveredState = getCoveredQueryDirectorySelectionState({
      directoryState,
      folderId,
      isKnownEmptyDirectory,
      nodePath: node.path,
      querySelectionManifest,
      selectionModel,
    });
    if (coveredState !== null) {
      return createQueryDirectoryNodeSelectionState(coveredState);
    }
  }

  const unselectedCount = Math.max(0, directoryTotalFiles - directoryState.selectedCount);
  return {
    checkboxState: directoryState.checkboxState,
    wouldExceedLimit: selectedCount + unselectedCount > maxSelectionCount,
  };
}

export function computeNodeSelectionState(
  rowData: FileTreeRowData,
  directoryTraversalContext: DirectorySelectionTraversalContext,
  folderId: string,
  querySelectionManifest: FileExplorerState['querySelectionManifest'],
  selectionModel: FileExplorerState['selectionModel'],
  selectedFilePaths: Set<string>,
  selectedDirectoryCounts: Map<string, number>,
  selectedCount: number,
  maxSelectionCount: number
): NodeSelectionState {
  const node = rowData.fileNode;
  if (node.type === 'file') {
    return computeFileSelectionState(
      node,
      folderId,
      querySelectionManifest,
      selectionModel,
      selectedFilePaths,
      selectedCount,
      maxSelectionCount
    );
  }
  if (node.type === 'directory') {
    return computeDirectorySelectionState(
      node,
      rowData.directoryTotalFiles,
      rowData.hasUnloadedDirectoryChildren,
      rowData.immediateChildren,
      directoryTraversalContext,
      folderId,
      querySelectionManifest,
      selectionModel,
      selectedFilePaths,
      selectedDirectoryCounts,
      selectedCount,
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

export function hasUnloadedDirectoryChildren(node: IFileNode): boolean {
  return (
    node.children?.some((child) => child.type === 'directory' && child.loadState !== 'loaded') ??
    false
  );
}

function isNodeFileLoading(node: IFileNode, folderId: string, loadingFiles: Set<string>): boolean {
  if (!folderId) {
    return false;
  }
  return loadingFiles.has(encodeFileSelection(folderId, node.path));
}

function createTreeRowData(node: IFileNode, options: BuildFileTreeRowsOptions): FileTreeRowData {
  const { folderId, loadingFiles, loadingPaths, isLoadingForSelection, loadingPathForSelection } =
    options;

  return {
    directoryTotalFiles:
      node.type === 'directory' ? fileExplorer.getFolderFileCount(node).count : 0,
    fileNode: node,
    hasUnloadedDirectoryChildren:
      node.type === 'directory' ? hasUnloadedDirectoryChildren(node) : false,
    immediateChildren: node.type === 'directory' ? (node.children ?? []) : [],
    isChildrenLoading: isNodeChildrenLoading(node, loadingPaths),
    isFileLoading: isNodeFileLoading(node, folderId, loadingFiles),
    isLoadingForSelection: Boolean(isLoadingForSelection && loadingPathForSelection === node.path),
  };
}

function createTreeRowDataWithDirectoryTotalFiles(
  node: IFileNode,
  options: BuildFileTreeRowsOptions,
  directoryTotalFiles: number,
  hasUnloadedChildrenOverride?: boolean,
  immediateChildrenOverride?: IFileNode[]
): FileTreeRowData {
  const rowData = createTreeRowData(node, options);
  return {
    ...rowData,
    directoryTotalFiles,
    hasUnloadedDirectoryChildren:
      hasUnloadedChildrenOverride ?? rowData.hasUnloadedDirectoryChildren,
    immediateChildren: immediateChildrenOverride ?? rowData.immediateChildren,
  };
}

export function shouldLoadDirectoryRecursively(node: IFileNode): boolean {
  return (
    node.loadState !== 'loaded' ||
    (node.children?.some((child) => child.type === 'directory' && child.loadState !== 'loaded') ??
      false)
  );
}

export function resolveDirectorySelectionMutation({
  allFilePaths,
  currentSelectionSize,
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

  const availableSlots = Math.max(0, maxSelectionCount - currentSelectionSize);
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

export function applyDirectorySelectionMutation(params: {
  addMultipleSelectedFiles: (folderId: string, paths: string[]) => void;
  folderId: string;
  mutation: DirectorySelectionMutation;
  removeMultipleSelectedFiles: (folderId: string, paths: string[]) => void;
}): void {
  const { addMultipleSelectedFiles, folderId, mutation, removeMultipleSelectedFiles } = params;
  if (mutation.action === 'remove') {
    removeMultipleSelectedFiles(folderId, mutation.paths);
    return;
  }

  if (mutation.action === 'add') {
    addMultipleSelectedFiles(folderId, mutation.paths);
  }
}

export function applyFileSelectionMutation({
  addMultipleSelectedFiles,
  folderId,
  nodePath,
  removeMultipleSelectedFiles,
  selectionMode,
  selectionState,
  toggleSelectedFile,
}: FileSelectionMutationInput): void {
  if (selectionMode === 'query') {
    toggleSelectedFile(folderId, nodePath);
    return;
  }

  const pathCandidates = getWorkspaceSelectionPathCandidates(folderId, nodePath);
  if (selectionState.checkboxState !== false) {
    removeMultipleSelectedFiles(folderId, pathCandidates);
    return;
  }

  addMultipleSelectedFiles(folderId, [nodePath]);
}

export function getSelectedDescendantPathsForDirectory({
  directoryPath,
  folderId,
  querySelectionManifest,
  selectedFilePaths,
  selectionModel,
}: SelectedDirectoryPathsInput): string[] {
  const directoryPrefix = `${directoryPath}/`;

  if (selectionModel.mode === 'query' && selectionModel.queryDescriptor) {
    const relativePaths =
      querySelectionManifest?.status === 'ready'
        ? resolveQuerySelection(selectionModel.queryDescriptor, querySelectionManifest).filePaths
        : Array.from(selectionModel.materializedPaths ?? []);

    return relativePaths.filter(
      (path) => path === directoryPath || path.startsWith(directoryPrefix)
    );
  }

  const folderPrefix = `${folderId}|@|`;
  const directoryPathCandidates = getWorkspaceSelectionPathCandidates(folderId, directoryPath);
  const selectedPaths: string[] = [];
  for (const compositeKey of selectedFilePaths) {
    if (!compositeKey.startsWith(folderPrefix)) {
      continue;
    }
    const path = compositeKey.slice(folderPrefix.length);
    if (
      path === directoryPath ||
      path.startsWith(directoryPrefix) ||
      directoryPathCandidates.some((candidatePath) =>
        isSameOrDescendantSelectionPath(path, candidatePath)
      )
    ) {
      selectedPaths.push(path);
    }
  }
  return selectedPaths;
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
      depth: depth + 1,
      node: child,
      parentId: node.path,
    });
  }
}

/**
 * Recursively index all IFileNode by path for O(1) lookup.
 * Used by the worker-flattened path to map WorkerFileNode paths back
 * to full IFileNode references.
 */
export function indexFileNodesByPath(nodes: IFileNode[], out: Map<string, IFileNode>): void {
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
export function buildRowsFromWorkerNodes(
  flattenedNodes: FlattenedNode[],
  nodeLookup: (path: string) => IFileNode | undefined,
  options: BuildFileTreeRowsOptions,
  getDirectoryTotalFiles?: (path: string) => number
): TreeNode<FileTreeRowData>[] {
  const rows: TreeNode<FileTreeRowData>[] = [];

  // Track parent path per depth level for parentId assignment.
  // INVARIANT: flattenedNodes must be in DFS pre-order so that a node at depth N
  // always has a preceding node at depth N-1 already recorded in parentStack.
  const parentStack: (string | null)[] = [null];

  for (const { node: workerNode, depth } of flattenedNodes) {
    const fileNode = nodeLookup(workerNode.path);
    if (!fileNode) {
      continue;
    }
    if (fileNode.isVisible === false) {
      continue;
    }

    // Resolve parentId from the depth stack
    const parentId = depth > 0 ? (parentStack[depth - 1] ?? null) : null;

    const rowData = createTreeRowDataWithDirectoryTotalFiles(
      fileNode,
      options,
      fileNode.type === 'directory'
        ? (getDirectoryTotalFiles?.(fileNode.path) ??
            fileExplorer.getFolderFileCount(fileNode).count)
        : 0
    );
    rows.push({
      data: rowData,
      depth,
      hasChildren: fileNode.type === 'directory',
      id: fileNode.path,
      isLoading: rowData.isChildrenLoading,
      parentId,
      type: fileNode.type,
    });

    // Update parent stack for children; truncate stale entries from deeper subtrees
    parentStack.length = depth + 1;
    parentStack[depth] = fileNode.path;
  }

  return rows;
}

function shouldIncludeNormalizedChildren(
  node: IFileNode,
  expandedDirectoryPaths: Set<string>
): boolean {
  return (
    node.type === 'directory' &&
    node.loadState === 'loaded' &&
    expandedDirectoryPaths.has(node.path)
  );
}

function pushNormalizedChildrenOntoStack(
  stack: StackEntry[],
  normalizedTree: NormalizedFileTreeState,
  parentNode: IFileNode,
  depth: number,
  allowedPaths: Set<string> | null
): void {
  const childPaths = normalizedTree.childPathsByPath.get(parentNode.path) ?? [];
  for (let index = childPaths.length - 1; index >= 0; index -= 1) {
    const childPath = childPaths[index];
    if (allowedPaths && childPath && !allowedPaths.has(childPath)) {
      continue;
    }
    const childNode = childPath ? normalizedTree.nodeByPath.get(childPath) : undefined;
    if (!childNode) {
      continue;
    }
    stack.push({
      depth: depth + 1,
      node: { ...childNode },
      parentId: parentNode.path,
    });
  }
}

export function getNormalizedImmediateChildren(
  normalizedTree: NormalizedFileTreeState,
  directoryPath: string,
  allowedPaths: Set<string> | null
): IFileNode[] {
  const children: IFileNode[] = [];
  const childPaths = normalizedTree.childPathsByPath.get(directoryPath) ?? [];
  for (const childPath of childPaths) {
    if (allowedPaths && !allowedPaths.has(childPath)) {
      continue;
    }
    const childNode = normalizedTree.nodeByPath.get(childPath);
    if (!childNode) {
      continue;
    }
    children.push({ ...childNode });
  }
  return children;
}

export function hasNormalizedUnloadedDirectoryChildren(
  normalizedTree: NormalizedFileTreeState,
  directoryPath: string,
  allowedPaths: Set<string> | null
): boolean {
  const childPaths = normalizedTree.childPathsByPath.get(directoryPath) ?? [];
  for (const childPath of childPaths) {
    if (allowedPaths && !allowedPaths.has(childPath)) {
      continue;
    }
    const childNode = normalizedTree.nodeByPath.get(childPath);
    if (childNode?.type === 'directory' && childNode.loadState !== 'loaded') {
      return true;
    }
  }
  return false;
}

export function buildRowsFromNormalizedTree(
  normalizedTree: NormalizedFileTreeState,
  options: BuildFileTreeRowsOptions,
  getDirectoryTotalFiles: (path: string) => number,
  allowedPaths: Set<string> | null
): TreeNode<FileTreeRowData>[] {
  const rows: TreeNode<FileTreeRowData>[] = [];
  const stack: StackEntry[] = [];

  for (let index = normalizedTree.rootPaths.length - 1; index >= 0; index -= 1) {
    const rootPath = normalizedTree.rootPaths[index];
    if (allowedPaths && rootPath && !allowedPaths.has(rootPath)) {
      continue;
    }
    const rootNode = rootPath ? normalizedTree.nodeByPath.get(rootPath) : undefined;
    if (!rootNode) {
      continue;
    }
    stack.push({
      depth: 0,
      node: { ...rootNode },
      parentId: null,
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

    const rowData = createNormalizedRowData(
      entry,
      normalizedTree,
      options,
      getDirectoryTotalFiles,
      allowedPaths
    );
    rows.push({
      data: rowData,
      depth: entry.depth,
      hasChildren: entry.node.type === 'directory',
      id: entry.node.path,
      isLoading: rowData.isChildrenLoading,
      parentId: entry.parentId,
      type: entry.node.type,
    });

    if (!shouldIncludeNormalizedChildren(entry.node, options.expandedDirectoryPaths)) {
      continue;
    }

    pushNormalizedChildrenOntoStack(stack, normalizedTree, entry.node, entry.depth, allowedPaths);
  }

  return rows;
}

function createNormalizedRowData(
  entry: StackEntry,
  normalizedTree: NormalizedFileTreeState,
  options: BuildFileTreeRowsOptions,
  getDirectoryTotalFiles: (path: string) => number,
  allowedPaths: Set<string> | null
): FileTreeRowData {
  const hasUnloadedChildren =
    entry.node.type === 'directory'
      ? hasNormalizedUnloadedDirectoryChildren(normalizedTree, entry.node.path, allowedPaths)
      : false;
  const immediateChildren =
    entry.node.type === 'directory'
      ? getNormalizedImmediateChildren(normalizedTree, entry.node.path, allowedPaths)
      : [];

  return createTreeRowDataWithDirectoryTotalFiles(
    entry.node,
    options,
    entry.node.type === 'directory' ? getDirectoryTotalFiles(entry.node.path) : 0,
    hasUnloadedChildren,
    immediateChildren
  );
}

export function buildFileTreeRows(
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
      depth: 0,
      node,
      parentId: null,
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
      data: rowData,
      depth,
      // Keep directory rows expandable even when children are currently unloaded.
      hasChildren: node.type === 'directory',
      id: node.path,
      isLoading: rowData.isChildrenLoading,
      parentId,
      type: node.type,
    });

    // Only materialize expanded subtrees to avoid rematerializing collapsed descendants.
    addChildrenToStack(entry, stack, expandedDirectoryPaths);
  }

  return rows;
}
