import { resolveQuerySelection } from '@brainstrike/file-explorer';
import { useToastManager } from '@brainstrike/file-explorer-hooks';
import type { FlattenedNode } from '@brainstrike/file-tree-worker';
import { useEventCallback } from '@brainstrike/hooks';
import type { FileExplorerState, IFileNode } from '@brainstrike/types';
import {
  LightweightCheckbox,
  type TreeNode,
  TreeTable,
  type TreeTableColumn,
  useIdeFileEditor,
} from '@brainstrike/ui';
import { isDescendantPath } from '@brainstrike/utils';
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
import {
  useFileExplorerStoreContext,
  useFileExplorerStoreSelector,
} from './file-explorer-provider';
import {
  useOptionalFileTreeContext,
  useOptionalFileTreeIndexContext,
  useOptionalFileTreeNormalizedContext,
} from './file-tree-provider';
import { useWorkerFlattenedTree } from './hooks/use-worker-flattened-tree';
import {
  getQuerySelectionMatchingCount,
  getSelectionCount,
  isDirectoryCoveredByQuerySelection,
  isQuerySelectionPathSelected,
} from './utils/selection-projection';

/** Pixel height of one virtualized tree row. */
const ROW_HEIGHT = 32;

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
  hasUnloadedDirectoryChildren: boolean;
  immediateChildren: IFileNode[];
  isChildrenLoading: boolean;
  isFileLoading: boolean;
  isLoadingForSelection: boolean;
}

