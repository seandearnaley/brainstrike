import {
  buildQuerySelectionManifest,
  createLoadingQuerySelectionManifest,
  resolveQuerySelection,
} from '@brainstrike/file-explorer';
import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import { useEffect, useMemo, useRef } from 'react';
import { shallow } from 'zustand/shallow';
import {
  useFileExplorerStoreContext,
  useFileExplorerStoreSelector,
} from './shell/file-explorer-provider';
import { defaultCollator } from './utils/file-node-collator';
import { acquireSelectionProjectionStructuralCache } from './utils/selection-projection';

export interface SelectionResolverState {
  effectiveRelativePaths: string[];
  effectiveSelection: Set<string>;
  isQuerySelectionReady: boolean;
  selectedCount: number;
  selectedFilesList: string[];
}

const EMPTY_RELATIVE_PATHS: string[] = [];
export const QUERY_SELECTION_LOADING_PROMOTION_MS = 100;

function buildMaterializedFallbackPaths(args: {
  excludedPaths: readonly string[];
  includedPaths: readonly string[];
  materializedPaths: Set<string> | null;
}): string[] {
  const { excludedPaths, includedPaths, materializedPaths } = args;
  const nextPaths = new Set(materializedPaths ?? []);
  for (const excludedPath of excludedPaths) {
    nextPaths.delete(excludedPath);
  }
  for (const includedPath of includedPaths) {
    nextPaths.add(includedPath);
  }

  if (nextPaths.size === 0) {
    return EMPTY_RELATIVE_PATHS;
  }

  return Array.from(nextPaths).sort(defaultCollator.compare);
}

function buildMaterializedBasePaths(materializedPaths: Set<string> | null): string[] {
  if (!materializedPaths || materializedPaths.size === 0) {
    return EMPTY_RELATIVE_PATHS;
  }
  return Array.from(materializedPaths);
}

function buildExactMaterializedManifest(args: {
  descriptor: NonNullable<SelectionResolverStoreState['selectionModel']['queryDescriptor']>;
  materializedPaths: Set<string> | null;
}) {
  const { descriptor, materializedPaths } = args;
  if (!materializedPaths) {
    return null;
  }

  if (descriptor.excludedPaths.length > 0) {
    return null;
  }

  const exactSelectedPaths = new Set<string>(materializedPaths);
  for (const includedPath of descriptor.includedPaths) {
    exactSelectedPaths.add(includedPath);
  }

  if (exactSelectedPaths.size !== descriptor.totalSelectedCount) {
    return null;
  }

  return buildQuerySelectionManifest({
    filePaths: buildMaterializedBasePaths(materializedPaths),
    fingerprint: descriptor.manifestFingerprint,
    snapshotId: descriptor.manifestSnapshotId,
  });
}

interface SelectionResolverStoreState {
  currentFolderId: string | null;
  querySelectionManifest: ReturnType<typeof createLoadingQuerySelectionManifest> | null;
  selectedFilePaths: Set<string>;
  selectionModel: {
    explicitPaths: Set<string>;
    materializedAt: string | null;
    materializedPaths: Set<string> | null;
    mode: 'explicit' | 'query';
    queryDescriptor: {
      coveredDirectoryPaths: string[];
      excludeFilters: string[];
      excludedPaths: string[];
      folderId: string;
      includedPaths: string[];
      includeFilters: string[];
      kind: 'recursive-folder' | 'recursive-select-all';
      manifestFingerprint: string | null;
      manifestSnapshotId: string | null;
      rootPath: string | null;
      totalSelectedCount: number;
      useRegex: boolean;
    } | null;
  };
  setQuerySelectionManifest: (
    manifest: ReturnType<typeof buildQuerySelectionManifest> | null
  ) => void;
}

interface LoadingPromotionStart {
  fingerprint: string | null;
  snapshotId: string;
  startedAt: number;
}

function getLoadingPromotionDelay(args: {
  fingerprint: string | null;
  startRef: { current: LoadingPromotionStart | null };
  snapshotId: string;
}): number {
  const { fingerprint, snapshotId, startRef } = args;
  if (startRef.current?.fingerprint !== fingerprint || startRef.current.snapshotId !== snapshotId) {
    startRef.current = { fingerprint, snapshotId, startedAt: Date.now() };
  }
  return Math.max(
    0,
    QUERY_SELECTION_LOADING_PROMOTION_MS - (Date.now() - startRef.current.startedAt)
  );
}

function resolveImmediateQueryManifest(args: {
  descriptor: NonNullable<SelectionResolverStoreState['selectionModel']['queryDescriptor']>;
  latestManifest: SelectionResolverStoreState['querySelectionManifest'];
  materializedPaths: Set<string> | null;
  setManifest: SelectionResolverStoreState['setQuerySelectionManifest'];
}): boolean {
  const { descriptor, latestManifest, materializedPaths, setManifest } = args;
  const exactMaterializedManifest = buildExactMaterializedManifest({
    descriptor,
    materializedPaths,
  });

  if (
    exactMaterializedManifest &&
    (latestManifest?.status !== 'ready' ||
      latestManifest.fingerprint !== descriptor.manifestFingerprint ||
      latestManifest.snapshotId !== descriptor.manifestSnapshotId)
  ) {
    setManifest(exactMaterializedManifest);
    return true;
  }

  return false;
}

