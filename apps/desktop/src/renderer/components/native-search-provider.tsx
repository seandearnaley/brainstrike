import { useBackgroundIndexingPreferencesStore } from '@brainstrike/app-state/stores/background-indexing-preferences-store';
import type {
  IndexerEmbeddingProfile,
  IndexerStatus,
  IndexLifecycleCapability,
  IndexSearchCapability,
  NativeIndexLifecycleObservation,
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
type ExecutionStatus =
  | Omit<
      ReadyStatus,
      'collectionReadiness' | 'rootReadiness' | 'publicationProgress' | 'sourceObservation'
    >
  | Extract<IndexerStatus, { kind: 'unavailable' }>;
interface NativeSearchStatus {
  readonly execution: ExecutionStatus;
  readonly status: IndexerStatus;
}
function matchesSelection(
  selection: NativeLocalSelection,
  plan: NonNullable<NonNullable<ReadyStatus['queryPlan']>['inferencePlan']>
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
  if (mode === 'TEXT' && collectionId === null) {
    return status.embedding.indexMode === 'text-only';
  }
  if (collectionId === null || !status.authorizedCollectionIds?.includes(collectionId)) {
    return false;
  }
  if (mode === 'TEXT') {
    return status.embedding.indexMode === 'text-only';
  }
  return (
    mode === 'VECTOR' &&
    status.embedding.indexMode === 'vector-configured' &&
    status.queryPlan !== undefined &&
    (status.queryPlan.inferencePlan
      ? selection !== null && matchesSelection(selection, status.queryPlan.inferencePlan)
      : selection === null)
  );
}

function unchangedStatus<T>(prior: T, next: T): T {
  return JSON.stringify(prior) === JSON.stringify(next) ? prior : next;
}
function executionStatus(status: IndexerStatus): ExecutionStatus {
  if (status.kind === 'unavailable') {
    return status;
  }
  const {
    collectionReadiness: _collections,
    rootReadiness: _roots,
    publicationProgress: _progress,
    sourceObservation: _source,
    ...execution
  } = status;
  return execution;
}
function nextSearchStatus(prior: NativeSearchStatus, status: IndexerStatus): NativeSearchStatus {
  return {
    execution: unchangedStatus(prior.execution, executionStatus(status)),
    status: unchangedStatus(prior.status, status),
  };
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
/** Why Semantic is unavailable under a saved Text search choice, and the setting that changes it. */
const SEMANTIC_OFF_REASON =
  'Semantic search is off. Choose “Text and semantic search” in Search & Indexing settings.';

/** The saved Text choice is the reason over any transient status; otherwise the status's own. */
function profileUnavailableReason(
  mode: NativeIndexMode | null,
  status: IndexerStatus
): string | undefined {
  if (mode === 'TEXT') {
    return SEMANTIC_OFF_REASON;
  }
  return status.kind === 'unavailable' ? status.reason : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The main owner resolves the actual saved catalog/profile; query inference stays in its hidden renderer. */
export function NativeSearchProvider({
  capability,
  children,
}: {
  readonly capability: IndexSearchCapability & IndexLifecycleCapability;
  readonly children: ReactNode;
}): ReactNode {
  const [observation, setStatus] = useState<NativeSearchStatus>(() => {
    const initial = { kind: 'unavailable' as const, reason: 'Native search is initializing.' };
    return { execution: initial, status: initial };
  });
  const [lifecycle, setLifecycle] = useState<NativeIndexLifecycleObservation | null>(null);
  const { execution } = observation;
  const mode = useBackgroundIndexingPreferencesStore((state) => state.nativeIndexMode);
  const selection = useBackgroundIndexingPreferencesStore((state) => state.nativeLocalSelection);
  const collectionId = useBackgroundIndexingPreferencesStore((state) => state.managedCollectionId);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let revision = 0;
    let latestEvent: NativeIndexLifecycleObservation | undefined;
    const refresh = async (event?: NativeIndexLifecycleObservation): Promise<void> => {
      if (event) {
        latestEvent = event;
      }
      const request = ++revision;
      try {
        const next = await readMatchingStatus(capability, mode, selection, collectionId);
        if (!disposed && request === revision) {
          setStatus((prior) => nextSearchStatus(prior, next));
          const observed = latestEvent;
          if (observed) {
            setLifecycle((prior) => unchangedStatus(prior, observed));
          }
        }
      } catch (error) {
        if (!disposed && request === revision) {
          setStatus((prior) =>
            nextSearchStatus(prior, { kind: 'unavailable', reason: errorMessage(error) })
          );
        }
      }
    };
    const poll = async (): Promise<void> => {
      await refresh();
      if (!disposed) {
        timer = setTimeout(() => {
          void poll();
        }, 2000);
      }
    };
    const unsubscribe = capability.onLifecycleChanged((event) => {
      void refresh(event);
    });
    void poll();
    return () => {
      disposed = true;
      unsubscribe();
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, [capability, collectionId, mode, selection]);
  const vectorExecution = mode === 'VECTOR' ? execution : null;
  const profile =
    mode === 'VECTOR' &&
    execution.kind === 'ready' &&
    execution.embedding.indexMode === 'vector-configured'
      ? execution.embedding.profile
      : null;
  const embedQuery = useCallback(
    async (
      requested: IndexerEmbeddingProfile,
      query: string,
      options: { readonly signal: AbortSignal }
    ): Promise<readonly number[]> => {
      const queryPlan = vectorExecution?.kind === 'ready' ? vectorExecution.queryPlan : undefined;
      options.signal.throwIfAborted();
      const current = await capability.status();
      options.signal.throwIfAborted();
      const saved = useBackgroundIndexingPreferencesStore.getState();
      if (
        saved.nativeIndexMode !== 'VECTOR' ||
        !queryPlan ||
        (queryPlan.inferencePlan
          ? !(
              saved.nativeLocalSelection &&
              matchesSelection(saved.nativeLocalSelection, queryPlan.inferencePlan)
            )
          : saved.nativeLocalSelection !== null) ||
        current.kind !== 'ready' ||
        JSON.stringify(executionStatus(current)) !== JSON.stringify(vectorExecution) ||
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
          ...(queryPlan.inferencePlan ? { inferencePlan: queryPlan.inferencePlan } : {}),
          modelId: requested.modelId,
          modelKey: queryPlan.modelKey,
          query,
        },
        options
      );
    },
    [capability, vectorExecution]
  );
  const dependencies = useMemo<NativeWorkspaceSearchDependencies>(() => {
    const reason = profileUnavailableReason(mode, observation.status);
    return {
      capability,
      embedQuery,
      lifecycle,
      profile,
      status: observation.status,
      ...(reason === undefined ? {} : { profileUnavailableReason: reason }),
    };
  }, [capability, embedQuery, lifecycle, mode, observation, profile]);
  return (
    <NativeWorkspaceSearchProvider dependencies={dependencies}>
      {children}
    </NativeWorkspaceSearchProvider>
  );
}
