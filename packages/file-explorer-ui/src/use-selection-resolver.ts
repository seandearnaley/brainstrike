import { usePGliteDatabase } from '@brainstrike/db';
import {
  buildQuerySelectionManifest,
  createErroredQuerySelectionManifest,
  createLoadingQuerySelectionManifest,
  resolveQuerySelection,
} from '@brainstrike/file-explorer';
import { encodeFileSelection } from '@brainstrike/utils/selection-utils';
import { useEffect, useMemo } from 'react';
import {
  useFileExplorerStoreContext,
  useFileExplorerStoreSelector,
} from './file-explorer-provider';
import { loadQuerySelectionSnapshot } from './utils/query-selection-snapshot';

export interface SelectionResolverState {
  effectiveRelativePaths: string[];
  effectiveSelection: Set<string>;
  isQuerySelectionReady: boolean;
  selectedCount: number;
  selectedFilesList: string[];
}

export function useSelectionResolver(): SelectionResolverState {
  const db = usePGliteDatabase();
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
        ] as const
    );

  useEffect(() => {
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
      latestManifest &&
      latestManifest.fingerprint === descriptor.manifestFingerprint &&
      latestManifest.snapshotId === descriptor.manifestSnapshotId &&
      (latestManifest.status === 'ready' || latestManifest.status === 'loading')
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
      if (
        !(
          latestManifest &&
          latestManifest.fingerprint === descriptor.manifestFingerprint &&
          latestManifest.snapshotId === descriptor.manifestSnapshotId &&
          latestManifest.status === 'loading'
        )
      ) {
        setManifest(
          createLoadingQuerySelectionManifest({
            fingerprint: descriptor.manifestFingerprint,
            snapshotId: descriptor.manifestSnapshotId,
          })
        );
      }
      return;
    }

    let cancelled = false;
    setManifest(
      createLoadingQuerySelectionManifest({
        fingerprint: descriptor.manifestFingerprint,
        snapshotId: descriptor.manifestSnapshotId,
      })
    );

    void loadQuerySelectionSnapshot(db, descriptor.manifestSnapshotId)
      .then((filePaths) => {
        if (cancelled) {
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
        if (cancelled) {
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
      cancelled = true;
    };
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

  const effectiveRelativePaths = useMemo(() => {
    if (selectionModel.mode === 'rules') {
      return Array.from(selectionModel.materializedPaths ?? []).sort((left, right) =>
        left.localeCompare(right)
      );
    }
    if (selectionModel.mode === 'query') {
      return resolvedQuerySelection.filePaths;
    }
    return [];
  }, [resolvedQuerySelection.filePaths, selectionModel]);

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
    () => Array.from(effectiveSelection).sort((left, right) => left.localeCompare(right)),
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
    selectionModel,
  ]);

  return {
    effectiveRelativePaths,
    effectiveSelection,
    isQuerySelectionReady,
    selectedCount,
    selectedFilesList,
  };
}
