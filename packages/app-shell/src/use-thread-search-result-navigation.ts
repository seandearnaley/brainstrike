import type { ThreadSearchRepository } from '@brainstrike/db';
import { useCallback } from 'react';
import { navigateThreadSearchResult } from './navigate-thread-search-result';

/** Keep result activation bound to the workspace whose search is displayed. */
export function useThreadSearchResultNavigation(
  repository: ThreadSearchRepository | null,
  ownerResourceId: string
): (threadId: string, messageId?: string) => void {
  return useCallback(
    (threadId: string, messageId?: string) => {
      void navigateThreadSearchResult(repository, ownerResourceId, threadId, messageId);
    },
    [ownerResourceId, repository]
  );
}
