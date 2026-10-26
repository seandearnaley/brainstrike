import {
  BoundaryFailureError,
  describeBoundaryFailure,
} from '@brainstrike/assistant-contract/boundary-failure';
import { useCallback, useEffect, useMemo } from 'react';
import { createThreadSearchService, type ThreadSearchExtraArms } from './thread-search-service';
import { useThreadSearchStore } from './thread-search-store';

/** Minimum query length before a search runs (titles match from 2 chars). */
const THREAD_SEARCH_MIN_QUERY_LENGTH = 2;
/** Debounce between typing and the search pass. */
export const THREAD_SEARCH_DEBOUNCE_MS = 250;

export interface UseThreadSearchControllerOptions {
  readonly resourceId: string;
  /** The conversation search owner; a host without search omits it, and search stays idle. */
  readonly searchHost?: ((query: string) => Promise<ThreadSearchExtraArms>) | undefined;
}

export interface ThreadSearchController {
  /** Re-runs the current query (error-state retry affordance). */
  readonly retrySearch: () => void;
}

function toThreadSearchErrorMessage(error: unknown): string {
  if (error instanceof BoundaryFailureError) {
    return describeBoundaryFailure(error.failure);
  }
  return error instanceof Error && error.message.trim()
    ? error.message
    : `Unexpected thread search failure: ${String(error)}`;
}

/**
 * Drives the Threads panel search: debounced text queries through
 * `ThreadSearchService`. All completions are generation-gated through the
 * session store, so superseded runs can never clobber fresher state.
 */
export function useThreadSearchController({
  resourceId,
  searchHost,
}: UseThreadSearchControllerOptions): ThreadSearchController {
  const service = useMemo(() => createThreadSearchService(null), []);
  const query = useThreadSearchStore((state) => state.query);

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
          // The host's arms failing fails this search.
          const hostArms = await searchHost(trimmed);
          const response = await service.searchThreads(trimmed, {
            extraArms: hostArms,
            resourceId,
          });
          useThreadSearchStore.getState().resolveResults(response.results, generation);
        } catch (error) {
          useThreadSearchStore.getState().failSearch(toThreadSearchErrorMessage(error), generation);
        }
      })();
    },
    [resourceId, searchHost, service]
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
