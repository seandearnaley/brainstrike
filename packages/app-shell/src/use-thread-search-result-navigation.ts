import { useCallback } from 'react';
import type { AssistantThreadHostCapability } from './assistant-thread-host-context';
import { navigateThreadSearchResult } from './navigate-thread-search-result';

/** Keep result activation bound to the workspace whose search is displayed. */
export function useThreadSearchResultNavigation(
  ownerResourceId: string,
  host: AssistantThreadHostCapability
): (threadId: string, messageId?: string) => void {
  return useCallback(
    (threadId: string, messageId?: string) => {
      void navigateThreadSearchResult(ownerResourceId, threadId, messageId, host);
    },
    [host, ownerResourceId]
  );
}
