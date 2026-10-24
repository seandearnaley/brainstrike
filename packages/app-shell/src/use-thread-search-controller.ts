import {
  BoundaryFailureError,
  describeBoundaryFailure,
} from '@brainstrike/assistant-contract/boundary-failure';
import type {
  EmbeddingSetModelInfo,
  UseSearchEmbedderResult,
} from '@brainstrike/vector-management';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { AssistantThreadSearchSemantic } from './assistant-thread-host-context';
import type { buildLocalEmbeddingModelConfigMap } from './embedding-models';
import {
  combineThreadSearchCoverage,
  embedPendingHostSearchRows,
  type HostThreadSearchVectors,
  type ThreadSearchVectorProfile,
  threadSearchVectorProfile,
} from './host-thread-search-vectors';
import { resolveSingletonProfileModelInfo } from './prompt-embedding-model-info';
import type { ThreadSearchEmbedder } from './thread-search-embedding';
import {
  createThreadSearchService,
  THREAD_SEARCH_VECTOR_THRESHOLD,
  type ThreadSearchCoverage,
  type ThreadSearchExtraArms,
} from './thread-search-service';
import { type ThreadSearchSemanticState, useThreadSearchStore } from './thread-search-store';

/** Minimum query length before a search runs (titles match from 2 chars). */
export const THREAD_SEARCH_MIN_QUERY_LENGTH = 2;
/** Debounce between typing and the search pass. */
export const THREAD_SEARCH_DEBOUNCE_MS = 250;
/** Backlog rows embedded per background pass (bounded per the perf contract). */
const EMBEDDING_PASS_LIMIT = 16;
/** Hard cap on backlog passes per drain trigger (16 rows each). */
const MAX_EMBEDDING_PASSES_PER_DRAIN = 50;
/**
 * After a query-embedding failure, later searches skip the (potentially
 * multi-second) re-attempt for this long and resolve lexical-only immediately
 * with the SAME visible reason. Bounded so a recovered embedder (model
 * finished downloading, document became visible) is retried automatically.
 */
export const THREAD_SEARCH_SEMANTIC_RETRY_MS = 60_000;

/** The embedder a backlog drain embeds the host's rows with, and their vector profile. */
interface HostSearchTarget {
  readonly modelInfo: EmbeddingSetModelInfo;
  readonly profile: ThreadSearchVectorProfile;
}

export interface UseThreadSearchControllerOptions {
  /** `ensureEmbedderReady` names the runtime, so the profile, of the embedder that ran. */
  readonly embedder: ThreadSearchEmbedder & Pick<UseSearchEmbedderResult, 'ensureEmbedderReady'>;
  /** The desktop conversation owner's semantic backlog. */
  readonly hostSearchVectors?: HostThreadSearchVectors | undefined;
  readonly localModelConfigMap: ReturnType<typeof buildLocalEmbeddingModelConfigMap>;
  readonly readEmbeddingProfile: () => Promise<{ modelKey: string; dimensions: number }>;
  readonly resourceId: string;
  /** The conversation search owner; a host without search omits it, and search stays idle. */
  readonly searchHost?:
    | ((query: string, semantic?: AssistantThreadSearchSemantic) => Promise<ThreadSearchExtraArms>)
    | undefined;
}

export interface ThreadSearchController {
  /** Re-runs the current query (error-state retry affordance). */
  readonly retrySearch: () => void;
}

/** The host owns every conversation, so the history index contributes no rows. */
const NO_HISTORY_COVERAGE: ThreadSearchCoverage = {
  embeddableMessages: 0,
  embeddedMessages: 0,
  erroredMessages: 0,
  indexedMessages: 0,
  totalMessages: 0,
};

function toThreadSearchErrorMessage(error: unknown): string {
  // A refusal carries its remedy, such as the device setting to change (BST-2058).
  if (error instanceof BoundaryFailureError) {
    return describeBoundaryFailure(error.failure);
  }
  return error instanceof Error && error.message.trim()
    ? error.message
    : `Unexpected thread search failure: ${String(error)}`;
}

