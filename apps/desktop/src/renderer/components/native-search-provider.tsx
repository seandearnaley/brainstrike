import {
  selectIndexConfig,
  useIndexConfigStore,
  useIndexModel,
} from '@brainstrike/app-state/stores/index-config-store';
import {
  BoundaryFailureError,
  describeBoundaryFailure,
} from '@brainstrike/assistant-contract/boundary-failure';
import type { IndexConfig, IndexModel } from '@brainstrike/assistant-contract/index-config';
import {
  type IndexerEmbeddingProfile,
  type IndexerStatus,
  type IndexLifecycleCapability,
  type IndexSearchCapability,
  NATIVE_INDEX_OFF_MESSAGE,
  type NativeIndexLifecycleObservation,
} from '@brainstrike/indexing-contract/indexer-client';
import {
  type NativeWorkspaceSearchDependencies,
  NativeWorkspaceSearchProvider,
} from '@brainstrike/workspace-search/core';
import { type ReactNode, useEffect, useState } from 'react';
import { generateDesktopQueryEmbedding } from '../query-embeddings';

type ReadyStatus = Extract<IndexerStatus, { kind: 'ready' }>;
type ExecutionStatus =
  | Omit<ReadyStatus, 'rootReadiness' | 'publicationProgress' | 'sourceObservation'>
  | Extract<IndexerStatus, { kind: 'unavailable' }>;
interface NativeSearchStatus {
  readonly execution: ExecutionStatus;
  readonly status: IndexerStatus;
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
  return holdsModelVectors(status, saved.model) && status.queryPlan !== undefined;
}

function unchangedStatus<T>(prior: T, next: T): T {
  return JSON.stringify(prior) === JSON.stringify(next) ? prior : next;
}
function executionStatus(status: IndexerStatus): ExecutionStatus {
  if (status.kind === 'unavailable') {
    return status;
  }
  const {
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

/** Main's status as search may use it under the saved choices. */
function matchingStatus(next: IndexerStatus, saved: SavedSearch | null): IndexerStatus {
  if (saved?.mode === 'off') {
    return { kind: 'unavailable', reason: NATIVE_INDEX_OFF_MESSAGE };
  }
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

/**
 * A new value for every observation Main pushes, even one whose status is
 * unchanged: consumers re-read availability on each push. It takes the whole
 * observation because the React Compiler memoizes a call on its arguments, and
 * would keep the previous value across a push whose status was equal.
 */
function searchDependencies(
  observation: NativeSearchStatus,
  rest: Omit<NativeWorkspaceSearchDependencies, 'profileUnavailableReason' | 'status'> & {
    readonly mode: IndexConfig['mode'] | null;
  }
): NativeWorkspaceSearchDependencies {
  const { mode, ...dependencies } = rest;
  const reason = profileUnavailableReason(mode, observation.status);
  return {
    ...dependencies,
    status: observation.status,
    ...(reason === undefined ? {} : { profileUnavailableReason: reason }),
  };
}

/** Main resolves the saved catalog/profile and embeds the query with the hosted provider. */
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
    // Main pushes after every change it reads; a push is newer than this view's first read.
    let pushed = false;
    const show = (next: IndexerStatus): void => {
      setStatus((prior) => nextSearchStatus(prior, matchingStatus(next, saved)));
    };
    const unsubscribe = capability.onLifecycleChanged(({ lifecycle: observed, progress }) => {
      pushed = true;
      show(
        progress.kind === 'read'
          ? progress.status
          : { kind: 'unavailable', reason: progress.reason }
      );
      setLifecycle((prior) => unchangedStatus(prior, observed));
    });
    if (saved?.mode === 'off') {
      show({ kind: 'unavailable', reason: NATIVE_INDEX_OFF_MESSAGE });
    } else {
      capability.status().then(
        (next) => {
          if (!(disposed || pushed)) {
            show(next);
          }
        },
        (error: unknown) => {
          if (!(disposed || pushed)) {
            show({ kind: 'unavailable', reason: errorMessage(error) });
          }
        }
      );
    }
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [capability, mode, model]);
  const semantic = mode === 'semantic';
  const vectorExecution = semantic ? execution : null;
  const profile =
    semantic && execution.kind === 'ready' && execution.embedding.indexMode === 'vector-configured'
      ? execution.embedding.profile
      : null;
  const embedQuery = async (
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
        modelId: requested.modelId,
        modelKey: queryPlan.modelKey,
        query,
      },
      options
    );
  };
  const dependencies = searchDependencies(observation, {
    capability,
    embedQuery,
    lifecycle,
    mode,
    profile,
  });
  return (
    <NativeWorkspaceSearchProvider dependencies={dependencies}>
      {children}
    </NativeWorkspaceSearchProvider>
  );
}
