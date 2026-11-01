import { createContext, useContext } from 'react';
import type {
  WorkspaceSearchHit,
  WorkspaceSearchRequest,
  WorkspaceSearchSummary,
} from './search-result-model';

/**
 * The live text search the Search tab runs (ADR-0035): the desktop serves it
 * from the agent host's ripgrep. Matches stream to `onMatches` as they are
 * found; the promise settles once the search ends. Aborting `signal` ends the
 * search, and no match arrives after it.
 */
export interface WorkspaceFileSearch {
  search(
    request: WorkspaceSearchRequest,
    onMatches: (matches: readonly WorkspaceSearchHit[]) => void,
    signal: AbortSignal
  ): Promise<WorkspaceSearchSummary>;
}

export const WorkspaceFileSearchContext = createContext<WorkspaceFileSearch | null>(null);

/** The search this frame offers, or `null` where it has none (web). */
export function useWorkspaceFileSearch(): WorkspaceFileSearch | null {
  return useContext(WorkspaceFileSearchContext);
}
