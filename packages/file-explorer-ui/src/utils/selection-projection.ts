import { resolveQuerySelection } from '@brainstrike/file-explorer';
import type {
  QuerySelectionManifest,
  SelectionModel,
  SelectionQueryDescriptor,
} from '@brainstrike/types';
import { accumulateAncestorDirectoryCounts, isDescendantPath } from '@brainstrike/utils';
import { processFilter } from '@brainstrike/utils/filter-utils';
import { fileFilter } from '@brainstrike/utils/path-filter';
import { encodeFileSelection, isPathSelectedInFolder } from '@brainstrike/utils/selection-utils';

interface DescriptorMatchers {
  coveredDirectoryPaths: Set<string>;
  excludedPaths: Set<string>;
  includedPaths: Set<string>;
  matchesExclude: (path: string) => boolean;
  matchesInclude: (path: string) => boolean;
}

const descriptorMatcherCache = new WeakMap<SelectionQueryDescriptor, DescriptorMatchers>();
const materializedDirectoryCountCache = new WeakMap<ReadonlySet<string>, Map<string, number>>();

function matchesAnyPathVariant(path: string, matcher: (value: string) => boolean): boolean {
  if (matcher(path)) {
    return true;
  }
  return path.startsWith('/') ? matcher(path.slice(1)) : false;
}

function createPathMatcher(patterns: string[], useRegex: boolean): (path: string) => boolean {
  if (patterns.length === 0) {
    return () => false;
  }

  const matchers = patterns.map((pattern) =>
    fileFilter.createMatcher(useRegex ? pattern : processFilter(pattern), useRegex)
  );

  return (path: string) => {
    for (const matcher of matchers) {
      if (matchesAnyPathVariant(path, matcher)) {
        return true;
      }
    }
    return false;
  };
}

function getDescriptorMatchers(descriptor: SelectionQueryDescriptor): DescriptorMatchers {
  const cached = descriptorMatcherCache.get(descriptor);
  if (cached) {
    return cached;
  }

  const matchers: DescriptorMatchers = {
    coveredDirectoryPaths: new Set(descriptor.coveredDirectoryPaths),
    excludedPaths: new Set(descriptor.excludedPaths),
    includedPaths: new Set(descriptor.includedPaths),
    matchesExclude: createPathMatcher(descriptor.excludeFilters, descriptor.useRegex),
    matchesInclude: createPathMatcher(descriptor.includeFilters, descriptor.useRegex),
  };
  descriptorMatcherCache.set(descriptor, matchers);
  return matchers;
}

function buildMaterializedDirectoryCounts(
  materializedPaths: ReadonlySet<string>
): Map<string, number> {
  return accumulateAncestorDirectoryCounts(materializedPaths, {
    cache: new Map<string, readonly string[]>(),
    includeRoot: true,
  });
}

function getMaterializedDirectoryCounts(
  materializedPaths: ReadonlySet<string> | null | undefined
): Map<string, number> | null {
  if (!(materializedPaths && materializedPaths.size > 0)) {
    return null;
  }

  const cached = materializedDirectoryCountCache.get(materializedPaths);
  if (cached) {
    return cached;
  }

  const counts = buildMaterializedDirectoryCounts(materializedPaths);
  materializedDirectoryCountCache.set(materializedPaths, counts);
  return counts;
}

function isPathWithinRoot(path: string, rootPath: string | null): boolean {
  if (!rootPath) {
    return true;
  }
  return path === rootPath || isDescendantPath(path, rootPath);
}

function isQuerySelectionManifestReady(
  descriptor: SelectionQueryDescriptor,
  manifest: QuerySelectionManifest | null
): manifest is QuerySelectionManifest {
  return Boolean(
    manifest &&
      manifest.status === 'ready' &&
      manifest.fingerprint === descriptor.manifestFingerprint &&
      manifest.snapshotId === descriptor.manifestSnapshotId
  );
}

function getMaterializedDirectorySelectedCount(
  directoryPath: string,
  materializedPaths: ReadonlySet<string> | null | undefined
): number {
  return getMaterializedDirectoryCounts(materializedPaths)?.get(directoryPath) ?? 0;
}

export function isQuerySelectionPathSelected(
  descriptor: SelectionQueryDescriptor | null,
  manifest: QuerySelectionManifest | null,
  folderId: string | null,
  path: string,
  materializedPaths?: ReadonlySet<string> | null
): boolean {
  if (!(descriptor && folderId && descriptor.folderId === folderId)) {
    return false;
  }

  const {
    coveredDirectoryPaths: _coveredDirectoryPaths,
    excludedPaths,
    includedPaths,
    matchesExclude,
    matchesInclude,
  } = getDescriptorMatchers(descriptor);

  if (includedPaths.has(path)) {
    return true;
  }
  if (excludedPaths.has(path)) {
    return false;
  }

  if (!isPathWithinRoot(path, descriptor.rootPath)) {
    return false;
  }

  if (matchesExclude(path)) {
    return false;
  }

  if (descriptor.includeFilters.length > 0 && !matchesInclude(path)) {
    return false;
  }

  if (isQuerySelectionManifestReady(descriptor, manifest)) {
    return resolveQuerySelection(descriptor, manifest).pathSet.has(path);
  }

  return materializedPaths?.has(path) ?? false;
}

