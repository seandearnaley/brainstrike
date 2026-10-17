import { useBackgroundIndexingPreferencesStore } from '@brainstrike/app-state/stores/background-indexing-preferences-store';
import {
  type IndexingManagedCollectionStatsState,
  useIndexingActivityStore,
} from '@brainstrike/app-state/stores/indexing-activity-store';
import {
  useWorkspaceCollectionSyncStatusStore,
  type WorkspaceCollectionSyncBlockedReason,
  type WorkspaceCollectionSyncStatusPatch,
} from '@brainstrike/app-state/stores/workspace-collection-sync-status-store';
import {
  BoundaryFailureError,
  describeBoundaryFailure,
} from '@brainstrike/assistant-contract/boundary-failure';
import { useAdapters } from '@brainstrike/file-explorer-hooks';
import { useFileSystem } from '@brainstrike/file-explorer-ui/shell';
import type {
  IndexerCoverage,
  IndexerStatus,
  IndexSearchCapability,
  NativeIndexRefusalCause,
} from '@brainstrike/indexing-contract/indexer-client';
import { type ReactNode, useEffect, useRef } from 'react';
import { RootIdentityProvider } from '../roots/root-identity-context';
import { useRootsReconciliation } from '../roots/use-roots-reconciliation';

async function readNativeProgress(
  capability: IndexSearchCapability,
  collectionId: string | null
): Promise<
  | Extract<IndexerStatus, { kind: 'unavailable' }>
  | { readonly kind: 'invalidated'; readonly identity: string }
  | {
      readonly kind: 'ready';
      readonly coverage: IndexerCoverage;
      readonly complete: boolean;
      readonly identity: string;
      readonly status: Extract<IndexerStatus, { kind: 'ready' }>;
    }
> {
  const status = await capability.status();
  if (status.kind === 'unavailable') {
    return status;
  }
  if (collectionId !== null && !status.authorizedCollectionIds?.includes(collectionId)) {
    return {
      kind: 'unavailable',
      phase: 'preparing',
      reason: 'Native indexing is activating the selected collection.',
    };
  }
  // Text search with no collection and no folder has nothing to cover: the
  // index is ready and empty. The native capability refuses an empty scope, so
  // there is nothing to ask (BST-1988).
  if (collectionId === null && status.authorizedRootIds.length === 0) {
    return {
      complete: true,
      coverage: {
        embedding: status.embedding,
        roots: [],
        storeId: status.storeId,
        totals: { chunks: 0, indexedFiles: 0, missingVectors: 0, vectors: 0 },
        vectorCoverageComplete: true,
      },
      identity: progressIdentity(status, collectionId),
      kind: 'ready',
      status,
    };
  }
  const observation = await capability.coverageBatch([
    {
      rootIds: status.authorizedRootIds,
      ...(collectionId === null ? {} : { collectionId }),
    },
  ]);
  if (observation.kind === 'blocked') {
    return {
      ...(observation.cause ? { cause: observation.cause } : {}),
      kind: 'unavailable',
      phase: 'blocked',
      reason: observation.reason,
    };
  }
  if (observation.kind === 'invalidated') {
    return { identity: progressIdentity(status, collectionId), kind: 'invalidated' };
  }
  const coverage = observation.coverage[0];
  if (
    observation.coverage.length !== 1 ||
    !coverage ||
    coverage.storeId !== observation.status.storeId
  ) {
    throw new Error('Native coverage batch returned inconsistent progress.');
  }
  const current = observation.status;
  const complete =
    current.rootReadiness.every((root) => root.scanComplete) &&
    (collectionId === null ||
      current.collectionReadiness?.some(
        (scope) => scope.embeddingSetId === collectionId && scope.scanComplete
      ) === true);
  return {
    complete,
    coverage,
    identity: progressIdentity(current, collectionId),
    kind: 'ready',
    status: current,
  };
}

function progressIdentity(
  status: Extract<IndexerStatus, { kind: 'ready' }>,
  collectionId: string | null
): string {
  const profile =
    status.embedding.indexMode === 'vector-configured' ? status.embedding.profileHash : null;
  return JSON.stringify([
    status.storeId,
    [...status.authorizedRootIds].sort(),
    collectionId,
    status.embedding.indexMode,
    profile,
  ]);
}

