/**
 * The host's worktree listing for the Threads panel's folder grouping
 * (ADR-0034 decision 3): the one git read that says which repository each
 * checkout belongs to, so a section can be a repository and not a folder.
 *
 * ONE `worktrees.list()` for the whole panel, never one per row or per
 * section. The listing is the host's join of git's worktree list with its
 * worktree ledger over the cached inventory, the same read the Worktree Map
 * makes.
 *
 * Read only while `enabled` (folder grouping is showing): the other groupings
 * place no thread by repository, and a row's checkout chip comes from the
 * thread's own binding.
 *
 * Re-read on the two signals that can change the answer, with no timer: an
 * accepted `changes:invalidated` event (a worktree added, removed or switched),
 * and a newly published root identity (a checkout mounted as a folder gets its
 * root id after the mount, without a git event).
 */
import { describeBoundaryFailure } from '@brainstrike/assistant-contract/boundary-failure';
import { createLogger } from '@brainstrike/logging';
import type { WorktreeListEntry } from '@brainstrike/types';
import { useEffect, useState } from 'react';
import { useChangesLiveRefreshStore } from '../changes/changes-live-refresh-store';
import { useChangesLiveRefreshSubscription } from '../changes/use-changes-live-refresh';
import { useOptionalRootIdentity } from '../roots/root-identity-context';
import { useWorktreesBridge } from '../workspace-git-services';

const logger = createLogger('ThreadRepositoryListing');

export interface ThreadRepositoryListingState {
  /**
   * `null` is "no listing": not asked for, still loading, failed, or a host
   * with no worktrees bridge. Never the same fact as a resolved empty listing,
   * which says no open folder is a repository.
   */
  readonly entries: readonly WorktreeListEntry[] | null;
  /** The latest read's failure. Folder grouping then groups by folder alone and says so. */
  readonly error: string | null;
  /** True until the first read settles. A later re-read keeps the rows it replaces. */
  readonly loading: boolean;
}

const NOT_LISTED: ThreadRepositoryListingState = { entries: null, error: null, loading: false };

export function useThreadRepositoryListing({
  enabled,
}: {
  /** True only while folder grouping shows. */
  readonly enabled: boolean;
}): ThreadRepositoryListingState {
  const bridge = useWorktreesBridge();
  useChangesLiveRefreshSubscription();
  const invalidationNonce = useChangesLiveRefreshStore((state) => state.anyInvalidationNonce);
  const rootIdentity = useOptionalRootIdentity();
  const [settled, setSettled] = useState<Omit<ThreadRepositoryListingState, 'loading'> | null>(
    null
  );

  useEffect(() => {
    if (!(bridge && enabled)) {
      return;
    }
    let cancelled = false;
    bridge
      .list()
      .then((result) => {
        if (cancelled) {
          return;
        }
        setSettled(
          result.ok
            ? { entries: result.value, error: null }
            : { entries: null, error: describeBoundaryFailure(result.error) }
        );
      })
      .catch((error: unknown) => {
        // A read this effect has since replaced (or a panel that went away,
        // as on a reload) has no one left to tell.
        if (cancelled) {
          return;
        }
        logger.error('failed to list worktrees for the thread list', { error });
        setSettled({
          entries: null,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      cancelled = true;
    };
    // `invalidationNonce` and `rootIdentity` are read triggers, not inputs.
  }, [bridge, enabled, invalidationNonce, rootIdentity]);

  if (!(bridge && enabled)) {
    return NOT_LISTED;
  }
  return settled === null
    ? { entries: null, error: null, loading: true }
    : { ...settled, loading: false };
}
