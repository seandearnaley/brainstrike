import { type FileExplorerState, type IFileNode, isPseudoFileNodeType } from '@brainstrike/types';
import { getSelectedPathsForFolder } from '../selection.js';
import { resolveQuerySelection } from '../utils/query-selection-manifest.js';

export interface DirectorySelectionSnapshot {
  directoryPath: string;
  entries: readonly Pick<IFileNode, 'path' | 'type'>[];
}

function normalizePath(path: string, caseInsensitive: boolean): string {
  const normalized = path.replace(/\\/gu, '/');
  const withoutTrailingSlash =
    normalized.length > 1 && !/^[A-Za-z]:\/$/u.test(normalized)
      ? normalized.replace(/\/+$/u, '')
      : normalized;
  return caseInsensitive ? withoutTrailingSlash.toLowerCase() : withoutTrailingSlash;
}

function isCaseInsensitivePath(path: string): boolean {
  const normalized = path.replace(/\\/gu, '/');
  return /^[A-Za-z]:\//u.test(normalized) || normalized.startsWith('//');
}

function getDirectChildPath(selectedPath: string, directoryPath: string): string | null {
  if (selectedPath === directoryPath) {
    return null;
  }
  const prefix = directoryPath.endsWith('/') ? directoryPath : `${directoryPath}/`;
  if (!selectedPath.startsWith(prefix)) {
    return null;
  }
  const remainder = selectedPath.slice(prefix.length);
  if (!remainder) {
    return null;
  }
  const separatorIndex = remainder.indexOf('/');
  const childName = separatorIndex === -1 ? remainder : remainder.slice(0, separatorIndex);
  return `${prefix}${childName}`;
}

function getQueryPaths(state: FileExplorerState, folderId: string): string[] {
  const descriptor = state.selectionModel.queryDescriptor;
  if (!descriptor || descriptor.folderId !== folderId) {
    return [];
  }
  const manifest = state.querySelectionManifest;
  if (
    manifest?.status === 'ready' &&
    manifest.fingerprint === descriptor.manifestFingerprint &&
    manifest.snapshotId === descriptor.manifestSnapshotId
  ) {
    return resolveQuerySelection(descriptor, manifest).filePaths;
  }
  const paths = new Set(state.selectionModel.materializedPaths ?? []);
  for (const path of descriptor.excludedPaths) {
    paths.delete(path);
  }
  for (const path of descriptor.includedPaths) {
    paths.add(path);
  }
  return Array.from(paths);
}

/**
 * Resolve the exact root-scoped selection projection consumed by refresh
 * reconciliation. Query-backed focused roots use their manifest/overrides;
 * foreign roots use their explicit folder snapshot.
 */
export function getSelectionProjectionPaths(state: FileExplorerState, folderId: string): string[] {
  const isForeignRoot = state.currentFolderId !== null && state.currentFolderId !== folderId;
  if (state.selectionModel.mode === 'query' && !isForeignRoot) {
    return getQueryPaths(state, folderId);
  }
  const keys = isForeignRoot
    ? (state.folderStates[folderId]?.selectedFilePaths ?? new Set<string>())
    : state.selectedFilePaths;
  return Array.from(getSelectedPathsForFolder(keys, folderId));
}

function isPathWithinRoot(path: string, rootPath: string): boolean {
  if (path === rootPath) {
    return true;
  }
  const rootPrefix = rootPath.endsWith('/') ? rootPath : `${rootPath}/`;
  return path.startsWith(rootPrefix);
}

function pathDepth(path: string): number {
  return path.split('/').filter(Boolean).length;
}

function compareAncestorDirectories(
  left: { comparisonPath: string; path: string },
  right: { comparisonPath: string; path: string }
): number {
  const depthDifference = pathDepth(left.comparisonPath) - pathDepth(right.comparisonPath);
  if (depthDifference !== 0) {
    return depthDifference;
  }
  if (left.comparisonPath === right.comparisonPath) {
    return 0;
  }
  return left.comparisonPath < right.comparisonPath ? -1 : 1;
}

/**
 * Derive only the directory boundaries needed to revalidate the current
 * selection after a shallow root refresh. The result is unique and
 * parent-first; it walks selected paths and their ancestors, never the tree.
 */