function resetNativeProgress(collectionId: string | null): void {
  useIndexingActivityStore
    .getState()
    .setManagedCollectionStats({ collectionId, error: null, stats: null, status: 'loading' });
  useWorkspaceCollectionSyncStatusStore.getState().setStatus({
    activeRootPath: null,
    blockedReason: null,
    currentFilePath: null,
    lastError: null,
    managedCollectionId: collectionId,
    processedFiles: 0,
    state: 'waiting',
  });
}

function publishPreparingProgress(): void {
  const current = useWorkspaceCollectionSyncStatusStore.getState();
  if (current.state === 'error' || current.state === 'blocked' || current.state === 'scanning') {
    return;
  }
  current.setStatus({ lastError: null, state: 'waiting' });
}

function publishUnavailableProgress(
  progress: Extract<IndexerStatus, { kind: 'unavailable' }>,
  collectionId: string | null
): void {
  if (progress.phase === 'preparing') {
    publishPreparingProgress();
    return;
  }
  useWorkspaceCollectionSyncStatusStore.getState().setStatus({
    blockedReason: progress.phase === 'blocked' ? syncBlockedReason(progress.cause) : null,
    lastError: progress.reason,
    managedCollectionId: collectionId,
    state: progress.phase === 'blocked' ? 'blocked' : 'unconfigured',
  });
}

/**
 * The one mapping from the native owner's typed refusal to the sync store's blocked reason: only
 * a cause a person resolves from the status surface names one (BST-2104).
 */
function syncBlockedReason(
  cause: NativeIndexRefusalCause | undefined
): WorkspaceCollectionSyncBlockedReason | null {
  if (cause === undefined) {
    return null;
  }
  switch (cause.kind) {
    case 'embedding-host-unresponsive':
      return cause.kind;
    case 'closed':
    case 'rebuild-required':
    case 'settings-invalid':
    case 'setup-required':
    case 'source-failure':
    case 'transitioning':
      return null;
  }
}

interface RetainedProgress {
  readonly observation: string | null;
  readonly selection: string;
}

function reconcileProgressIdentity(
  holder: { current: RetainedProgress | null },
  selection: string,
  observation: string,
  collectionId: string | null
): void {
  if (holder.current?.observation === observation) {
    return;
  }
  resetNativeProgress(collectionId);
  holder.current = { observation, selection };
}

function nativeRootPath(
  status: Extract<IndexerStatus, { kind: 'ready' }>,
  roots: ReturnType<typeof useFileSystem>['rootDirectoryHandles'],
  dbRootIdByAdapterRootId: ReadonlyMap<string, string>
): string | null {
  const authorized = new Set(status.authorizedRootIds);
  const activeRoots = roots.filter(
    (root) => root.rootId && authorized.has(dbRootIdByAdapterRootId.get(root.rootId) ?? root.rootId)
  );
  return activeRoots.length === 1 ? (activeRoots[0]?.path ?? null) : null;
}

function publishNativeProgress(
  coverage: IndexerCoverage,
  complete: boolean,
  collectionId: string | null,
  mode: 'TEXT' | 'VECTOR',
  activeRootPath: string | null
): void {
  const status: WorkspaceCollectionSyncStatusPatch = {
    activeRootPath,
    backfillRequestId: null,
    blockedReason: null,
    lastError: null,
    managedCollectionId: collectionId,
    processedFiles: coverage.totals.indexedFiles,
    queuedFiles: 0,
    queueProgress: null,
    state: complete ? 'idle' : 'scanning',
  };
  // A collection counts its own scope; the TEXT partition (no collection) is its folders.
  const counts =
    collectionId === null
      ? coverage.totals
      : coverage.collections?.find((row) => row.embeddingSetId === collectionId);
  if (!counts) {
    throw new Error('Native coverage omitted the selected collection.');
  }
  const stats: IndexingManagedCollectionStatsState = {
    collectionId,
    error: null,
    stats: {
      chunkCount: counts.chunks,
      dirty: !complete,
      embeddedChunkCount: counts.vectors,
      embeddingSetId: collectionId,
      fileCount: counts.indexedFiles,
      lastRefreshedAt: new Date().toISOString(),
      pendingChunkCount: mode === 'TEXT' ? 0 : counts.missingVectors,
    },
    status: complete ? 'ready' : 'pending',
  };
  useWorkspaceCollectionSyncStatusStore.getState().setStatus(status);
  useIndexingActivityStore.getState().setManagedCollectionStats(stats);
}

