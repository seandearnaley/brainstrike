import type { ChangesInvalidationEvent } from '@brainstrike/types';
import { create } from 'zustand';

/**
 * Session-lived, NON-persisted state for the `changes:invalidated` push
 * channel (BST-1161, spec §6 completion). The main-process git-metadata
 * watcher observes external git activity (terminal commits, fetches, worktree
 * adds) and broadcasts one {@link ChangesInvalidationEvent} per debounce
 * window; `use-changes-live-refresh.ts` ingests them here, and the data hooks
 * derive refetch nonces:
 *
 * - `useGitInventory` refetches on ANY accepted event
 *   (`anyInvalidationNonce`) — inventory spans every repository.
 * - `useChangeset` refetches a `git-scope` changeset only when ITS repository
 *   was invalidated ({@link selectGitScopeRefreshNonce}) — a busy sibling
 *   repo must not churn an unrelated diff view. An event the service could
 *   not map to a repository (`repositoryRoot: null`) conservatively counts
 *   for every repo: a missed refresh is silent staleness, an extra refetch is
 *   just work.
 *
 * The wire `generation` is a per-main-process monotonic send counter;
 * `ingestInvalidation` drops stale/duplicate deliveries so a redundant IPC
 * replay can never double-refetch. Snapshot-sourced changesets (`agent-run` /
 * `run-range`) never read this store — external git activity does not change
 * them.
 */
export interface ChangesLiveRefreshState {
  /** Bumped on every ACCEPTED event. `useGitInventory`'s refetch input. */
  readonly anyInvalidationNonce: number;
  /**
   * Ingest one wire event. Drops it when `generation` is not strictly newer
   * than the last accepted one.
   */
  readonly ingestInvalidation: (event: ChangesInvalidationEvent) => void;
  /** Highest wire generation accepted so far (0 = none). */
  readonly lastEventGeneration: number;
  /** Per-repositoryRoot accepted-event counts. */
  readonly nonceByRepositoryRoot: Readonly<Record<string, number>>;
  /**
   * Factory-reset entry point (AGENTS.md invariant). Also restarts the wire
   * guard, so a main process re-numbering from 1 is not dropped.
   */
  readonly reset: () => void;
  /** Accepted events the service could not map to a repositoryRoot. */
  readonly unmappedInvalidationNonce: number;
}

const INITIAL_STATE = {
  anyInvalidationNonce: 0,
  lastEventGeneration: 0,
  nonceByRepositoryRoot: {},
  unmappedInvalidationNonce: 0,
} as const;

export const useChangesLiveRefreshStore = create<ChangesLiveRefreshState>((set) => ({
  ...INITIAL_STATE,
  ingestInvalidation: (event) =>
    set((state) => {
      if (event.generation <= state.lastEventGeneration) {
        return {};
      }
      return {
        anyInvalidationNonce: state.anyInvalidationNonce + 1,
        lastEventGeneration: event.generation,
        ...(event.repositoryRoot === null
          ? { unmappedInvalidationNonce: state.unmappedInvalidationNonce + 1 }
          : {
              nonceByRepositoryRoot: {
                ...state.nonceByRepositoryRoot,
                [event.repositoryRoot]:
                  (state.nonceByRepositoryRoot[event.repositoryRoot] ?? 0) + 1,
              },
            }),
      };
    }),
  reset: () => set(INITIAL_STATE),
}));

/**
 * The refetch nonce for one repository's `git-scope` changeset views.
 *
 * A repositoryRoot that has appeared in at least one event is a KNOWN key:
 * its nonce is its own accepted-event count plus every unmapped event (see
 * the store doc comment for why unmapped events count for every repo).
 *
 * A repositoryRoot the store has NEVER seen follows `anyInvalidationNonce`
 * instead — deliberately conservative (PR #2288 review). Event keys carry the
 * inventory's CANONICAL realpath'd main-worktree path, but not every
 * `git-scope` changeset does: the git panel pins `GitRepository.repositoryRoot`
 * straight out of `git worktree list`, never realpath'd
 * (`git-changes-view.tsx`), so through a symlink the two vocabularies diverge
 * and a string-equality lookup would silently NEVER refresh that surface —
 * the exact staleness class this channel exists to remove. Unknown-key
 * consumers therefore refetch on every event: an extra refetch is just work,
 * silent staleness is a defect. Once events for the same string arrive, the
 * key is known and precision applies.
 */
export function selectGitScopeRefreshNonce(
  state: Pick<
    ChangesLiveRefreshState,
    'anyInvalidationNonce' | 'nonceByRepositoryRoot' | 'unmappedInvalidationNonce'
  >,
  repositoryRoot: string
): number {
  const ownNonce = state.nonceByRepositoryRoot[repositoryRoot];
  if (ownNonce === undefined) {
    return state.anyInvalidationNonce;
  }
  return ownNonce + state.unmappedInvalidationNonce;
}