export function getSelectionAncestorDirectories(
  state: FileExplorerState,
  folderId: string,
  rootPath: string
): string[] {
  const caseInsensitive = isCaseInsensitivePath(rootPath);
  const comparisonRootPath = normalizePath(rootPath, caseInsensitive);
  const ancestorsByComparisonPath = new Map<string, { comparisonPath: string; path: string }>();

  for (const selectedPath of getSelectionProjectionPaths(state, folderId)) {
    const comparisonSelectedPath = normalizePath(selectedPath, caseInsensitive);
    if (!isPathWithinRoot(comparisonSelectedPath, comparisonRootPath)) {
      continue;
    }

    let candidatePath = presentationParentPath(selectedPath);
    while (candidatePath) {
      const comparisonPath = normalizePath(candidatePath, caseInsensitive);
      if (comparisonPath === comparisonRootPath) {
        break;
      }
      if (!isPathWithinRoot(comparisonPath, comparisonRootPath)) {
        break;
      }
      if (!ancestorsByComparisonPath.has(comparisonPath)) {
        ancestorsByComparisonPath.set(comparisonPath, {
          comparisonPath,
          path: candidatePath,
        });
      }
      candidatePath = presentationParentPath(candidatePath);
    }
  }

  return Array.from(ancestorsByComparisonPath.values())
    .sort(compareAncestorDirectories)
    .map((entry) => entry.path);
}

/**
 * Strip one segment without rewriting separator presentation. Selection paths
 * are also normalized-tree keys, so converting their ancestors to the root's
 * preferred separator can make an O(1) lookup miss a real directory.
 */
function presentationParentPath(path: string): string | null {
  const separatorIndex = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (separatorIndex < 0) {
    return null;
  }
  if (separatorIndex === 0) {
    return path.slice(0, 1);
  }
  if (separatorIndex === 2 && /^[A-Za-z]:[\\/]$/u.test(path.slice(0, 3))) {
    return path.slice(0, 3);
  }
  return path.slice(0, separatorIndex);
}

function parentPath(path: string): string | null {
  const separatorIndex = path.lastIndexOf('/');
  if (separatorIndex < 0) {
    return null;
  }
  if (separatorIndex === 0) {
    return '/';
  }
  if (separatorIndex === 2 && /^[A-Za-z]:\//u.test(path)) {
    return path.slice(0, 3);
  }
  return path.slice(0, separatorIndex);
}

type SnapshotIndex = ReadonlyMap<string, ReadonlyMap<string, 'directory' | 'file'>>;

function buildSnapshotIndex(
  snapshots: readonly DirectorySelectionSnapshot[],
  caseInsensitive: boolean
): SnapshotIndex {
  const index = new Map<string, ReadonlyMap<string, 'directory' | 'file'>>();
  for (const snapshot of snapshots) {
    if (snapshot.entries.some((entry) => isPseudoFileNodeType(entry.type))) {
      continue;
    }
    const entries = new Map<string, 'directory' | 'file'>();
    for (const entry of snapshot.entries) {
      if (entry.type === 'directory' || entry.type === 'file') {
        entries.set(normalizePath(entry.path, caseInsensitive), entry.type);
      }
    }
    index.set(normalizePath(snapshot.directoryPath, caseInsensitive), entries);
  }
  return index;
}

function isDisprovenByAuthoritativeSnapshots(
  selectedPath: string,
  snapshots: SnapshotIndex
): boolean {
  let candidateDirectory = parentPath(selectedPath);
  while (candidateDirectory) {
    const entries = snapshots.get(candidateDirectory);
    if (entries) {
      const directChildPath = getDirectChildPath(selectedPath, candidateDirectory);
      const entryType = directChildPath ? entries.get(directChildPath) : undefined;
      // Selection contains files only. An authoritative direct directory hit
      // therefore proves that the previously selected file was retyped.
      const isReplacedByFile = entryType === 'file' && selectedPath !== directChildPath;
      const isReplacedByDirectory = entryType === 'directory' && selectedPath === directChildPath;
      if (!entryType || isReplacedByFile || isReplacedByDirectory) {
        return true;
      }
    }
    const parent = parentPath(candidateDirectory);
    if (parent === candidateDirectory) {
      return false;
    }
    candidateDirectory = parent;
  }
  return false;
}

export function getVanishedSelectionPaths(
  state: FileExplorerState,
  folderId: string,
  snapshots: readonly DirectorySelectionSnapshot[]
): string[] {
  const caseInsensitive = snapshots.some((snapshot) =>
    isCaseInsensitivePath(snapshot.directoryPath)
  );
  const snapshotIndex = buildSnapshotIndex(snapshots, caseInsensitive);
  const vanishedPaths: string[] = [];
  for (const originalPath of getSelectionProjectionPaths(state, folderId)) {
    if (
      isDisprovenByAuthoritativeSnapshots(
        normalizePath(originalPath, caseInsensitive),
        snapshotIndex
      )
    ) {
      vanishedPaths.push(originalPath);
    }
  }
  return vanishedPaths;
}