function nativeProgressError(error: unknown): string {
  if (error instanceof BoundaryFailureError) {
    return describeBoundaryFailure(error.failure);
  }
  return error instanceof Error ? error.message : String(error);
}

function getNativeSetupMessage(
  mode: 'TEXT' | 'VECTOR' | null,
  collectionId: string | null
): string | null {
  if (mode === null) {
    return 'Choose a search mode in Search & Indexing settings.';
  }
  // Text search needs no model (BST-1988); only semantic search needs a collection.
  if (mode === 'VECTOR' && collectionId === null) {
    return 'Choose an embedding model and set up a collection in Search & Indexing settings.';
  }
  return null;
}

/** Visible UI observes the main-owned producer; closing this view never retires ingestion. */
export function NativeWorkspaceIndexProvider({
  children,
  capability,
}: {
  readonly children: ReactNode;
  readonly capability: IndexSearchCapability;
}) {
  const retained = useRef<RetainedProgress | null>(null);
  const { fileSystemAdapter } = useAdapters();
  const { rootDirectoryHandles } = useFileSystem();
  const { dbRootIdByAdapterRootId, syncMountedRoots } = useRootsReconciliation({
    adapter: fileSystemAdapter,
    db: null,
  });
  useEffect(() => {
    let disposed = false;
    void fileSystemAdapter
      .restoreRoots?.()
      // The mounted set as a whole: a removed folder is forgotten, so re-adding
      // it under its one id registers it again (BST-1990).
      .then((roots) => (disposed ? undefined : syncMountedRoots(roots)))
      .catch((error: unknown) =>
        useWorkspaceCollectionSyncStatusStore.getState().setStatus({
          lastError: nativeProgressError(error),
          state: 'error',
        })
      );
    return () => {
      disposed = true;
    };
  }, [fileSystemAdapter, syncMountedRoots, rootDirectoryHandles]);
  const enabled = useBackgroundIndexingPreferencesStore((state) => state.enabled);
  const paused = useBackgroundIndexingPreferencesStore((state) => state.paused);
  const mode = useBackgroundIndexingPreferencesStore((state) => state.nativeIndexMode);
  const selection = useBackgroundIndexingPreferencesStore((state) => state.nativeLocalSelection);
  const collectionId = useBackgroundIndexingPreferencesStore((state) => state.managedCollectionId);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const publish = useWorkspaceCollectionSyncStatusStore.getState().setStatus;
    const mountedRoots = rootDirectoryHandles
      .map((root) => [root.rootId ?? null, root.path])
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    const selectionIdentity = JSON.stringify([collectionId, mode, selection, mountedRoots]);
    if (retained.current?.selection !== selectionIdentity) {
      resetNativeProgress(collectionId);
      retained.current = { observation: null, selection: selectionIdentity };
    }
    const setupMessage = getNativeSetupMessage(mode, collectionId);
    if (!enabled || paused || mode === null || setupMessage !== null) {
      publish({
        blockedReason: null,
        lastError: enabled && !paused ? setupMessage : null,
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
          publishUnavailableProgress(progress, collectionId);
          return;
        }
        reconcileProgressIdentity(retained, selectionIdentity, progress.identity, collectionId);
        if (progress.kind === 'invalidated') {
          return;
        }
        publishNativeProgress(
          progress.coverage,
          progress.complete,
          collectionId,
          mode,
          nativeRootPath(progress.status, rootDirectoryHandles, dbRootIdByAdapterRootId)
        );
      } catch (error) {
        if (!disposed) {
          publish({
            blockedReason: null,
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
  }, [
    capability,
    collectionId,
    enabled,
    mode,
    paused,
    selection,
    rootDirectoryHandles,
    dbRootIdByAdapterRootId,
  ]);
  return (
    <RootIdentityProvider dbRootIdByAdapterRootId={dbRootIdByAdapterRootId}>
      {children}
    </RootIdentityProvider>
  );
}
