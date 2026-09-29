import { resolveQuerySelection } from '@brainstrike/file-explorer';
import { encodeFileSelection, isPathSelectedInFolder } from '@brainstrike/file-explorer/selection';
import { isDescendantPath } from '@brainstrike/file-tree-worker';
import type {
  QuerySelectionManifest,
  SelectionModel,
  SelectionQueryDescriptor,
} from '@brainstrike/types';
import { accumulateAncestorDirectoryCounts } from '@brainstrike/utils';
import { processFilter } from '@brainstrike/utils/filter-utils';
import { fileFilter } from '@brainstrike/utils/path-filter';

interface DescriptorMatchers {
  coveredDirectoryPaths: Set<string>;
  excludedPaths: Set<string>;
  includedPaths: Set<string>;
  matchesExclude: (path: string) => boolean;
  matchesInclude: (path: string) => boolean;
}

interface MaterializedDirectoryCountCacheEntry {
  counts: ReadonlyMap<string, number>;
  materializedPaths: ReadonlySet<string>;
  weight: number;
}

interface MaterializedPathSetSignature {
  key: string;
  totalPathLength: number;
}

const CACHE_ENTRY_WEIGHT = 32;
const DEFAULT_MAX_MATERIALIZED_STRUCTURAL_CACHE_ENTRIES = 4;
// Approximate retained UTF-16 units plus per-entry container overhead. The
// structural tier is deliberately small because every entry strongly retains
// a path snapshot and its derived ancestor map; the identity tier stays weak.
const DEFAULT_MAX_MATERIALIZED_STRUCTURAL_CACHE_WEIGHT = 8_000_000;

let descriptorMatcherCache = new WeakMap<SelectionQueryDescriptor, DescriptorMatchers>();
let materializedDirectoryCountCache = new WeakMap<
  ReadonlySet<string>,
  ReadonlyMap<string, number>
>();
const materializedStructuralCache = new Map<string, MaterializedDirectoryCountCacheEntry>();
let materializedDirectoryCountBuilds = 0;
let materializedStructuralCacheHits = 0;
let materializedStructuralCacheConsumers = 0;
let materializedStructuralCacheGeneration = 0;
let materializedStructuralCacheMaxEntries = DEFAULT_MAX_MATERIALIZED_STRUCTURAL_CACHE_ENTRIES;
let materializedStructuralCacheMaxWeight = DEFAULT_MAX_MATERIALIZED_STRUCTURAL_CACHE_WEIGHT;
let materializedStructuralPrecheckRejections = 0;
let materializedStructuralCacheWeight = 0;

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
  materializedDirectoryCountBuilds += 1;
  return accumulateAncestorDirectoryCounts(materializedPaths, {
    cache: new Map<string, readonly string[]>(),
    includeRoot: true,
  });
}

function getMaterializedPathSetSignature(
  materializedPaths: ReadonlySet<string>
): MaterializedPathSetSignature {
  let combinedPathHash = 0;
  let totalPathLength = 0;
  for (const path of materializedPaths) {
    totalPathLength += path.length;
    let pathHash = Math.imul(2_166_136_261 ^ path.length, 16_777_619);
    for (let index = 0; index < path.length; index += 1) {
      pathHash = Math.imul(pathHash ^ path.charCodeAt(index), 16_777_619);
    }
    combinedPathHash = (combinedPathHash + (pathHash >>> 0)) >>> 0;
  }
  return {
    key: `${materializedPaths.size}:${totalPathLength}:${combinedPathHash}`,
    totalPathLength,
  };
}

function areMaterializedPathSetsEqual(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>
): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const path of left) {
    if (!right.has(path)) {
      return false;
    }
  }
  return true;
}

function estimateMaterializedProjectionWeight(
  materializedPaths: ReadonlySet<string>,
  totalPathLength: number,
  counts: ReadonlyMap<string, number>
): number {
  let weight = (materializedPaths.size + counts.size) * CACHE_ENTRY_WEIGHT + totalPathLength;
  for (const directoryPath of counts.keys()) {
    weight += directoryPath.length;
  }
  return weight;
}

function rememberMaterializedStructuralProjection(
  signature: string,
  totalPathLength: number,
  materializedPaths: ReadonlySet<string>,
  counts: ReadonlyMap<string, number>
): void {
  const weight = estimateMaterializedProjectionWeight(materializedPaths, totalPathLength, counts);
  if (weight > materializedStructuralCacheMaxWeight) {
    return;
  }

  const collidingEntry = materializedStructuralCache.get(signature);
  if (collidingEntry) {
    materializedStructuralCache.delete(signature);
    materializedStructuralCacheWeight -= collidingEntry.weight;
  }

  while (
    materializedStructuralCache.size >= materializedStructuralCacheMaxEntries ||
    materializedStructuralCacheWeight + weight > materializedStructuralCacheMaxWeight
  ) {
    const oldestEntry = materializedStructuralCache.entries().next();
    if (oldestEntry.done) {
      break;
    }
    materializedStructuralCache.delete(oldestEntry.value[0]);
    materializedStructuralCacheWeight -= oldestEntry.value[1].weight;
  }

  materializedStructuralCache.set(signature, {
    counts,
    // Snapshot membership so collision verification never consults canonical
    // selection state or depends on a later caller mutation.
    materializedPaths: new Set(materializedPaths),
    weight,
  });
  materializedStructuralCacheWeight += weight;
}

