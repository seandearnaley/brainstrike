import type { WorkspaceCollectionSyncBlockedReason } from '@brainstrike/app-state/stores/workspace-collection-sync-status-store';
import { describeBoundaryError } from '@brainstrike/assistant-contract/boundary-failure';
import type { IndexRetryCapability } from '@brainstrike/indexing-contract/indexer-client';
import { useState } from 'react';

export interface RetryIndexingAction {
  /** Why the last attempt failed, in the owner's typed words; null while none failed. */
  readonly failure: string | null;
  readonly pending: boolean;
  readonly retry: () => void;
}

/**
 * Retry indexing (BST-2104): the person's remedy for an embedding host that stopped responding.
 * Main restarts the host and re-opens the index; the status poll then shows the new progress, or
 * the same blocked cause if the host hangs again. Null where the host injects no capability.
 */
export function useRetryIndexing(
  capability: IndexRetryCapability | null
): RetryIndexingAction | null {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  if (!capability) {
    return null;
  }
  return {
    failure,
    pending,
    retry: () => {
      setPending(true);
      setFailure(null);
      capability
        .retryIndexing()
        .catch((error: unknown) => {
          setFailure(describeBoundaryError(error));
        })
        .finally(() => {
          setPending(false);
        });
    },
  };
}

/** Only a blocked index whose typed cause is an unresponsive embedding host offers the restart. */
export function offeredRetryIndexing(
  status: {
    readonly blockedReason: WorkspaceCollectionSyncBlockedReason | null;
    readonly state: string;
  },
  action: RetryIndexingAction | null
): RetryIndexingAction | null {
  return status.state === 'blocked' && status.blockedReason === 'embedding-host-unresponsive'
    ? action
    : null;
}