/**
 * Drives the Threads panel search: debounced hybrid queries through
 * `ThreadSearchService` and a bounded background embedding backlog drain. All completions are generation-gated through the
 * session store, so superseded runs can never clobber fresher state.
 *
 * Semantic-arm honesty: when the query embedding cannot be produced (no
 * embedding queue registered, model/profile mismatch, embedder failure), the
 * search still runs lexical-only but the store records the visible
 * `unavailable` reason — never a silent downgrade.
 */
export function useThreadSearchController({
  embedder,
  hostSearchVectors,
  localModelConfigMap,
  readEmbeddingProfile,
  resourceId,
  searchHost,
}: UseThreadSearchControllerOptions): ThreadSearchController {
  const service = useMemo(() => createThreadSearchService(null), []);
  const query = useThreadSearchStore((state) => state.query);
  /** Serializes embedding passes so overlapping searches never double-drain. */
  const embeddingTailRef = useRef<Promise<void> | null>(null);
  const semanticFailureRef = useRef<{ at: number; reason: string } | null>(null);
  /** A success recorded after a failing attempt STARTED invalidates it. */
  const lastSemanticSuccessAtRef = useRef<number | null>(null);

  const resolveModelInfo = useCallback(
    async (): Promise<EmbeddingSetModelInfo> =>
      resolveSingletonProfileModelInfo(await readEmbeddingProfile(), localModelConfigMap),
    [localModelConfigMap, readEmbeddingProfile]
  );

  const resolveQueryEmbedding = useCallback(
    async (
      trimmedQuery: string
    ): Promise<
      | {
          embedding: readonly number[];
          profile: ThreadSearchVectorProfile;
          semantic: ThreadSearchSemanticState;
        }
      | { embedding: null; semantic: ThreadSearchSemanticState }
    > => {
      const recentFailure = semanticFailureRef.current;
      if (recentFailure && Date.now() - recentFailure.at < THREAD_SEARCH_SEMANTIC_RETRY_MS) {
        // Skip the (potentially slow) re-attempt; the reason stays visible.
        return {
          embedding: null,
          semantic: { kind: 'unavailable', reason: recentFailure.reason },
        };
      }
      const attemptStartedAt = Date.now();
      try {
        const modelInfo = await resolveModelInfo();
        const embedding = await embedder.embedQueryWithRecovery(modelInfo, trimmedQuery);
        // The cached embedder that just ran names the profile its vectors belong to.
        const { runtime } = await embedder.ensureEmbedderReady(modelInfo);
        semanticFailureRef.current = null;
        lastSemanticSuccessAtRef.current = Date.now();
        return {
          embedding,
          profile: threadSearchVectorProfile(modelInfo, runtime),
          semantic: { kind: 'used' },
        };
      } catch (error) {
        const reason = toThreadSearchErrorMessage(error);
        // A slow superseded failure must not blind later searches to a
        // healthy embedder: only record it if no attempt SUCCEEDED after
        // this one started.
        const lastSuccessAt = lastSemanticSuccessAtRef.current;
        if (lastSuccessAt === null || lastSuccessAt < attemptStartedAt) {
          semanticFailureRef.current = { at: Date.now(), reason };
        }
        return {
          embedding: null,
          semantic: { kind: 'unavailable', reason },
        };
      }
    },
    [embedder, resolveModelInfo]
  );

  /** Fire-and-forget bounded backlog drain; coverage refresh reports progress. */
  const drainEmbeddingBacklog = useCallback(() => {
    if (!searchHost) {
      return;
    }
    // The host's half needs the profile of the embedder that will run; an
    // embedder that cannot start leaves it out, and the search shows semantic
    // search unavailable with its reason.
    const resolveHostTarget = async (): Promise<HostSearchTarget | null> => {
      if (!hostSearchVectors) {
        return null;
      }
      try {
        const modelInfo = await resolveModelInfo();
        const { runtime } = await embedder.ensureEmbedderReady(modelInfo);
        return { modelInfo, profile: threadSearchVectorProfile(modelInfo, runtime) };
      } catch {
        return null;
      }
    };
    /** Report progress for the active conversation owner. */
    const recordCoverage = async (target: HostSearchTarget | null) => {
      const host =
        target && hostSearchVectors ? await hostSearchVectors.coverage(target.profile) : null;
      useThreadSearchStore
        .getState()
        .recordCoverage(combineThreadSearchCoverage(NO_HISTORY_COVERAGE, host));
    };
    // The host's backlog uses the existing rows-per-pass bound.
    const drainHost = async (target: HostSearchTarget | null): Promise<void> => {
      if (!(target && hostSearchVectors)) {
        return;
      }
      for (let pass = 0; pass < MAX_EMBEDDING_PASSES_PER_DRAIN; pass += 1) {
        const recentFailure = semanticFailureRef.current;
        if (recentFailure && Date.now() - recentFailure.at < THREAD_SEARCH_SEMANTIC_RETRY_MS) {
          return;
        }
        const embedded = await embedPendingHostSearchRows({
          embedder,
          host: hostSearchVectors,
          limit: EMBEDDING_PASS_LIMIT,
          modelInfo: target.modelInfo,
          profile: target.profile,
        });
        await recordCoverage(target);
        if (embedded === 0) {
          return;
        }
      }
    };
    const execute = async (): Promise<void> => {
      try {
        await drainHost(await resolveHostTarget());
      } catch {
        // Backlog embedding is opportunistic; failures surface per-search via
        // the semantic `unavailable` reason, and per-row via embedding_error.
      }
    };
    embeddingTailRef.current = (embeddingTailRef.current ?? Promise.resolve()).then(
      execute,
      execute
    );
  }, [embedder, hostSearchVectors, resolveModelInfo, searchHost]);

  const runSearch = useCallback(
    (rawQuery: string) => {
      const trimmed = rawQuery.trim();
      const store = useThreadSearchStore.getState();
      if (!searchHost || trimmed.length < THREAD_SEARCH_MIN_QUERY_LENGTH) {
        return;
      }
      const generation = store.beginSearch();
      void (async () => {
        try {
          drainEmbeddingBacklog();
          const query = await resolveQueryEmbedding(trimmed);
          // The host's arms take the same query vector; their failure fails this search.
          const hostArms = await searchHost(
            trimmed,
            query.embedding === null
              ? undefined
              : {
                  profile: query.profile,
                  threshold: THREAD_SEARCH_VECTOR_THRESHOLD,
                  vector: query.embedding,
                }
          );
          const response = await service.searchThreads(trimmed, {
            ...(hostArms ? { extraArms: hostArms } : {}),
            queryEmbedding: query.embedding,
            resourceId,
          });
          const { semantic } = query;
          useThreadSearchStore.getState().resolveResults(response.results, semantic, generation);
        } catch (error) {
          useThreadSearchStore.getState().failSearch(toThreadSearchErrorMessage(error), generation);
        }
      })();
    },
    [drainEmbeddingBacklog, resolveQueryEmbedding, resourceId, searchHost, service]
  );

  // Debounced auto-search on query changes; a shrunken query clears results
  // (and bumps the generation) so an in-flight longer-query run cannot
  // resurrect them — the workspace-search contract.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < THREAD_SEARCH_MIN_QUERY_LENGTH) {
      const store = useThreadSearchStore.getState();
      if (store.status !== 'idle' || store.results !== null) {
        store.clearResults();
      }
      return;
    }
    const timer = setTimeout(() => {
      runSearch(query);
    }, THREAD_SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [query, runSearch]);

  const retrySearch = useCallback(() => {
    runSearch(useThreadSearchStore.getState().query);
  }, [runSearch]);

  return { retrySearch };
}
