import { type DbHandle, useOptionalPGliteDatabase } from '@brainstrike/db/react';
import {
  buildQuerySelectionManifest,
  createErroredQuerySelectionManifest,
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
import { loadQuerySelectionSnapshot } from './utils/query-selection-snapshot';

export interface SelectionResolverState {
  effectiveRelativePaths: string[];
  effectiveSelection: Set<string>;
  isQuerySelectionReady: boolean;
  selectedCount: number;
  selectedFilesList: string[];
}

const EMPTY_RELATIVE_PATHS: string[] = [];
export const QUERY_SELECTION_LOADING_PROMOTION_MS = 100;
let inFlightSnapshotLoads = new WeakMap<DbHandle, Map<string, Promise<string[]>>>();

export function __resetSelectionResolverCachesForTests(): void {
  inFlightSnapshotLoads = new WeakMap<DbHandle, Map<string, Promise<string[]>>>();
}

function loadQuerySelectionSnapshotDeduped(db: DbHandle, snapshotId: string): Promise<string[]> {
  let loadsForDatabase = inFlightSnapshotLoads.get(db);
  if (!loadsForDatabase) {
    loadsForDatabase = new Map<string, Promise<string[]>>();
    inFlightSnapshotLoads.set(db, loadsForDatabase);
  }

  const existingLoad = loadsForDatabase.get(snapshotId);
  if (existingLoad) {
    return existingLoad;
  }

  const load = loadQuerySelectionSnapshot(db, snapshotId);
  loadsForDatabase.set(snapshotId, load);
  const removeSettledLoad = () => {
    if (loadsForDatabase.get(snapshotId) === load) {
      loadsForDatabase.delete(snapshotId);
    }
  };
  void load.then(removeSettledLoad, removeSettledLoad);
  return load;
}

function buildMaterializedFallbackPaths(args: {
  descriptor: NonNullable<SelectionResolverStoreState['selectionModel']['queryDescriptor']>;
  materializedPaths: Set<string> | null;
}): string[] {
  const { descriptor, materializedPaths } = args;
  const nextPaths = new Set(materializedPaths ?? []);
  for (const excludedPath of descriptor.excludedPaths) {
    nextPaths.delete(excludedPath);
  }
  for (const includedPath of descriptor.includedPaths) {
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
  return Array.from(materializedPaths).sort(defaultCollator.compare);
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
  const db = useOptionalPGliteDatabase();
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

  useEffect(() => {
    loadTokenRef.current += 1;
    const token = loadTokenRef.current;
    const latestState = store.getState();
    if (latestState.selectionModel.mode !== 'query') {
      return;
    }

    const descriptor = latestState.selectionModel.queryDescriptor;
    if (!descriptor) {
      return;
    }

    const latestManifest = latestState.querySelectionManifest;
    if (
      resolveImmediateQueryManifest({
        descriptor,
        latestManifest,
        materializedPaths: latestState.selectionModel.materializedPaths,
        setManifest,
      })
    ) {
      return;
    }

    const latestManifestStatus = latestManifest?.status;
    if (
      matchesDescriptorManifest({
        descriptor,
        manifest: latestManifest,
      }) &&
      (latestManifestStatus === 'ready' || (latestManifestStatus === 'loading' && !db))
    ) {
      return;
    }

    if (!descriptor.manifestSnapshotId) {
      setManifest(
        buildQuerySelectionManifest({
          filePaths: buildMaterializedBasePaths(latestState.selectionModel.materializedPaths),
          fingerprint: descriptor.manifestFingerprint,
          snapshotId: null,
        })
      );
      return;
    }

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
    }, QUERY_SELECTION_LOADING_PROMOTION_MS);
    const cancelPendingLoad = () => {
      clearTimeout(loadingPromotionTimer);
      loadTokenRef.current += 1;
    };

    if (!db) {
      return cancelPendingLoad;
    }

    void loadQuerySelectionSnapshotDeduped(db, descriptor.manifestSnapshotId)
      .then((filePaths) => {
        clearTimeout(loadingPromotionTimer);
        if (token !== loadTokenRef.current) {
          return;
        }
        const currentState = store.getState();
        if (
          !isCurrentQueryDescriptor(currentState, descriptor) ||
          matchesDescriptorManifest({
            descriptor,
            manifest: currentState.querySelectionManifest,
            status: 'ready',
          })
        ) {
          return;
        }
        setManifest(
          buildQuerySelectionManifest({
            filePaths,
            fingerprint: descriptor.manifestFingerprint,
            snapshotId: descriptor.manifestSnapshotId,
          })
        );
      })
      .catch((error: unknown) => {
        clearTimeout(loadingPromotionTimer);
        if (token !== loadTokenRef.current) {
          return;
        }
        const currentState = store.getState();
        const errorMessage = error instanceof Error ? error.message : String(error);
        const currentManifest = currentState.querySelectionManifest;
        if (
          !isCurrentQueryDescriptor(currentState, descriptor) ||
          matchesDescriptorManifest({
            descriptor,
            manifest: currentManifest,
            status: 'ready',
          }) ||
          (matchesDescriptorManifest({
            descriptor,
            manifest: currentManifest,
            status: 'error',
          }) &&
            currentManifest?.errorMessage === errorMessage)
        ) {
          return;
        }
        setManifest(
          createErroredQuerySelectionManifest({
            errorMessage,
            fingerprint: descriptor.manifestFingerprint,
            snapshotId: descriptor.manifestSnapshotId,
          })
        );
      });

    return cancelPendingLoad;
  }, [
    db,
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

  const queryMaterializedFallbackPaths = useMemo(() => {
    const descriptor = selectionModel.queryDescriptor;
    if (!(selectionModel.mode === 'query' && descriptor)) {
      return EMPTY_RELATIVE_PATHS;
    }

    return buildMaterializedFallbackPaths({
      descriptor,
      materializedPaths: selectionModel.materializedPaths,
    });
  }, [
    selectionModel.materializedPaths,
    selectionModel.mode,
    selectionModel.queryDescriptor?.includedPaths,
    selectionModel.queryDescriptor?.excludedPaths,
  ]);

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
    effectiveRelativePaths.length,
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
