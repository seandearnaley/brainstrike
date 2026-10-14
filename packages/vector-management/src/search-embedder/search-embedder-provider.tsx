/**
 * SearchEmbedderProvider
 *
 * Owns a SINGLE `useSearchEmbedder()` result and shares it via React context so
 * every semantic-search surface in one window reuses ONE embedder cache. Without
 * this, each consumer hook instance (db-explorer's semantic search executor,
 * app-shell's workspace-search controller, …) owned its own cached
 * `SearchEmbedder`, doubling local model memory whenever two surfaces were live.
 *
 * The embedder machinery is lazy inside `useSearchEmbedder` (models load on the
 * first embed, not on mount), so an always-mounted provider costs nothing until
 * the first query is embedded.
 *
 * No silent fallback: `useSharedSearchEmbedder()` THROWS when the provider is
 * absent rather than quietly spinning up a private (unshared) embedder.
 */

import { createContext, type ReactElement, type ReactNode, useContext } from 'react';
import {
  type LocalSearchEmbedderFactory,
  type UseSearchEmbedderResult,
  useSearchEmbedder,
} from './use-search-embedder.js';

const SearchEmbedderContext = createContext<UseSearchEmbedderResult | null>(null);

export function SearchEmbedderProvider({
  children,
  createLocalEmbedder,
}: {
  children: ReactNode;
  createLocalEmbedder?: LocalSearchEmbedderFactory | undefined;
}): ReactElement {
  const value = useSearchEmbedder(createLocalEmbedder);
  return <SearchEmbedderContext.Provider value={value}>{children}</SearchEmbedderContext.Provider>;
}

/**
 * Read the shared embedder from context. Throws when no
 * {@link SearchEmbedderProvider} encloses the caller — a missing provider is a
 * wiring bug, not a condition to paper over with a private embedder.
 */
export function useSharedSearchEmbedder(): UseSearchEmbedderResult {
  const ctx = useContext(SearchEmbedderContext);
  if (ctx === null) {
    throw new Error(
      'useSharedSearchEmbedder must be used within a <SearchEmbedderProvider>. ' +
        'Mount the provider at a level that encloses every semantic-search surface.'
    );
  }
  return ctx;
}