export function isSelectionPathSelected(params: {
  currentFolderId: string | null;
  path: string;
  querySelectionManifest?: QuerySelectionManifest | null;
  selectedFilePaths: Set<string>;
  selectionModel: SelectionModel;
}): boolean {
  const { currentFolderId, path, querySelectionManifest, selectedFilePaths, selectionModel } =
    params;

  if (selectionModel.mode === 'query') {
    return isQuerySelectionPathSelected(
      selectionModel.queryDescriptor,
      querySelectionManifest ?? null,
      currentFolderId,
      path,
      selectionModel.materializedPaths
    );
  }

  if (selectionModel.mode === 'rules') {
    return selectionModel.materializedPaths?.has(path) ?? false;
  }

  return currentFolderId ? isPathSelectedInFolder(selectedFilePaths, currentFolderId, path) : false;
}

export function getSelectionCount(
  selectionModel: SelectionModel,
  selectedFilePaths: Set<string>,
  querySelectionManifest?: QuerySelectionManifest | null
): number {
  if (selectionModel.mode === 'query' && selectionModel.queryDescriptor) {
    return resolveQuerySelection(selectionModel.queryDescriptor, querySelectionManifest ?? null)
      .selectedCount;
  }
  if (selectionModel.mode === 'rules' && selectionModel.materializedPaths) {
    return selectionModel.materializedPaths.size;
  }
  return selectedFilePaths.size;
}

export function materializeCompositeKeysForSelectionModel(params: {
  currentFolderId: string | null;
  querySelectionManifest?: QuerySelectionManifest | null;
  selectedFilePaths: Set<string>;
  selectionModel: SelectionModel;
}): Set<string> {
  const { currentFolderId, querySelectionManifest, selectedFilePaths, selectionModel } = params;

  if (selectionModel.mode === 'rules' && selectionModel.materializedPaths && currentFolderId) {
    const compositeKeys = new Set<string>();
    for (const relativePath of selectionModel.materializedPaths) {
      compositeKeys.add(encodeFileSelection(currentFolderId, relativePath));
    }
    return compositeKeys;
  }

  if (selectionModel.mode === 'query' && currentFolderId) {
    const compositeKeys = new Set<string>();
    const relativePaths =
      querySelectionManifest?.status === 'ready'
        ? resolveQuerySelection(selectionModel.queryDescriptor, querySelectionManifest).filePaths
        : Array.from(selectionModel.materializedPaths ?? []);
    for (const relativePath of relativePaths) {
      compositeKeys.add(encodeFileSelection(currentFolderId, relativePath));
    }
    return compositeKeys;
  }

  return selectedFilePaths;
}

export function isDirectoryCoveredByQuerySelection(
  descriptor: SelectionQueryDescriptor | null,
  manifest: QuerySelectionManifest | null,
  folderId: string | null,
  directoryPath: string,
  materializedPaths?: ReadonlySet<string> | null
): boolean {
  if (!(descriptor && folderId && descriptor.folderId === folderId)) {
    return false;
  }

  if (isQuerySelectionManifestReady(descriptor, manifest)) {
    return (
      (resolveQuerySelection(descriptor, manifest).directoryCounts.get(directoryPath) ?? 0) > 0
    );
  }

  if (
    materializedPaths &&
    getMaterializedDirectorySelectedCount(directoryPath, materializedPaths) > 0
  ) {
    return true;
  }

  return getDescriptorMatchers(descriptor).coveredDirectoryPaths.has(directoryPath);
}

export function getDirectorySelectedCount(
  descriptor: SelectionQueryDescriptor | null,
  manifest: QuerySelectionManifest | null,
  folderId: string | null,
  directoryPath: string,
  materializedPaths?: ReadonlySet<string> | null
): number {
  if (!(descriptor && folderId && descriptor.folderId === folderId)) {
    return 0;
  }

  if (isQuerySelectionManifestReady(descriptor, manifest)) {
    return resolveQuerySelection(descriptor, manifest).directoryCounts.get(directoryPath) ?? 0;
  }

  return getMaterializedDirectorySelectedCount(directoryPath, materializedPaths);
}

export function getQuerySelectionMatchingCount(
  descriptor: SelectionQueryDescriptor | null,
  manifest: QuerySelectionManifest | null,
  folderId: string | null,
  directoryPath: string,
  materializedPaths?: ReadonlySet<string> | null
): number {
  if (!(descriptor && folderId && descriptor.folderId === folderId)) {
    return 0;
  }

  if (isQuerySelectionManifestReady(descriptor, manifest)) {
    let totalMatchingCount = manifest.directoryCounts.get(directoryPath) ?? 0;

    for (const filePath of descriptor.includedPaths) {
      if (manifest.pathSet.has(filePath)) {
        continue;
      }
      if (isDescendantPath(filePath, directoryPath)) {
        totalMatchingCount += 1;
      }
    }

    return totalMatchingCount;
  }

  return getMaterializedDirectorySelectedCount(directoryPath, materializedPaths);
}