function getMaterializedDirectoryCounts(
  materializedPaths: ReadonlySet<string> | null | undefined
): ReadonlyMap<string, number> | null {
  if (!(materializedPaths && materializedPaths.size > 0)) {
    return null;
  }

  const cached = materializedDirectoryCountCache.get(materializedPaths);
  if (cached) {
    return cached;
  }

  if (materializedStructuralCacheConsumers === 0) {
    const unownedCounts = buildMaterializedDirectoryCounts(materializedPaths);
    materializedDirectoryCountCache.set(materializedPaths, unownedCounts);
    return unownedCounts;
  }

  // Strong entries are owned by useSelectionResolver's unresolved-query
  // lifecycle. Unowned callers retain only their identity-keyed WeakMap entry.
  const minimumCountWeight = materializedPaths.size * CACHE_ENTRY_WEIGHT;
  if (minimumCountWeight > materializedStructuralCacheMaxWeight) {
    materializedStructuralPrecheckRejections += 1;
    const counts = buildMaterializedDirectoryCounts(materializedPaths);
    materializedDirectoryCountCache.set(materializedPaths, counts);
    return counts;
  }

  const signature = getMaterializedPathSetSignature(materializedPaths);
  const minimumRetainedWeight =
    materializedPaths.size * CACHE_ENTRY_WEIGHT + signature.totalPathLength;
  const isStructurallyCacheable = minimumRetainedWeight <= materializedStructuralCacheMaxWeight;
  if (!isStructurallyCacheable) {
    materializedStructuralPrecheckRejections += 1;
    const counts = buildMaterializedDirectoryCounts(materializedPaths);
    materializedDirectoryCountCache.set(materializedPaths, counts);
    return counts;
  }

  const structurallyCached = materializedStructuralCache.get(signature.key);
  if (
    structurallyCached &&
    areMaterializedPathSetsEqual(materializedPaths, structurallyCached.materializedPaths)
  ) {
    // Refresh insertion order so the bounded structural tier evicts least
    // recently used projections first.
    materializedStructuralCache.delete(signature.key);
    materializedStructuralCache.set(signature.key, structurallyCached);
    materializedDirectoryCountCache.set(materializedPaths, structurallyCached.counts);
    materializedStructuralCacheHits += 1;
    return structurallyCached.counts;
  }

  const counts = buildMaterializedDirectoryCounts(materializedPaths);
  materializedDirectoryCountCache.set(materializedPaths, counts);
  rememberMaterializedStructuralProjection(
    signature.key,
    signature.totalPathLength,
    materializedPaths,
    counts
  );
  return counts;
}

function clearSelectionProjectionStructuralCache(): void {
  materializedStructuralCache.clear();
  materializedStructuralCacheWeight = 0;
}

/**
 * Keeps the module-global structural tier alive while at least one unresolved
 * resolver needs hydration fallback. The idempotent release is safe for React
 * StrictMode's setup-cleanup-setup replay; only the last live consumer clears.
 */
export function acquireSelectionProjectionStructuralCache(): () => void {
  materializedStructuralCacheConsumers += 1;
  const generation = materializedStructuralCacheGeneration;
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    if (generation !== materializedStructuralCacheGeneration) {
      return;
    }
    materializedStructuralCacheConsumers -= 1;
    if (materializedStructuralCacheConsumers === 0) {
      clearSelectionProjectionStructuralCache();
    }
  };
}

export function __resetSelectionProjectionCachesForTests(limits?: {
  maxMaterializedStructuralEntries: number;
  maxMaterializedStructuralWeight: number;
}): void {
  descriptorMatcherCache = new WeakMap<SelectionQueryDescriptor, DescriptorMatchers>();
  materializedDirectoryCountCache = new WeakMap<ReadonlySet<string>, ReadonlyMap<string, number>>();
  clearSelectionProjectionStructuralCache();
  materializedStructuralCacheGeneration += 1;
  materializedStructuralCacheConsumers = 0;
  materializedStructuralCacheMaxEntries =
    limits?.maxMaterializedStructuralEntries ?? DEFAULT_MAX_MATERIALIZED_STRUCTURAL_CACHE_ENTRIES;
  materializedStructuralCacheMaxWeight =
    limits?.maxMaterializedStructuralWeight ?? DEFAULT_MAX_MATERIALIZED_STRUCTURAL_CACHE_WEIGHT;
  materializedDirectoryCountBuilds = 0;
  materializedStructuralCacheHits = 0;
  materializedStructuralPrecheckRejections = 0;
}

export function __getSelectionProjectionCacheStatsForTests(): {
  activeStructuralCacheConsumers: number;
  materializedDirectoryCountBuilds: number;
  materializedStructuralEntries: number;
  materializedStructuralHits: number;
  materializedStructuralPrecheckRejections: number;
  materializedStructuralWeight: number;
  maxMaterializedStructuralEntries: number;
  maxMaterializedStructuralWeight: number;
} {
  return {
    activeStructuralCacheConsumers: materializedStructuralCacheConsumers,
    materializedDirectoryCountBuilds,
    materializedStructuralEntries: materializedStructuralCache.size,
    materializedStructuralHits: materializedStructuralCacheHits,
    materializedStructuralPrecheckRejections,
    materializedStructuralWeight: materializedStructuralCacheWeight,
    maxMaterializedStructuralEntries: materializedStructuralCacheMaxEntries,
    maxMaterializedStructuralWeight: materializedStructuralCacheMaxWeight,
  };
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
  return selectedFilePaths.size;
}

export function materializeCompositeKeysForSelectionModel(params: {
  currentFolderId: string | null;
  querySelectionManifest?: QuerySelectionManifest | null;
  selectedFilePaths: Set<string>;
  selectionModel: SelectionModel;
}): Set<string> {
  const { currentFolderId, querySelectionManifest, selectedFilePaths, selectionModel } = params;

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
