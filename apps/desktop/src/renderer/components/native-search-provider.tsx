import {
  selectIndexConfig,
  useIndexConfigStore,
  useIndexModel,
} from '@brainstrike/app-state/stores/index-config-store';
import {
  BoundaryFailureError,
  describeBoundaryFailure,
} from '@brainstrike/assistant-contract/boundary-failure';
import {
  type IndexConfig,
  type IndexLocalSelection,
  type IndexModel,
  indexModelLocalSelection,
} from '@brainstrike/assistant-contract/index-config';
import type {
  IndexerEmbeddingProfile,
  IndexerStatus,
  IndexLifecycleCapability,
  IndexSearchCapability,
  NativeIndexLifecycleObservation,
} from '@brainstrike/indexing-contract/indexer-client';
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
  selection: IndexLocalSelection,
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

/**
 * Main's vector space is the collection's model key and dimensions, compared as Main compares
 * them; the query plan names that key verbatim.
 */
function holdsModelVectors(status: ReadyStatus, model: IndexModel): boolean {
  return (
    status.embedding.indexMode === 'vector-configured' &&
    status.queryPlan?.modelKey === model.modelKey &&
    status.embedding.profile.dimensions === model.dimensions
  );
}

/** The saved choices search reads; Main's other changes (worktrees, policy, chunking) are not. */
type SavedSearch = Pick<IndexConfig, 'mode' | 'model'>;

function matchesSavedChoices(status: ReadyStatus, saved: SavedSearch | null): boolean {
  if (saved?.mode === 'text') {
    return status.embedding.indexMode === 'text-only';
  }
  if (!(saved?.mode === 'semantic' && saved.model !== null)) {
    return false;
  }
  const selection = indexModelLocalSelection(saved.model);
  return (
    holdsModelVectors(status, saved.model) &&
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
/** Why search is unavailable under a saved Off choice, and the setting that changes it. */
const SEARCH_OFF_REASON = 'Search is off. Turn it on in Settings, Search & Indexing.';

async function readMatchingStatus(
  capability: IndexSearchCapability,
  saved: SavedSearch | null
): Promise<IndexerStatus> {
  if (saved?.mode === 'off') {
    return { kind: 'unavailable', reason: SEARCH_OFF_REASON };
  }
  const next = await capability.status();
  if (next.kind === 'ready' && !matchesSavedChoices(next, saved)) {
    return {
      kind: 'unavailable',
      reason: 'Native search is activating the saved search mode and model.',
    };
  }
  return next;
}
/** Why Semantic is unavailable under a saved Text search choice, and the setting that changes it. */
const SEMANTIC_OFF_REASON =
  'Semantic search is off. Choose Semantic in Settings, Search & Indexing.';

/** The saved Text choice is the reason over any transient status; otherwise the status's own. */
function profileUnavailableReason(
  mode: IndexConfig['mode'] | null,
  status: IndexerStatus
): string | undefined {
  if (mode === 'text') {
    return SEMANTIC_OFF_REASON;
  }
  return status.kind === 'unavailable' ? status.reason : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof BoundaryFailureError) {
    return describeBoundaryFailure(error.failure);
  }
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
  const mode = useIndexConfigStore((store) => selectIndexConfig(store)?.mode ?? null);
  const model = useIndexModel();
  useEffect(() => {
    const saved = mode === null ? null : { mode, model };
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
        const next = await readMatchingStatus(capability, saved);
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
  }, [capability, mode, model]);
  const semantic = mode === 'semantic';
  const vectorExecution = semantic ? execution : null;
  const profile =
    semantic && execution.kind === 'ready' && execution.embedding.indexMode === 'vector-configured'
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
      if (
        !queryPlan ||
        current.kind !== 'ready' ||
        !matchesSavedChoices(current, selectIndexConfig(useIndexConfigStore.getState())) ||
        JSON.stringify(executionStatus(current)) !== JSON.stringify(vectorExecution) ||
        current.embedding.indexMode !== 'vector-configured' ||
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
