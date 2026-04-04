import { resolveQuerySelection } from '@brainstrike/file-explorer';
import type {
  QuerySelectionManifest,
  SelectionModel,
  SelectionQueryDescriptor,
} from '@brainstrike/types';
import { processFilter } from '@brainstrike/utils/filter-utils';
import { fileFilter } from '@brainstrike/utils/path-filter';
import { encodeFileSelection, isPathSelectedInFolder } from '@brainstrike/utils/selection-utils';

interface DescriptorMatchers {
  matchesExclude: (path: string) => boolean;
  matchesInclude: (path: string) => boolean;
}

const descriptorMatcherCache = new WeakMap<SelectionQueryDescriptor, DescriptorMatchers>();
const coveredDirectoryCache = new WeakMap<SelectionQueryDescriptor, Set<string>>();

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

  const nextMatchers = {
    matchesExclude: createPathMatcher(descriptor.excludeFilters, descriptor.useRegex),
    matchesInclude: createPathMatcher(descriptor.includeFilters, descriptor.useRegex),
  };
  descriptorMatcherCache.set(descriptor, nextMatchers);
  return nextMatchers;
}

function getCoveredDirectoryPaths(descriptor: SelectionQueryDescriptor): Set<string> {
  const cached = coveredDirectoryCache.get(descriptor);
  if (cached) {
    return cached;
  }

  const nextCoveredPaths = new Set(descriptor.coveredDirectoryPaths);
  coveredDirectoryCache.set(descriptor, nextCoveredPaths);
  return nextCoveredPaths;
}

function isPathWithinRoot(path: string, rootPath: string | null): boolean {
  if (!rootPath) {
    return true;
  }
  return path === rootPath || path.startsWith(`${rootPath}/`);
}

export function isQuerySelectionPathSelected(
  descriptor: SelectionQueryDescriptor | null,
  manifest: QuerySelectionManifest | null,
  folderId: string | null,
  path: string
): boolean {
  if (!(descriptor && folderId && descriptor.folderId === folderId)) {
    return false;
  }

  if (descriptor.includedPaths.includes(path)) {
    return true;
  }
  if (descriptor.excludedPaths.includes(path)) {
    return false;
  }

  if (!isPathWithinRoot(path, descriptor.rootPath)) {
    return false;
  }

  const { matchesExclude, matchesInclude } = getDescriptorMatchers(descriptor);
  if (matchesExclude(path)) {
    return false;
  }

  if (descriptor.includeFilters.length > 0 && !matchesInclude(path)) {
    return false;
  }

  if (manifest) {
    return resolveQuerySelection(descriptor, manifest).pathSet.has(path);
  }

  return true;
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
      path
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
    for (const relativePath of resolveQuerySelection(
      selectionModel.queryDescriptor,
      querySelectionManifest ?? null
    ).filePaths) {
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
  directoryPath: string
): boolean {
  if (!(descriptor && folderId && descriptor.folderId === folderId)) {
    return false;
  }
  if (manifest) {
    return (
      (resolveQuerySelection(descriptor, manifest).directoryCounts.get(directoryPath) ?? 0) > 0
    );
  }
  return getCoveredDirectoryPaths(descriptor).has(directoryPath);
}

export function getDirectorySelectedCount(
  descriptor: SelectionQueryDescriptor | null,
  manifest: QuerySelectionManifest | null,
  folderId: string | null,
  directoryPath: string
): number {
  if (!(descriptor && folderId && descriptor.folderId === folderId)) {
    return 0;
  }
  return resolveQuerySelection(descriptor, manifest).directoryCounts.get(directoryPath) ?? 0;
}
