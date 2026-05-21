import { useOptionalPGliteDatabase } from '@brainstrike/db';
import {
  buildQuerySelectionManifest,
  createErroredQuerySelectionManifest,
  createLoadingQuerySelectionManifest,
  resolveQuerySelection,
} from '@brainstrike/file-explorer';
import { encodeFileSelection } from '@brainstrike/utils/selection-utils';
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

function buildMaterializedFallbackPaths(args: {
  descriptor: NonNullable<SelectionResolverStoreState['selectionModel']['queryDescriptor']>;
  materializedPaths: Set<string> | null;
}): string[] {
  const { descriptor, materializedPaths } = args;
  if (!materializedPaths || materializedPaths.size === 0) {
    return EMPTY_RELATIVE_PATHS;
  }

  const nextPaths = new Set(materializedPaths);
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
    filePaths: Array.from(exactSelectedPaths),
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
    mode: 'explicit' | 'query' | 'rules';
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
    ruleSetJson: string | null;
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
    (!latestManifest ||
      latestManifest.status !== 'ready' ||
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
  status?: 'loading' | 'ready';
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
      (latestManifestStatus === 'ready' || latestManifestStatus === 'loading')
    ) {
      return;
    }

    if (!descriptor.manifestSnapshotId) {
      if (!latestManifest) {
        setManifest(
          buildQuerySelectionManifest({
            filePaths: [],
            fingerprint: descriptor.manifestFingerprint,
            snapshotId: null,
          })
        );
      }
      return;
    }

    if (!db) {
      ensureLoadingManifest({
        descriptor,
        latestManifest,
        setManifest,
      });
      return;
    }

    ensureLoadingManifest({
      descriptor,
      latestManifest,
      setManifest,
    });

    void loadQuerySelectionSnapshot(db, descriptor.manifestSnapshotId)
      .then((filePaths) => {
        if (token !== loadTokenRef.current) {
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
        if (token !== loadTokenRef.current) {
          return;
        }
        setManifest(
          createErroredQuerySelectionManifest({
            fingerprint: descriptor.manifestFingerprint,
            snapshotId: descriptor.manifestSnapshotId,
            errorMessage: error instanceof Error ? error.message : String(error),
          })
        );
      });

    return () => {
      loadTokenRef.current += 1;
    };
  }, [
    db,
    selectionModel.mode,
    selectionModel.queryDescriptor,
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

  const sortedMaterializedPaths = useMemo(() => {
    if (!(selectionModel.materializedPaths && selectionModel.materializedPaths.size > 0)) {
      return EMPTY_RELATIVE_PATHS;
    }
    return Array.from(selectionModel.materializedPaths).sort(defaultCollator.compare);
  }, [selectionModel.materializedPaths]);

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
    if (selectionModel.mode === 'rules') {
      return sortedMaterializedPaths;
    }
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
    sortedMaterializedPaths,
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
    if (selectionModel.mode === 'rules') {
      return effectiveRelativePaths.length;
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
