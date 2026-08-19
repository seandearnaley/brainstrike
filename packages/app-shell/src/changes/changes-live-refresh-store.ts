import type { ChangesInvalidationEvent } from '@brainstrike/types';
import { create } from 'zustand';

/**
 * Session-lived, NON-persisted state for live Git-scope refresh signals.
 * `use-changes-live-refresh.ts` ingests both the `changes:invalidated` push
 * channel (git metadata) and the renderer's canonical root-scoped file
 * explorer refresh event (working-tree content), then data hooks derive
 * refetch nonces:
 *
 * - `useGitInventory` refetches on ANY accepted GIT-METADATA event
 *   (`anyInvalidationNonce`) — working-tree content cannot change repository
 *   topology and must not defeat deferred inventory loading.
 * - `useChangeset` refetches a `git-scope` changeset only when ITS repository
 *   was invalidated ({@link selectGitScopeRefreshNonce}) — a busy sibling
 *   repo must not churn an unrelated diff view. An event the service could
 *   not map to a repository (`repositoryRoot: null`) conservatively counts
 *   for every repo: a missed refresh is silent staleness, an extra refetch is
 *   just work.
 *
 * The wire `generation` is a per-main-process monotonic send counter;
 * `ingestInvalidation` drops stale/duplicate deliveries so a redundant IPC
 * replay can never double-refetch. A short repository-local cross-source
 * coalescer also prevents one operation observed by BOTH watchers from
 * bumping the repository nonce twice; the git-metadata event still advances
 * `anyInvalidationNonce`, so inventory stays correct. Snapshot-sourced
 * changesets (`agent-run` / `run-range`) never read this store.
 */
export interface ChangesLiveRefreshState {
  /** Bumped on every accepted GIT-METADATA event. `useGitInventory`'s refetch input. */
  readonly anyInvalidationNonce: number;
  /**
   * Ingest one wire event. Drops it when `generation` is not strictly newer
   * than the last accepted one.
   */
  readonly ingestInvalidation: (event: ChangesInvalidationEvent) => void;
  /**
   * Ingest one root-scoped working-tree refresh after renderer-side mapping.
   * This bumps only affected repository view nonces — never inventory.
   */
  readonly ingestWorkingTreeRefresh: (affectedRepositoryRoots: readonly string[]) => void;
  /** Highest wire generation accepted so far (0 = none). */
  readonly lastEventGeneration: number;
  /** Per-repositoryRoot observable refresh nonces. */
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

type RepositoryRefreshSource = 'git-metadata' | 'working-tree';

interface RecentRepositoryRefresh {
  readonly at: number;
  readonly source: RepositoryRefreshSource;
}

/**
 * Both upstream watchers use a 300ms trailing debounce. Matching that window
 * covers the maximum one-debounce scheduling skew while one-to-one marker
 * consumption below prevents a signal cluster from swallowing a third edit.
 */
export const CROSS_SOURCE_REPOSITORY_REFRESH_COALESCE_MS = 300;

const recentRefreshByRepositoryRoot = new Map<string, RecentRepositoryRefresh>();

function pruneExpiredRecentRefreshes(now: number): void {
  for (const [repositoryRoot, recent] of recentRefreshByRepositoryRoot) {
    const age = now - recent.at;
    if (age < 0 || age > CROSS_SOURCE_REPOSITORY_REFRESH_COALESCE_MS) {
      recentRefreshByRepositoryRoot.delete(repositoryRoot);
    }
  }
}

function shouldBumpRepository(
  repositoryRoot: string,
  source: RepositoryRefreshSource,
  now: number
): boolean {
  // Temporal dedupe state is not session history. Keep it proportional to
  // repositories active inside the current coalescing window; the durable
  // nonce map above remains the only session-lived repository record.
  pruneExpiredRecentRefreshes(now);
  const recent = recentRefreshByRepositoryRoot.get(repositoryRoot);
  if (recent && recent.source !== source) {
    const elapsed = now - recent.at;
    if (elapsed >= 0 && elapsed <= CROSS_SOURCE_REPOSITORY_REFRESH_COALESCE_MS) {
      // Consume exactly one opposite-source partner. Do not replace the marker:
      // file → git → file must expose the third (distinct) working-tree event.
      recentRefreshByRepositoryRoot.delete(repositoryRoot);
      return false;
    }
  }
  recentRefreshByRepositoryRoot.set(repositoryRoot, { at: now, source });
  return true;
}

function withKnownRepositoryRoots(
  current: Readonly<Record<string, number>>,
  knownRepositoryRoots: readonly string[],
  initialNonce: number
): Readonly<Record<string, number>> {
  let next: Record<string, number> | null = null;
  for (const repositoryRoot of knownRepositoryRoots) {
    if (current[repositoryRoot] !== undefined || next?.[repositoryRoot] !== undefined) {
      continue;
    }
    next ??= { ...current };
    next[repositoryRoot] = initialNonce;
  }
  return next ?? current;
}

export const useChangesLiveRefreshStore = create<ChangesLiveRefreshState>((set) => ({
  ...INITIAL_STATE,
  ingestInvalidation: (event) =>
    set((state) => {
      if (event.generation <= state.lastEventGeneration) {
        return {};
      }
      const repositoryRoots = event.repositoryRoot === null ? [] : [event.repositoryRoot];
      const knownNonces = withKnownRepositoryRoots(state.nonceByRepositoryRoot, repositoryRoots, 0);
      const shouldBump =
        event.repositoryRoot !== null &&
        shouldBumpRepository(event.repositoryRoot, 'git-metadata', Date.now());
      return {
        anyInvalidationNonce: state.anyInvalidationNonce + 1,
        lastEventGeneration: event.generation,
        ...(event.repositoryRoot === null
          ? { unmappedInvalidationNonce: state.unmappedInvalidationNonce + 1 }
          : {
              nonceByRepositoryRoot: {
                ...knownNonces,
                [event.repositoryRoot]:
                  (knownNonces[event.repositoryRoot] ?? 0) + (shouldBump ? 1 : 0),
              },
            }),
      };
    }),
  ingestWorkingTreeRefresh: (affectedRepositoryRoots) =>
    set((state) => {
      const affected = new Set(affectedRepositoryRoots);
      // Before this root becomes a precise working-tree key, its selector
      // follows `anyInvalidationNonce`. Preserve that observable baseline so
      // registration cannot jump backwards and spuriously refetch a sibling.
      const knownNonces = withKnownRepositoryRoots(
        state.nonceByRepositoryRoot,
        [...affected],
        state.anyInvalidationNonce
      );
      if (affected.size === 0) {
        return knownNonces === state.nonceByRepositoryRoot
          ? {}
          : { nonceByRepositoryRoot: knownNonces };
      }
      const now = Date.now();
      const nextNonces = { ...knownNonces };
      for (const repositoryRoot of affected) {
        if (shouldBumpRepository(repositoryRoot, 'working-tree', now)) {
          nextNonces[repositoryRoot] = (nextNonces[repositoryRoot] ?? 0) + 1;
        }
      }
      return { nonceByRepositoryRoot: nextNonces };
    }),
  reset: () => {
    recentRefreshByRepositoryRoot.clear();
    set(INITIAL_STATE);
  },
}));

/**
 * The refetch nonce for one repository's `git-scope` changeset views.
 *
 * A repositoryRoot that has appeared in at least one mapped event is a KNOWN
 * key: its nonce is its repository-local refresh sequence plus every unmapped
 * event (see the store doc comment for why unmapped events count for every
 * repo).
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