function matchesDescriptorManifest(args: {
  descriptor: NonNullable<SelectionResolverStoreState['selectionModel']['queryDescriptor']>;
  manifest: SelectionResolverStoreState['querySelectionManifest'];
  status?: 'error' | 'loading' | 'ready';
}): boolean {
  const { descriptor, manifest, status } = args;
  if (!manifest) {
    return false;
  }

  if (
    manifest.fingerprint !== descriptor.manifestFingerprint ||
    manifest.snapshotId !== descriptor.manifestSnapshotId
  ) {
    return false;
  }

  return status ? manifest.status === status : true;
}

function canReuseSnapshotManifest(args: {
  descriptor: NonNullable<SelectionResolverStoreState['selectionModel']['queryDescriptor']>;
  manifest: SelectionResolverStoreState['querySelectionManifest'];
}): boolean {
  const { descriptor, manifest } = args;
  if (!matchesDescriptorManifest({ descriptor, manifest })) {
    return false;
  }
  return manifest?.status === 'ready' || manifest?.status === 'loading';
}

function isCurrentQueryDescriptor(
  state: SelectionResolverStoreState,
  descriptor: NonNullable<SelectionResolverStoreState['selectionModel']['queryDescriptor']>
): boolean {
  const currentDescriptor = state.selectionModel.queryDescriptor;
  return (
    state.selectionModel.mode === 'query' &&
    currentDescriptor?.manifestFingerprint === descriptor.manifestFingerprint &&
    currentDescriptor.manifestSnapshotId === descriptor.manifestSnapshotId
  );
}

function ensureLoadingManifest(args: {
  descriptor: NonNullable<SelectionResolverStoreState['selectionModel']['queryDescriptor']>;
  latestManifest: SelectionResolverStoreState['querySelectionManifest'];
  setManifest: SelectionResolverStoreState['setQuerySelectionManifest'];
}): void {
  const { descriptor, latestManifest, setManifest } = args;
  if (
    matchesDescriptorManifest({
      descriptor,
      manifest: latestManifest,
      status: 'loading',
    })
  ) {
    return;
  }

  setManifest(
    createLoadingQuerySelectionManifest({
      fingerprint: descriptor.manifestFingerprint,
      snapshotId: descriptor.manifestSnapshotId,
    })
  );
}