interface BuildFileTreeRowsOptions {
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

interface NodeSelectionState {
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

interface DirectoryToggleState {
  isChildrenLoading: boolean;
  isChildrenLoadingFromStore: boolean;
  isExpanded: boolean;
}

interface LoadedChildSelectionSummary {
  allSelected: boolean;
  anySelected: boolean;
}

interface DirectorySelectionTraversalContext {
  getDirectoryMetadata: (node: IFileNode) => {
    directoryTotalFiles: number;
    hasUnloadedDirectoryChildren: boolean;
    immediateChildren: IFileNode[];
  };
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

const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_DRIVE_ROOT_LENGTH = 3;

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

function isWindowsDriveRootPath(filePath: string): boolean {
  return filePath.length === WINDOWS_DRIVE_ROOT_LENGTH && hasWindowsDriveRootPrefix(filePath);
}

function hasWindowsDriveRootPrefix(filePath: string): boolean {
  return (
    filePath.length >= WINDOWS_DRIVE_ROOT_LENGTH &&
    filePath.charCodeAt(1) === 58 &&
    filePath[2] === '/' &&
    ((filePath.charCodeAt(0) >= 65 && filePath.charCodeAt(0) <= 90) ||
      (filePath.charCodeAt(0) >= 97 && filePath.charCodeAt(0) <= 122))
  );
}

function normalizeDirectoryCountPath(filePath: string): string {
  const slashNormalized = filePath.includes('\\') ? filePath.replaceAll('\\', '/') : filePath;
  if (
    slashNormalized.length > 1 &&
    slashNormalized.endsWith('/') &&
    !isWindowsDriveRootPath(slashNormalized)
  ) {
    const minimumPathLength = hasWindowsDriveRootPrefix(slashNormalized)
      ? WINDOWS_DRIVE_ROOT_LENGTH
      : 1;
    let endIndex = slashNormalized.length;
    while (endIndex > minimumPathLength && slashNormalized[endIndex - 1] === '/') {
      endIndex -= 1;
    }
    return slashNormalized.slice(0, endIndex);
  }
  return slashNormalized;
}

function isAbsolutePathLike(filePath: string): boolean {
  return filePath.startsWith('/') || WINDOWS_DRIVE_PATH_PATTERN.test(filePath);
}

function resolveWorkspaceRelativeNodePath(folderId: string, nodePath: string): string | null {
  if (!(folderId && isAbsolutePathLike(folderId))) {
    return null;
  }

  const normalizedFolderId = normalizeDirectoryCountPath(folderId);
  const normalizedNodePath = normalizeDirectoryCountPath(nodePath);
  if (normalizedNodePath === normalizedFolderId) {
    return '/';
  }
  if (!isDescendantPath(normalizedNodePath, normalizedFolderId)) {
    return null;
  }
  return normalizedNodePath.slice(normalizedFolderId.length);
}

function getWorkspaceSelectionPathCandidates(folderId: string, path: string): string[] {
  const candidates = [path];
  const relativePath = resolveWorkspaceRelativeNodePath(folderId, path);
  if (!relativePath) {
    return candidates;
  }
  if (!candidates.includes(relativePath)) {
    candidates.push(relativePath);
  }
  if (relativePath.startsWith('/') && relativePath.length > 1) {
    const bareRelativePath = relativePath.slice(1);
    if (!candidates.includes(bareRelativePath)) {
      candidates.push(bareRelativePath);
    }
  }
  return candidates;
}

function isWorkspacePathSelected(
  selectedFilePaths: Set<string>,
  folderId: string,
  path: string
): boolean {
  for (const candidatePath of getWorkspaceSelectionPathCandidates(folderId, path)) {
    if (isPathSelectedInFolder(selectedFilePaths, folderId, candidatePath)) {
      return true;
    }
  }
  return false;
}

function isSameOrDescendantSelectionPath(path: string, candidatePath: string): boolean {
  const normalizedCandidate = normalizeDirectoryCountPath(candidatePath);
  if (normalizedCandidate === '') {
    return true;
  }
  if (normalizedCandidate === '/') {
    return path === '/' || path.startsWith('/');
  }
  const candidatePrefix = `${normalizedCandidate}/`;
  return path === normalizedCandidate || path.startsWith(candidatePrefix);
}

function addUniqueAncestorPath(
  ancestorPaths: string[],
  seenAncestorPaths: Set<string>,
  ancestorPath: string
): void {
  if (seenAncestorPaths.has(ancestorPath)) {
    return;
  }
  seenAncestorPaths.add(ancestorPath);
  ancestorPaths.push(ancestorPath);
}

function addAncestorDirectoryPaths(
  ancestorPaths: string[],
  seenAncestorPaths: Set<string>,
  filePath: string,
  lowerBoundPath?: string
): void {
  const normalizedFilePath = normalizeDirectoryCountPath(filePath);
  const normalizedLowerBoundPath = lowerBoundPath
    ? normalizeDirectoryCountPath(lowerBoundPath)
    : undefined;
  let separatorIndex = normalizedFilePath.lastIndexOf('/');
  while (separatorIndex > 0) {
    const ancestorPath = normalizedFilePath.slice(0, separatorIndex);
    if (
      normalizedLowerBoundPath &&
      ancestorPath !== normalizedLowerBoundPath &&
      !isDescendantPath(ancestorPath, normalizedLowerBoundPath)
    ) {
      separatorIndex = normalizedFilePath.lastIndexOf('/', separatorIndex - 1);
      continue;
    }

    addUniqueAncestorPath(ancestorPaths, seenAncestorPaths, ancestorPath);
    if (ancestorPath === normalizedLowerBoundPath) {
      break;
    }
    separatorIndex = normalizedFilePath.lastIndexOf('/', separatorIndex - 1);
  }
}

function resolveWorkspaceAbsoluteSelectionPath(folderId: string, selectedPath: string): string {
  const normalizedFolderId = normalizeDirectoryCountPath(folderId);
  const normalizedSelectedPath = normalizeDirectoryCountPath(selectedPath);
  if (
    normalizedSelectedPath === normalizedFolderId ||
    isDescendantPath(normalizedSelectedPath, normalizedFolderId)
  ) {
    return normalizedSelectedPath;
  }

  const relativeSelectionPath = normalizedSelectedPath.replace(/^\/+/, '');
  if (normalizedFolderId === '/') {
    return `/${relativeSelectionPath}`;
  }
  return `${normalizedFolderId}/${relativeSelectionPath}`;
}

function computeAncestorDirectoryPaths(filePath: string, folderId: string): string[] {
  const ancestorPaths: string[] = [];
  const seenAncestorPaths = new Set<string>();
  addAncestorDirectoryPaths(ancestorPaths, seenAncestorPaths, filePath);

  // Root rows can be rendered as an empty path in browser-relative trees, as
  // "/" for filesystem roots, or as the absolute workspace path on desktop.
  // Count them directly so selected descendants are observable before children
  // are hydrated.
  addUniqueAncestorPath(ancestorPaths, seenAncestorPaths, '');
  if (filePath.startsWith('/')) {
    addUniqueAncestorPath(ancestorPaths, seenAncestorPaths, '/');
  }

  if (folderId) {
    const normalizedFolderId = normalizeDirectoryCountPath(folderId);
    addUniqueAncestorPath(ancestorPaths, seenAncestorPaths, normalizedFolderId);
    if (isAbsolutePathLike(normalizedFolderId)) {
      const absoluteSelectionPath = resolveWorkspaceAbsoluteSelectionPath(
        normalizedFolderId,
        filePath
      );
      addAncestorDirectoryPaths(
        ancestorPaths,
        seenAncestorPaths,
        absoluteSelectionPath,
        normalizedFolderId
      );
    }
  }

  return ancestorPaths;
}

function createSelectedPathAncestorResolver(
  folderId: string,
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

      const ancestorPaths = computeAncestorDirectoryPaths(filePath, folderId);
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

function collectTreePaths(nodes: IFileNode[], pathSet: Set<string>): void {
  for (const node of nodes) {
    pathSet.add(node.path);
    if (node.children) {
      collectTreePaths(node.children, pathSet);
    }
  }
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

  const selectedPathResolver = createSelectedPathAncestorResolver(
    folderId,
    selectedPathAncestorCache
  );
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
  const selectedPathResolver = createSelectedPathAncestorResolver(
    folderId,
    selectedPathAncestorCache
  );
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
  folderId: string,
  selectionModel: FileExplorerState['selectionModel'],
  querySelectionManifest: FileExplorerState['querySelectionManifest']
): Map<string, number> {
  const selectedDirectoryCountSnapshotRef = useRef<SelectedDirectoryCountSnapshot>(
    createSelectedDirectoryCountSnapshot(folderId)
  );
  const queryDirectoryCounts = useMemo(
    () =>
      resolveQuerySelection(selectionModel.queryDescriptor, querySelectionManifest).directoryCounts,
    [querySelectionManifest, selectionModel.queryDescriptor]
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

  useEffect(
    () => () => {
      selectedDirectoryCountSnapshotRef.current = createSelectedDirectoryCountSnapshot(
        selectedDirectoryCountSnapshotRef.current.folderId
      );
    },
    []
  );

  return selectionModel.mode === 'query'
    ? queryDirectoryCounts
    : nextSnapshot.selectedDirectoryCounts;
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
    selectionModel,
    selectedDirectoryCounts,
    selectedFilePaths,
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
    selectionModel,
    selectedDirectoryCounts,
    selectedFilePaths,
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

function computeNodeSelectionState(
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

function hasUnloadedDirectoryChildren(node: IFileNode): boolean {
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
    fileNode: node,
    directoryTotalFiles:
      node.type === 'directory' ? fileExplorer.getFolderFileCount(node).count : 0,
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

function shouldLoadDirectoryRecursively(node: IFileNode): boolean {
  return (
    node.loadState !== 'loaded' ||
    (node.children?.some((child) => child.type === 'directory' && child.loadState !== 'loaded') ??
      false)
  );
}

function resolveDirectorySelectionMutation({
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

function applyDirectorySelectionMutation(params: {
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

function applyFileSelectionMutation({
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

function getSelectedDescendantPathsForDirectory({
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
  normalizedTree: NonNullable<
    ReturnType<typeof useOptionalFileTreeNormalizedContext>
  >['normalizedTreeRef']['current'],
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

function getNormalizedImmediateChildren(
  normalizedTree: NonNullable<
    ReturnType<typeof useOptionalFileTreeNormalizedContext>
  >['normalizedTreeRef']['current'],
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

function hasNormalizedUnloadedDirectoryChildren(
  normalizedTree: NonNullable<
    ReturnType<typeof useOptionalFileTreeNormalizedContext>
  >['normalizedTreeRef']['current'],
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

function buildRowsFromNormalizedTree(
  normalizedTree: NonNullable<
    ReturnType<typeof useOptionalFileTreeNormalizedContext>
  >['normalizedTreeRef']['current'],
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
      id: entry.node.path,
      type: entry.node.type,
      depth: entry.depth,
      data: rowData,
      parentId: entry.parentId,
      hasChildren: entry.node.type === 'directory',
      isLoading: rowData.isChildrenLoading,
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
  normalizedTree: NonNullable<
    ReturnType<typeof useOptionalFileTreeNormalizedContext>
  >['normalizedTreeRef']['current'],
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
    const querySelectionManifest = useFileExplorerStoreSelector((s) => s.querySelectionManifest);
    const selectedCount = useMemo(
      () => getSelectionCount(selectionModel, selectedFilePaths, querySelectionManifest),
      [querySelectionManifest, selectedFilePaths, selectionModel]
    );
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
    const treeRows = useMemo(() => {
      fileTreeTelemetry.treeRowsRebuildCount++;
      const options: BuildFileTreeRowsOptions = {
        expandedDirectoryPaths,
        folderId,
        loadingFiles,
        ...(loadingPaths ? { loadingPaths } : {}),
        ...(isLoadingForSelection === undefined ? {} : { isLoadingForSelection }),
        ...(loadingPathForSelection === undefined ? {} : { loadingPathForSelection }),
      };

      if (normalizedTreeContext) {
        return buildRowsFromNormalizedTree(
          normalizedTreeContext.normalizedTreeRef.current,
          options,
          normalizedTreeContext.getDescendantFileCount,
          filteredPathSet
        );
      }

      // When worker-flattened nodes are available, use them to avoid main-thread DFS
      if (flattenedNodes && fileNodeIndex) {
        return buildRowsFromWorkerNodes(flattenedNodes, (path) => fileNodeIndex.get(path), options);
      }

      return buildFileTreeRows(fileTree, options);
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

    const directoryTraversalContext = useMemo<DirectorySelectionTraversalContext>(
      () => ({
        getDirectoryMetadata: (node: IFileNode) => {
          if (node.type !== 'directory') {
            return {
              directoryTotalFiles: 0,
              hasUnloadedDirectoryChildren: false,
              immediateChildren: [],
            };
          }

          if (normalizedTreeContext) {
            return {
              directoryTotalFiles: normalizedTreeContext.getDescendantFileCount(node.path),
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

          return {
            directoryTotalFiles: fileExplorer.getFolderFileCount(node).count,
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
          return;
        }

        const node = rowData.fileNode;
        const selectionState = getNodeSelectionState(rowData);
        if (selectionState.wouldExceedLimit) {
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
          return;
        }

        const directorySelectedCount = selectedDirectoryCounts.get(node.path) ?? 0;

        const allFilePaths = normalizedTreeContext
          ? normalizedTreeContext.getDescendantFilePaths(node.path)
          : fileExplorer.getAllFilePathsInDirectory(directoryNode);

        const selectionMutation = resolveDirectorySelectionMutation({
          allFilePaths,
          currentSelectionSize: selectedCount,
          folderId,
          selectedFilePaths,
          selectedCount: directorySelectedCount,
          directoryTotalFiles,
          maxSelectionCount,
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
        directoryTraversalContext,
        folderId: folderId ?? '',
        isDirectorySelectionLocked: Boolean(isLoadingForSelection),
        maxSelectionCount,
        openFileInTab,
        selectedCount,
        selectedDirectoryCounts,
        selectedFilePaths,
        querySelectionManifest,
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
        <div
          className="relative h-full min-h-0 flex-1 overflow-y-auto"
          data-testid="file-tree-scroll-container"
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
      </FileTreeSelectionContext.Provider>
    );
  }
);

OptimizedFileTree.displayName = 'OptimizedFileTree';

export default OptimizedFileTree;
