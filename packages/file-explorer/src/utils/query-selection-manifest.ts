import type { QuerySelectionManifest, SelectionQueryDescriptor } from '@brainstrike/types';
import { defaultCollator } from '@brainstrike/utils/collator';

export interface ResolvedQuerySelection {
  directoryCounts: Map<string, number>;
  filePaths: string[];
  pathSet: Set<string>;
  selectedCount: number;
}

const resolvedSelectionCache = new WeakMap<
  QuerySelectionManifest,
  WeakMap<SelectionQueryDescriptor, ResolvedQuerySelection>
>();

function incrementDirectoryCounts(
  directoryCounts: Map<string, number>,
  filePath: string,
  delta: number
): void {
  let separatorIndex = filePath.lastIndexOf('/');
  while (separatorIndex >= 0) {
    const directoryPath = separatorIndex === 0 ? '/' : filePath.slice(0, separatorIndex);
    const nextCount = (directoryCounts.get(directoryPath) ?? 0) + delta;
    if (nextCount <= 0) {
      directoryCounts.delete(directoryPath);
    } else {
      directoryCounts.set(directoryPath, nextCount);
    }
    if (separatorIndex === 0) {
      break;
    }
    separatorIndex = filePath.lastIndexOf('/', separatorIndex - 1);
  }
}

function normalizeAndSortPaths(filePaths: readonly string[]): string[] {
  return Array.from(new Set(filePaths)).sort(defaultCollator.compare);
}

export function buildQuerySelectionFingerprint(args: {
  excludeFilters: readonly string[];
  folderId: string;
  includeFilters: readonly string[];
  kind: SelectionQueryDescriptor['kind'];
  rootPath: string | null;
  useRegex: boolean;
}): string {
  // Keep this field list explicit so any new selection semantics must be
  // intentionally considered for fingerprint compatibility.
  return JSON.stringify({
    excludeFilters: [...args.excludeFilters].sort(defaultCollator.compare),
    folderId: args.folderId,
    includeFilters: [...args.includeFilters].sort(defaultCollator.compare),
    kind: args.kind,
    rootPath: args.rootPath,
    useRegex: args.useRegex,
  });
}

export function buildQuerySelectionManifest(args: {
  filePaths: readonly string[];
  fingerprint: string | null;
  snapshotId: string | null;
  status?: QuerySelectionManifest['status'];
}): QuerySelectionManifest {
  const normalizedPaths = normalizeAndSortPaths(args.filePaths);
  const directoryCounts = new Map<string, number>();

  for (const filePath of normalizedPaths) {
    incrementDirectoryCounts(directoryCounts, filePath, 1);
  }

  return {
    filePaths: normalizedPaths,
    pathSet: new Set(normalizedPaths),
    directoryCounts,
    fingerprint: args.fingerprint,
    snapshotId: args.snapshotId,
    status: args.status ?? 'ready',
    errorMessage: null,
  };
}

export function createLoadingQuerySelectionManifest(args: {
  fingerprint: string | null;
  snapshotId: string | null;
}): QuerySelectionManifest {
  return {
    filePaths: [],
    pathSet: new Set<string>(),
    directoryCounts: new Map<string, number>(),
    fingerprint: args.fingerprint,
    snapshotId: args.snapshotId,
    status: 'loading',
    errorMessage: null,
  };
}

export function createErroredQuerySelectionManifest(args: {
  errorMessage: string;
  fingerprint: string | null;
  snapshotId: string | null;
}): QuerySelectionManifest {
  return {
    filePaths: [],
    pathSet: new Set<string>(),
    directoryCounts: new Map<string, number>(),
    fingerprint: args.fingerprint,
    snapshotId: args.snapshotId,
    status: 'error',
    errorMessage: args.errorMessage,
  };
}

function buildResolvedQuerySelection(
  descriptor: SelectionQueryDescriptor,
  manifest: QuerySelectionManifest
): ResolvedQuerySelection {
  const includedPaths = new Set(descriptor.includedPaths);
  const excludedPaths = new Set(descriptor.excludedPaths);
  const filePaths: string[] = [];
  const pathSet = new Set<string>();
  const directoryCounts = new Map(manifest.directoryCounts);

  for (const filePath of manifest.filePaths) {
    if (excludedPaths.has(filePath)) {
      incrementDirectoryCounts(directoryCounts, filePath, -1);
      continue;
    }
    filePaths.push(filePath);
    pathSet.add(filePath);
  }

  for (const filePath of includedPaths) {
    if (pathSet.has(filePath)) {
      continue;
    }
    filePaths.push(filePath);
    pathSet.add(filePath);
    incrementDirectoryCounts(directoryCounts, filePath, 1);
  }

  filePaths.sort(defaultCollator.compare);

  return {
    filePaths,
    pathSet,
    directoryCounts,
    selectedCount: filePaths.length,
  };
}

export function resolveQuerySelection(
  descriptor: SelectionQueryDescriptor | null,
  manifest: QuerySelectionManifest | null
): ResolvedQuerySelection {
  if (!descriptor) {
    return {
      filePaths: [],
      pathSet: new Set<string>(),
      directoryCounts: new Map<string, number>(),
      selectedCount: 0,
    };
  }

  if (
    !manifest ||
    manifest.status !== 'ready' ||
    manifest.fingerprint !== descriptor.manifestFingerprint ||
    manifest.snapshotId !== descriptor.manifestSnapshotId
  ) {
    const includedFilePaths = normalizeAndSortPaths(descriptor.includedPaths);
    const directoryCounts = new Map<string, number>();
    for (const filePath of includedFilePaths) {
      incrementDirectoryCounts(directoryCounts, filePath, 1);
    }
    return {
      filePaths: includedFilePaths,
      pathSet: new Set(includedFilePaths),
      directoryCounts,
      selectedCount: descriptor.totalSelectedCount,
    };
  }

  let cachedByDescriptor = resolvedSelectionCache.get(manifest);
  if (!cachedByDescriptor) {
    cachedByDescriptor = new WeakMap<SelectionQueryDescriptor, ResolvedQuerySelection>();
    resolvedSelectionCache.set(manifest, cachedByDescriptor);
  }

  const cached = cachedByDescriptor.get(descriptor);
  if (cached) {
    return cached;
  }

  const resolved = buildResolvedQuerySelection(descriptor, manifest);
  cachedByDescriptor.set(descriptor, resolved);
  return resolved;
}
