import { resolveQuerySelection } from '@brainstrike/file-explorer';
import type { FileExplorerState, IFileNode } from '@brainstrike/types';
import { isDescendantPath } from '@brainstrike/utils';
import { isPathSelectedInFolder } from '@brainstrike/utils/selection-utils';
import { useEffect, useMemo, useRef } from 'react';

// Bound ancestor-path cache growth for large workspaces (15k+ files) while
// keeping hot paths resident across frequent selection changes.
const MAX_SELECTED_PATH_ANCESTOR_CACHE_ENTRIES = 50_000;
// Retain the most recently touched half to avoid a full cold-cache cliff.
const SELECTED_PATH_ANCESTOR_CACHE_RETAIN_ENTRIES = 25_000;
export const EMPTY_SELECTION_PATHS: string[] = [];

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

export function getWorkspaceSelectionPathCandidates(folderId: string, path: string): string[] {
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

export function isWorkspacePathSelected(
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

export function isSameOrDescendantSelectionPath(path: string, candidatePath: string): boolean {
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

export function collectTreePaths(nodes: IFileNode[], pathSet: Set<string>): void {
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
    selectedDirectoryCounts: new Map(),
    selectedFilePaths: null,
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
      selectedDirectoryCounts: new Map(),
      selectedFilePaths,
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
      selectedDirectoryCounts: rebuiltCounts.directoryCounts,
      selectedFilePaths,
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
    selectedDirectoryCounts: updatedCounts.directoryCounts,
    selectedFilePaths,
    selectedPathAncestorCache: updatedCounts.selectedPathAncestorCache,
  };
}

export function useSelectedDirectoryCounts(
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
