import { useBackgroundIndexingPreferencesStore } from '@brainstrike/app-state/stores/background-indexing-preferences-store';
import {
  type IndexingManagedCollectionStatsState,
  useIndexingActivityStore,
} from '@brainstrike/app-state/stores/indexing-activity-store';
import {
  useWorkspaceCollectionSyncStatusStore,
  type WorkspaceCollectionSyncStatusPatch,
} from '@brainstrike/app-state/stores/workspace-collection-sync-status-store';
import { usePGliteDatabase } from '@brainstrike/db/react';
import { useAdapters } from '@brainstrike/file-explorer-hooks';
import { useFileSystem } from '@brainstrike/file-explorer-ui/shell';
import type {
  IndexerCoverage,
  IndexSearchCapability,
} from '@brainstrike/indexing-contract/indexer-client';
import { type ReactNode, useEffect } from 'react';
import { RootIdentityProvider } from '../roots/root-identity-context';
import { useRootsReconciliation } from '../roots/use-roots-reconciliation';

async function readNativeProgress(
  capability: IndexSearchCapability,
  collectionId: string | null
): Promise<
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'ready'; readonly coverage: IndexerCoverage; readonly complete: boolean }
> {
  const status = await capability.status();
  if (status.kind === 'unavailable') {
    return status;
  }
  if (collectionId !== null && !status.authorizedCollectionIds?.includes(collectionId)) {
    return {
      kind: 'unavailable',
      reason: 'Native indexing is activating the selected collection.',
    };
  }
  const coverage = await capability.coverage({
    rootIds: status.authorizedRootIds,
    ...(collectionId === null ? {} : { collectionId }),
  });
  if (coverage.storeId !== status.storeId) {
    throw new Error('Native coverage changed stores during its status read.');
  }
  const complete =
    status.rootReadiness.every((root) => root.scanComplete) &&
    (collectionId === null ||
      status.collectionReadiness?.some(
        (scope) => scope.embeddingSetId === collectionId && scope.scanComplete
      ) === true);
  return { complete, coverage, kind: 'ready' };
}

function publishNativeProgress(
  coverage: IndexerCoverage,
  complete: boolean,
  collectionId: string | null,
  mode: 'TEXT' | 'VECTOR'
): void {
  const status: WorkspaceCollectionSyncStatusPatch = {
    backfillRequestId: null,
    lastError: null,
    managedCollectionId: collectionId,
    processedFiles: coverage.totals.indexedFiles,
    queuedFiles: 0,
    queueProgress: null,
    state: complete ? 'idle' : 'scanning',
  };
  const counts =
    collectionId === null
      ? undefined
      : coverage.collections?.find((row) => row.embeddingSetId === collectionId);
  if (collectionId !== null && !counts) {
    throw new Error('Native coverage omitted the selected collection.');
  }
  const stats: IndexingManagedCollectionStatsState = {
    collectionId,
    error: null,
    stats:
      counts && collectionId !== null
        ? {
            chunkCount: counts.chunks,
            dirty: !complete,
            embeddedChunkCount: counts.vectors,
            embeddingSetId: collectionId,
            fileCount: counts.indexedFiles,
            lastRefreshedAt: new Date().toISOString(),
            pendingChunkCount: mode === 'TEXT' ? 0 : counts.missingVectors,
          }
        : null,
    status: complete ? 'ready' : 'pending',
  };
  useWorkspaceCollectionSyncStatusStore.getState().setStatus(status);
  useIndexingActivityStore.getState().setManagedCollectionStats(stats);
}

function nativeProgressError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Visible UI observes the main-owned producer; closing this view never retires ingestion. */
export function NativeWorkspaceIndexProvider({
  children,
  capability,
}: {
  readonly children: ReactNode;
  readonly capability: IndexSearchCapability;
}) {
  const { fileSystemAdapter } = useAdapters();
  const db = usePGliteDatabase();
  const { rootDirectoryHandles } = useFileSystem();
  const { dbRootIdByAdapterRootId, registerRoot } = useRootsReconciliation({
    adapter: fileSystemAdapter,
    db,
  });
  useEffect(() => {
    let disposed = false;
    void fileSystemAdapter
      .restoreRoots?.()
      .then(async (roots) => {
        for (const root of roots) {
          if (disposed) {
            return;
          }
          await registerRoot(root);
        }
      })
      .catch((error: unknown) =>
        useWorkspaceCollectionSyncStatusStore.getState().setStatus({
          lastError: nativeProgressError(error),
          state: 'error',
        })
      );
    return () => {
      disposed = true;
    };
  }, [fileSystemAdapter, registerRoot, rootDirectoryHandles]);
  const enabled = useBackgroundIndexingPreferencesStore((state) => state.enabled);
  const paused = useBackgroundIndexingPreferencesStore((state) => state.paused);
  const mode = useBackgroundIndexingPreferencesStore((state) => state.nativeIndexMode);
  const collectionId = useBackgroundIndexingPreferencesStore((state) => state.managedCollectionId);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const publish = useWorkspaceCollectionSyncStatusStore.getState().setStatus;
    if (!enabled || paused || mode === null) {
      publish({
        lastError: null,
        managedCollectionId: collectionId,
        state: enabled ? (paused ? 'paused' : 'unconfigured') : 'disabled',
      });
      return;
    }
    const refresh = async (): Promise<void> => {
      try {
        const progress = await readNativeProgress(capability, collectionId);
        if (disposed) {
          return;
        }
        if (progress.kind === 'unavailable') {
          publish({
            lastError: progress.reason,
            managedCollectionId: collectionId,
            state: 'unconfigured',
          });
          return;
        }
        publishNativeProgress(progress.coverage, progress.complete, collectionId, mode);
      } catch (error) {
        if (!disposed) {
          publish({
            lastError: nativeProgressError(error),
            state: 'error',
          });
        }
      } finally {
        if (!disposed) {
          timer = setTimeout(() => {
            void refresh();
          }, 2000);
        }
      }
    };
    void refresh();
    return () => {
      disposed = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, [capability, collectionId, enabled, mode, paused]);
  return (
    <RootIdentityProvider dbRootIdByAdapterRootId={dbRootIdByAdapterRootId}>
      {children}
    </RootIdentityProvider>
  );
}
