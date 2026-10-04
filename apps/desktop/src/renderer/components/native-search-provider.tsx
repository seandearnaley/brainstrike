import { useBackgroundIndexingPreferencesStore } from '@brainstrike/app-state/stores/background-indexing-preferences-store';
import type {
  IndexerEmbeddingProfile,
  IndexerStatus,
  IndexSearchCapability,
} from '@brainstrike/indexing-contract/indexer-client';
import type {
  NativeIndexMode,
  NativeLocalSelection,
} from '@brainstrike/indexing-contract/indexer-producer';
import {
  type NativeWorkspaceSearchDependencies,
  NativeWorkspaceSearchProvider,
} from '@brainstrike/workspace-search/core';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { generateDesktopQueryEmbedding } from '../query-embeddings';

type ReadyStatus = Extract<IndexerStatus, { kind: 'ready' }>;
function matchesSelection(
  selection: NativeLocalSelection,
  plan: NonNullable<ReadyStatus['queryPlan']>['inferencePlan']
): boolean {
  return (
    selection.modelId === plan.modelId &&
    selection.revision === plan.revision &&
    selection.dimensions === plan.dimensions &&
    selection.dtype === plan.dtype &&
    selection.device === plan.device
  );
}

function matchesSavedChoices(
  status: ReadyStatus,
  mode: NativeIndexMode | null,
  selection: NativeLocalSelection | null,
  collectionId: string | null
): boolean {
  if (collectionId === null || !status.authorizedCollectionIds?.includes(collectionId)) {
    return false;
  }
  if (mode === 'TEXT') {
    return status.embedding.indexMode === 'text-only';
  }
  return (
    mode === 'VECTOR' &&
    status.embedding.indexMode === 'vector-configured' &&
    selection !== null &&
    status.queryPlan !== undefined &&
    matchesSelection(selection, status.queryPlan.inferencePlan)
  );
}

function unchangedStatus(prior: IndexerStatus, next: IndexerStatus): IndexerStatus {
  return JSON.stringify(prior) === JSON.stringify(next) ? prior : next;
}
async function readMatchingStatus(
  capability: IndexSearchCapability,
  mode: NativeIndexMode | null,
  selection: NativeLocalSelection | null,
  collectionId: string | null
): Promise<IndexerStatus> {
  const next = await capability.status();
  if (next.kind === 'ready' && !matchesSavedChoices(next, mode, selection, collectionId)) {
    return {
      kind: 'unavailable',
      reason: 'Native search is activating the saved collection and execution choices.',
    };
  }
  return next;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The main owner resolves the actual saved catalog/profile; query inference stays in its hidden renderer. */
export function NativeSearchProvider({
  capability,
  children,
}: {
  readonly capability: IndexSearchCapability;
  readonly children: ReactNode;
}): ReactNode {
  const [status, setStatus] = useState<IndexerStatus>({
    kind: 'unavailable',
    reason: 'Native search is initializing.',
  });
  const mode = useBackgroundIndexingPreferencesStore((state) => state.nativeIndexMode);
  const selection = useBackgroundIndexingPreferencesStore((state) => state.nativeLocalSelection);
  const collectionId = useBackgroundIndexingPreferencesStore((state) => state.managedCollectionId);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async (): Promise<void> => {
      try {
        const next = await readMatchingStatus(capability, mode, selection, collectionId);
        if (!disposed) {
          setStatus((prior) => unchangedStatus(prior, next));
        }
      } catch (error) {
        if (!disposed) {
          setStatus({
            kind: 'unavailable',
            reason: errorMessage(error),
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
  }, [capability, collectionId, mode, selection]);
  const profile =
    mode === 'VECTOR' &&
    status.kind === 'ready' &&
    status.embedding.indexMode === 'vector-configured'
      ? status.embedding.profile
      : null;
  const queryPlan: ReadyStatus['queryPlan'] =
    status.kind === 'ready' ? status.queryPlan : undefined;
  const embedQuery = useCallback(
    async (
      requested: IndexerEmbeddingProfile,
      query: string,
      options: { readonly signal: AbortSignal }
    ): Promise<readonly number[]> => {
      options.signal.throwIfAborted();
      const current = await capability.status();
      options.signal.throwIfAborted();
      const saved = useBackgroundIndexingPreferencesStore.getState();
      if (
        saved.nativeIndexMode !== 'VECTOR' ||
        !saved.nativeLocalSelection ||
        !queryPlan ||
        !matchesSelection(saved.nativeLocalSelection, queryPlan.inferencePlan) ||
        current.kind !== 'ready' ||
        current.embedding.indexMode !== 'vector-configured' ||
        !current.authorizedCollectionIds?.includes(saved.managedCollectionId ?? '') ||
        JSON.stringify(current.embedding.profile) !== JSON.stringify(requested) ||
        JSON.stringify(current.queryPlan) !== JSON.stringify(queryPlan)
      ) {
        throw new Error(
          'Native query inference no longer matches the explicit saved execution plan.'
        );
      }
      return generateDesktopQueryEmbedding(
        {
          dimensions: requested.dimensions,
          inferencePlan: queryPlan.inferencePlan,
          modelId: requested.modelId,
          modelKey: queryPlan.modelKey,
          query,
        },
        options
      );
    },
    [capability, queryPlan]
  );
  const dependencies = useMemo<NativeWorkspaceSearchDependencies>(
    () => ({
      capability,
      embedQuery,
      profile,
      ...(status.kind === 'unavailable' ? { profileUnavailableReason: status.reason } : {}),
    }),
    [capability, embedQuery, profile, status]
  );
  return (
    <NativeWorkspaceSearchProvider dependencies={dependencies}>
      {children}
    </NativeWorkspaceSearchProvider>
  );
}
