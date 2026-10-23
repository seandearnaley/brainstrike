import {
  followIndexConfig,
  selectIndexConfig,
  useIndexConfigStore,
  useIndexModel,
} from '@brainstrike/app-state/stores/index-config-store';
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
import type { IndexConfigCapability } from '@brainstrike/assistant-contract/index-config';
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

async function readNativeProgress(capability: IndexSearchCapability): Promise<
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
  // No folder has nothing to cover: the index is ready and empty. The native
  // capability refuses an empty scope, so there is nothing to ask (BST-1988).
  if (status.authorizedRootIds.length === 0) {
    return {
      complete: true,
      coverage: {
        embedding: status.embedding,
        roots: [],
        storeId: status.storeId,
        totals: { chunks: 0, indexedFiles: 0, missingVectors: 0, vectors: 0 },
        vectorCoverageComplete: true,
      },
      identity: progressIdentity(status),
      kind: 'ready',
      status,
    };
  }
  // Root-scoped coverage counts the vectors of workspace files indexed under the vector space.
  const observation = await capability.coverageBatch([{ rootIds: status.authorizedRootIds }]);
  if (observation.kind === 'blocked') {
    return {
      ...(observation.cause ? { cause: observation.cause } : {}),
      kind: 'unavailable',
      phase: 'blocked',
      reason: observation.reason,
    };
  }
  if (observation.kind === 'invalidated') {
    return { identity: progressIdentity(status), kind: 'invalidated' };
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
  const complete = current.rootReadiness.every((root) => root.scanComplete);
  return {
    complete,
    coverage,
    identity: progressIdentity(current),
    kind: 'ready',
    status: current,
  };
}

function progressIdentity(status: Extract<IndexerStatus, { kind: 'ready' }>): string {
  const profile =
    status.embedding.indexMode === 'vector-configured' ? status.embedding.profileHash : null;
  return JSON.stringify([
    status.storeId,
    [...status.authorizedRootIds].sort(),
    status.embedding.indexMode,
    profile,
  ]);
}

