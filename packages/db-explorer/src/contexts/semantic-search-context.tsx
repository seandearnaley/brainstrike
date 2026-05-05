/**
 * SemanticSearchContext
 *
 * React context that provides semantic search state and operations
 * for the Collection Browser. Manages transient search state (results,
 * loading, errors) while persisted preferences are handled by the Zustand store.
 */

import type { SearchConfig, SemanticSearchResult } from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils/logger';
import type { JSX, ReactNode } from 'react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

const logger = createLogger('SemanticSearchContext');

/**
 * Context value shape for semantic search functionality
 */
export interface SemanticSearchContextValue {
  /** Clear search results */
  clearResults: () => void;
  /** Error message from last search, if any */
  error: string | null;

  // Actions
  /** Execute a semantic search with the given query and config */
  executeSearch: (
    query: string,
    config: SearchConfig,
    embeddingSetId: string | null
  ) => Promise<void>;
  /** Whether a search has been executed at least once */
  hasSearched: boolean;
  /** Whether a search is in progress */
  isSearching: boolean;
  // Transient state (not persisted)
  /** Current search results */
  searchResults: SemanticSearchResult[];
  /** Set error state */
  setError: (error: string | null) => void;
  /** Set search results directly (for external integration) */
  setSearchResults: (results: SemanticSearchResult[]) => void;
}

/**
 * Props for the search executor function that performs the actual search
 */
export type SearchExecutor = (
  query: string,
  config: SearchConfig,
  embeddingSetId: string | null
) => Promise<SemanticSearchResult[]>;

/**
 * Props for the SemanticSearchProvider component
 */
export interface SemanticSearchProviderProps {
  children: ReactNode;
  /** Function that executes the actual semantic search */
  searchExecutor?: SearchExecutor;
}

// Default context value (used when provider is not present)
const defaultContextValue: SemanticSearchContextValue = {
  searchResults: [],
  isSearching: false,
  hasSearched: false,
  error: null,
  executeSearch: async () => {
    // No-op when provider is not present - errors are handled via the error state
  },
  clearResults: () => {},
  setSearchResults: () => {},
  setError: () => {},
};

/**
 * Context for semantic search state
 */
const SemanticSearchContext = createContext<SemanticSearchContextValue>(defaultContextValue);

/**
 * Hook to access semantic search context
 */
export function useSemanticSearch(): SemanticSearchContextValue {
  const context = useContext(SemanticSearchContext);
  return context;
}

/**
 * Provider component for semantic search functionality
 */
export function SemanticSearchProvider({
  children,
  searchExecutor,
}: SemanticSearchProviderProps): JSX.Element {
  // Transient state
  const [searchResults, setSearchResults] = useState<SemanticSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const previousExecutorAvailabilityRef = useRef<boolean | null>(null);

  // Log only true availability transitions, not callback identity churn.
  useEffect(() => {
    const hasExecutor = Boolean(searchExecutor);
    if (previousExecutorAvailabilityRef.current === hasExecutor) {
      return;
    }

    previousExecutorAvailabilityRef.current = hasExecutor;
    logger.debug('Search executor availability changed', { hasExecutor });
  }, [searchExecutor]);

  // Clear results action
  const clearResults = useCallback(() => {
    setSearchResults([]);
    setHasSearched(false);
    setError(null);
  }, []);

  // Execute search action
  const executeSearch = useCallback(
    async (query: string, config: SearchConfig, embeddingSetId: string | null) => {
      logger.info('executeSearch called', {
        query: query.slice(0, 50),
        embeddingSetId,
        hasExecutor: !!searchExecutor,
      });

      // Validate inputs BEFORE setting loading state to prevent flash
      if (!searchExecutor) {
        logger.error('Search executor not configured');
        setError('Search executor not configured');
        return;
      }

      if (!query.trim()) {
        logger.warn('Search query is empty');
        setError('Search query is empty');
        return;
      }

      if (!embeddingSetId) {
        logger.warn('No embedding set selected');
        setError('Select an active embedding set to perform semantic search');
        return;
      }

      setIsSearching(true);
      setError(null);

      try {
        logger.info('Executing search...');
        const results = await searchExecutor(query, config, embeddingSetId);
        logger.info('Search completed', { resultCount: results.length });
        setSearchResults(results);
        setHasSearched(true);
        setIsSearching(false);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('Search failed', { error: message });
        setError(message);
        setSearchResults([]);
        setIsSearching(false);
      }
    },
    [searchExecutor]
  );

  // Memoize context value to prevent unnecessary re-renders
  const contextValue = useMemo<SemanticSearchContextValue>(
    () => ({
      searchResults,
      isSearching,
      hasSearched,
      error,
      executeSearch,
      clearResults,
      setSearchResults,
      setError,
    }),
    [searchResults, isSearching, hasSearched, error, executeSearch, clearResults]
  );

  return (
    <SemanticSearchContext.Provider value={contextValue}>{children}</SemanticSearchContext.Provider>
  );
}

/**
 * Export context for testing or advanced use cases
 */
export { SemanticSearchContext };