export function useSelectionResolver(): SelectionResolverState {
  const store = useFileExplorerStoreContext();
  const [selectedFilePaths, selectionModel, currentFolderId, querySelectionManifest, setManifest] =
    useFileExplorerStoreSelector(
      (state) =>
        [
          state.selectedFilePaths,
          state.selectionModel,
          state.currentFolderId,
          state.querySelectionManifest,
          state.setQuerySelectionManifest,
        ] as const,
      shallow
    );
  const loadTokenRef = useRef(0);
  const loadingPromotionStartRef = useRef<LoadingPromotionStart | null>(null);
  const isQueryManifestInvalidated = querySelectionManifest === null;

  useEffect(() => {
    loadTokenRef.current += 1;
    const token = loadTokenRef.current;
    const latestState = store.getState();
    if (latestState.selectionModel.mode !== 'query') {
      loadingPromotionStartRef.current = null;
      return;
    }

    const descriptor = latestState.selectionModel.queryDescriptor;
    if (!descriptor) {
      loadingPromotionStartRef.current = null;
      return;
    }

    const snapshotId = descriptor.manifestSnapshotId;

    const latestManifest = latestState.querySelectionManifest;
    if (
      resolveImmediateQueryManifest({
        descriptor,
        latestManifest,
        materializedPaths: latestState.selectionModel.materializedPaths,
        setManifest,
      })
    ) {
      loadingPromotionStartRef.current = null;
      return;
    }

    const latestManifestStatus = latestManifest?.status;
    if (canReuseSnapshotManifest({ descriptor, manifest: latestManifest })) {
      if (latestManifestStatus === 'ready') {
        loadingPromotionStartRef.current = null;
      }
      return;
    }

    if (!snapshotId) {
      loadingPromotionStartRef.current = null;
      setManifest(
        buildQuerySelectionManifest({
          filePaths: buildMaterializedBasePaths(latestState.selectionModel.materializedPaths),
          fingerprint: descriptor.manifestFingerprint,
          snapshotId: null,
        })
      );
      return;
    }

    const loadingPromotionDelay = getLoadingPromotionDelay({
      fingerprint: descriptor.manifestFingerprint,
      snapshotId,
      startRef: loadingPromotionStartRef,
    });

    const loadingPromotionTimer = setTimeout(() => {
      if (token !== loadTokenRef.current) {
        return;
      }
      const currentState = store.getState();
      if (!isCurrentQueryDescriptor(currentState, descriptor)) {
        return;
      }

      const currentManifest = currentState.querySelectionManifest;
      if (
        matchesDescriptorManifest({
          descriptor,
          manifest: currentManifest,
        }) &&
        (currentManifest?.status === 'loading' || currentManifest?.status === 'ready')
      ) {
        return;
      }

      ensureLoadingManifest({
        descriptor,
        latestManifest: currentManifest,
        setManifest,
      });
    }, loadingPromotionDelay);
    const cancelPendingLoad = () => {
      clearTimeout(loadingPromotionTimer);
      loadTokenRef.current += 1;
    };

    return cancelPendingLoad;
  }, [
    // Folder hydration can clear a ready manifest while preserving descriptor
    // identity. Track only null/non-null invalidation so ready/loading/error
    // publications do not re-arm reads or recreate the old publish loop.
    // `setQuerySelection` also publishes materializedPaths and its fresh
    // manifest atomically; if that contract changes, add a materialization
    // revision dependency here rather than restoring descriptor object identity.
    isQueryManifestInvalidated,
    selectionModel.mode,
    selectionModel.queryDescriptor?.manifestFingerprint,
    selectionModel.queryDescriptor?.manifestSnapshotId,
    setManifest,
    store,
  ]);

  const resolvedQuerySelection = useMemo(
    () => resolveQuerySelection(selectionModel.queryDescriptor, querySelectionManifest),
    [querySelectionManifest, selectionModel.queryDescriptor]
  );

  const isQuerySelectionReady =
    selectionModel.mode !== 'query' ||
    !selectionModel.queryDescriptor ||
    Boolean(
      querySelectionManifest &&
        querySelectionManifest.status === 'ready' &&
        querySelectionManifest.fingerprint === selectionModel.queryDescriptor.manifestFingerprint &&
        querySelectionManifest.snapshotId === selectionModel.queryDescriptor.manifestSnapshotId
    );

  const ownsSelectionProjectionCache =
    selectionModel.mode === 'query' &&
    Boolean(selectionModel.queryDescriptor) &&
    !isQuerySelectionReady;
  useEffect(() => {
    if (!ownsSelectionProjectionCache) {
      return;
    }
    return acquireSelectionProjectionStructuralCache();
  }, [ownsSelectionProjectionCache]);

  // Reads only the descriptor's path lists, so an unrelated descriptor change keeps the result.
  const excludedPaths = selectionModel.queryDescriptor?.excludedPaths;
  const includedPaths = selectionModel.queryDescriptor?.includedPaths;
  const queryMaterializedFallbackPaths = useMemo(() => {
    if (!(selectionModel.mode === 'query' && excludedPaths && includedPaths)) {
      return EMPTY_RELATIVE_PATHS;
    }

    return buildMaterializedFallbackPaths({
      excludedPaths,
      includedPaths,
      materializedPaths: selectionModel.materializedPaths,
    });
  }, [excludedPaths, includedPaths, selectionModel.materializedPaths, selectionModel.mode]);

  const effectiveRelativePaths = useMemo(() => {
    if (selectionModel.mode === 'query') {
      if (!isQuerySelectionReady && queryMaterializedFallbackPaths.length > 0) {
        return queryMaterializedFallbackPaths;
      }
      return resolvedQuerySelection.filePaths;
    }
    return EMPTY_RELATIVE_PATHS;
  }, [
    isQuerySelectionReady,
    queryMaterializedFallbackPaths,
    resolvedQuerySelection.filePaths,
    selectionModel.mode,
  ]);

  const effectiveSelection = useMemo(() => {
    if (selectionModel.mode === 'explicit' || !currentFolderId) {
      return selectedFilePaths;
    }

    const compositeKeys = new Set<string>();
    for (const relativePath of effectiveRelativePaths) {
      compositeKeys.add(encodeFileSelection(currentFolderId, relativePath));
    }
    return compositeKeys;
  }, [currentFolderId, effectiveRelativePaths, selectedFilePaths, selectionModel.mode]);

  const selectedFilesList = useMemo(
    () => Array.from(effectiveSelection).sort(defaultCollator.compare),
    [effectiveSelection]
  );

  const selectedCount = useMemo(() => {
    if (selectionModel.mode === 'query' && selectionModel.queryDescriptor) {
      return resolvedQuerySelection.selectedCount;
    }
    return selectedFilePaths.size;
  }, [
    resolvedQuerySelection.selectedCount,
    selectedFilePaths.size,
    selectionModel.mode,
    selectionModel.queryDescriptor,
  ]);

  return {
    effectiveRelativePaths,
    effectiveSelection,
    isQuerySelectionReady,
    selectedCount,
    selectedFilesList,
  };
}