function resetNativeProgress(): void {
  useIndexingActivityStore
    .getState()
    .setManagedCollectionStats({ collectionId: null, error: null, stats: null, status: 'loading' });
  useWorkspaceCollectionSyncStatusStore.getState().setStatus({
    activeRootPath: null,
    blockedReason: null,
    currentFilePath: null,
    lastError: null,
    managedCollectionId: null,
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
  progress: Extract<IndexerStatus, { kind: 'unavailable' }>
): void {
  if (progress.phase === 'preparing') {
    publishPreparingProgress();
    return;
  }
  useWorkspaceCollectionSyncStatusStore.getState().setStatus({
    blockedReason: progress.phase === 'blocked' ? syncBlockedReason(progress.cause) : null,
    lastError: progress.reason,
    managedCollectionId: null,
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
  observation: string
): void {
  if (holder.current?.observation === observation) {
    return;
  }
  resetNativeProgress();
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
  mode: 'TEXT' | 'VECTOR',
  activeRootPath: string | null
): void {
  const status: WorkspaceCollectionSyncStatusPatch = {
    activeRootPath,
    backfillRequestId: null,
    blockedReason: null,
    lastError: null,
    managedCollectionId: null,
    processedFiles: coverage.totals.indexedFiles,
    queuedFiles: 0,
    queueProgress: null,
    state: complete ? 'idle' : 'scanning',
  };
  const counts = coverage.totals;
  const stats: IndexingManagedCollectionStatsState = {
    collectionId: null,
    error: null,
    stats: {
      chunkCount: counts.chunks,
      dirty: !complete,
      embeddedChunkCount: counts.vectors,
      embeddingSetId: null,
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

/**
 * Main's lifecycle owner refuses with `native-index-closed` or `native-index-transitioning` while
 * an owner (a reset, a newer generation) replaces the index: it is preparing, as its status says.
 * Every other failure, typed or not, is the sync surface's error.
 */
function publishNativeFailure(error: unknown): void {
  if (
    error instanceof BoundaryFailureError &&
    error.failure.kind === 'refusal' &&
    (error.failure.code === 'native-index-closed' ||
      error.failure.code === 'native-index-transitioning')
  ) {
    publishPreparingProgress();
    return;
  }
  useWorkspaceCollectionSyncStatusStore.getState().setStatus({
    blockedReason: null,
    lastError: nativeProgressError(error),
    state: 'error',
  });
}

/** Visible UI observes the main-owned producer; closing this view never retires ingestion. */
export function NativeWorkspaceIndexProvider({
  children,
  capability,
}: {
  readonly children: ReactNode;
  readonly capability: IndexSearchCapability & IndexConfigCapability;
}) {
  const retained = useRef<RetainedProgress | null>(null);
  const { fileSystemAdapter } = useAdapters();
  const { rootDirectoryHandles } = useFileSystem();
  const { dbRootIdByAdapterRootId, syncMountedRoots } = useRootsReconciliation({
    adapter: fileSystemAdapter,
  });
  useEffect(() => {
    let disposed = false;
    void fileSystemAdapter
      .restoreRoots?.()
      // The mounted set as a whole: a removed folder is forgotten, so re-adding
      // it under its one id registers it again (BST-1990).
      .then((roots) => (disposed ? undefined : syncMountedRoots(roots)))
      .catch(publishNativeFailure);
    return () => {
      disposed = true;
    };
  }, [fileSystemAdapter, syncMountedRoots, rootDirectoryHandles]);
  useEffect(() => followIndexConfig(capability), [capability]);
  // Only what the index reads: a worktree, policy or chunking change keeps the poll running.
  const mode = useIndexConfigStore((store) => selectIndexConfig(store)?.mode ?? null);
  const paused = useIndexConfigStore((store) => selectIndexConfig(store)?.paused === true);
  const model = useIndexModel();
  const configFailure = useIndexConfigStore((store) =>
    store.state.kind === 'failed' ? store.state.message : null
  );
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const publish = useWorkspaceCollectionSyncStatusStore.getState().setStatus;
    const mountedRoots = rootDirectoryHandles
      .map((root) => [root.rootId ?? null, root.path])
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    const selectionIdentity = JSON.stringify([mode, model, mountedRoots]);
    if (retained.current?.selection !== selectionIdentity) {
      resetNativeProgress();
      retained.current = { observation: null, selection: selectionIdentity };
    }
    if (mode === null) {
      // Until Main's config is read the index state is unknown, never off; a failed read says why.
      publish({
        blockedReason: null,
        lastError: configFailure,
        managedCollectionId: null,
        state: configFailure === null ? 'waiting' : 'error',
      });
      return;
    }
    if (mode === 'off' || paused) {
      publish({
        blockedReason: null,
        lastError: null,
        managedCollectionId: null,
        state: mode === 'off' ? 'disabled' : 'paused',
      });
      return;
    }
    const indexMode = mode === 'semantic' ? 'VECTOR' : 'TEXT';
    const refresh = async (): Promise<void> => {
      try {
        const progress = await readNativeProgress(capability);
        if (disposed) {
          return;
        }
        if (progress.kind === 'unavailable') {
          publishUnavailableProgress(progress);
          return;
        }
        reconcileProgressIdentity(retained, selectionIdentity, progress.identity);
        if (progress.kind === 'invalidated') {
          return;
        }
        publishNativeProgress(
          progress.coverage,
          progress.complete,
          indexMode,
          nativeRootPath(progress.status, rootDirectoryHandles, dbRootIdByAdapterRootId)
        );
      } catch (error) {
        if (!disposed) {
          publishNativeFailure(error);
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
    configFailure,
    dbRootIdByAdapterRootId,
    mode,
    model,
    paused,
    rootDirectoryHandles,
  ]);
  return (
    <RootIdentityProvider dbRootIdByAdapterRootId={dbRootIdByAdapterRootId}>
      {children}
    </RootIdentityProvider>
  );
}
