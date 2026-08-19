import { createLogger } from '@brainstrike/logging';
import type { ChangesInvalidationEvent } from '@brainstrike/types';
import { create } from 'zustand';

const logger = createLogger('ChangesLiveRefreshStore');

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
 * replay can never double-refetch. Repository view evidence from both sources
 * enters one bounded trailing batch: nothing is discarded, and a refetch
 * lands after the latest signal in the batch. The git-metadata event still
 * advances `anyInvalidationNonce` immediately, so inventory stays correct.
 * Snapshot-sourced changesets (`agent-run` / `run-range`) never read this
 * store.
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
  /** Git-metadata refresh nonces keyed only by wire `repositoryRoot`. */
  readonly metadataNonceByRepositoryRoot: Readonly<Record<string, number>>;
  /**
   * Factory-reset entry point (AGENTS.md invariant). Also restarts the wire
   * guard, so a main process re-numbering from 1 is not dropped.
   */
  readonly reset: () => void;
  /** Accepted events the service could not map to a repositoryRoot. */
  readonly unmappedInvalidationNonce: number;
  /** Renderer working-tree refresh nonces keyed by the registered presentation string. */
  readonly workingTreeNonceByRepositoryRoot: Readonly<Record<string, number>>;
}

const INITIAL_STATE = {
  anyInvalidationNonce: 0,
  lastEventGeneration: 0,
  metadataNonceByRepositoryRoot: {},
  unmappedInvalidationNonce: 0,
  workingTreeNonceByRepositoryRoot: {},
} as const;

interface PendingRepositoryRefreshBatch {
  firstQueuedAt: number;
  metadataCount: number;
  timer: ReturnType<typeof setTimeout> | null;
  workingTreeCount: number;
}

/**
 * Both upstream watchers use a 300ms trailing debounce. Matching that window
 * lets their deliveries join one renderer batch; the max wait guarantees a
 * continuously busy repository still publishes view evidence once per second.
 */
export const REPOSITORY_REFRESH_BATCH_MS = 300;
export const REPOSITORY_REFRESH_MAX_WAIT_MS = 1000;

export const useChangesLiveRefreshStore = create<ChangesLiveRefreshState>((set) => {
  const pendingByRepositoryRoot = new Map<string, PendingRepositoryRefreshBatch>();

  const flushRepository = (repositoryRoot: string): void => {
    const pending = pendingByRepositoryRoot.get(repositoryRoot);
    if (!pending) {
      return;
    }
    pendingByRepositoryRoot.delete(repositoryRoot);
    set((state) => {
      const updates: {
        metadataNonceByRepositoryRoot?: ChangesLiveRefreshState['metadataNonceByRepositoryRoot'];
        workingTreeNonceByRepositoryRoot?: ChangesLiveRefreshState['workingTreeNonceByRepositoryRoot'];
      } = {};
      if (pending.metadataCount > 0) {
        const currentMetadataNonce = state.metadataNonceByRepositoryRoot[repositoryRoot];
        if (currentMetadataNonce === undefined) {
          // Defensive invariant only: mapped metadata ingestion synchronously
          // seeds this baseline before queueing. If external state mutation
          // violates it, the accepted event is still represented by
          // anyInvalidationNonce's conservative unknown-key selector. Log
          // loudly, keep the key unknown, and continue so a working-tree count
          // sharing this timer is never lost to an ownerless callback throw.
          logger.error(
            'changes live-refresh metadata baseline missing; retaining conservative unknown-key coverage',
            { repositoryRoot }
          );
        } else {
          updates.metadataNonceByRepositoryRoot = {
            ...state.metadataNonceByRepositoryRoot,
            [repositoryRoot]: currentMetadataNonce + pending.metadataCount,
          };
        }
      }
      if (pending.workingTreeCount > 0) {
        updates.workingTreeNonceByRepositoryRoot = {
          ...state.workingTreeNonceByRepositoryRoot,
          [repositoryRoot]:
            (state.workingTreeNonceByRepositoryRoot[repositoryRoot] ?? 0) +
            pending.workingTreeCount,
        };
      }
      return updates;
    });
  };

  const queueRepositoryRefresh = (
    repositoryRoot: string,
    source: 'git-metadata' | 'working-tree'
  ): void => {
    const now = Date.now();
    const existing = pendingByRepositoryRoot.get(repositoryRoot);
    const pending =
      existing ??
      ({
        firstQueuedAt: now,
        metadataCount: 0,
        timer: null,
        workingTreeCount: 0,
      } satisfies PendingRepositoryRefreshBatch);
    if (existing) {
      if (existing.timer !== null) {
        clearTimeout(existing.timer);
      }
      if (now < existing.firstQueuedAt) {
        existing.firstQueuedAt = now;
      }
    }
    if (source === 'git-metadata') {
      pending.metadataCount += 1;
    } else {
      pending.workingTreeCount += 1;
    }
    const elapsed = Math.max(0, now - pending.firstQueuedAt);
    const delay = Math.min(
      REPOSITORY_REFRESH_BATCH_MS,
      Math.max(0, REPOSITORY_REFRESH_MAX_WAIT_MS - elapsed)
    );
    pending.timer = setTimeout(() => flushRepository(repositoryRoot), delay);
    pendingByRepositoryRoot.set(repositoryRoot, pending);
  };

  return {
    ...INITIAL_STATE,
    ingestInvalidation: (event) => {
      let mappedRepositoryRoot: string | null = null;
      set((state) => {
        if (event.generation <= state.lastEventGeneration) {
          return {};
        }
        mappedRepositoryRoot = event.repositoryRoot;
        const acceptedEventState = {
          anyInvalidationNonce: state.anyInvalidationNonce + 1,
          lastEventGeneration: event.generation,
        };
        if (event.repositoryRoot === null) {
          return {
            ...acceptedEventState,
            unmappedInvalidationNonce: state.unmappedInvalidationNonce + 1,
          };
        }
        if (state.metadataNonceByRepositoryRoot[event.repositoryRoot] !== undefined) {
          return acceptedEventState;
        }
        // Mark only the WIRE string metadata-known, at its old unknown-key
        // observable baseline. Known selectors add the unmapped nonce back,
        // so exclude it here; the queued mapped evidence then produces exactly
        // one repository notification.
        return {
          ...acceptedEventState,
          metadataNonceByRepositoryRoot: {
            ...state.metadataNonceByRepositoryRoot,
            [event.repositoryRoot]: state.anyInvalidationNonce - state.unmappedInvalidationNonce,
          },
        };
      });
      if (mappedRepositoryRoot !== null) {
        queueRepositoryRefresh(mappedRepositoryRoot, 'git-metadata');
      }
    },
    ingestWorkingTreeRefresh: (affectedRepositoryRoots) => {
      for (const repositoryRoot of new Set(affectedRepositoryRoots)) {
        queueRepositoryRefresh(repositoryRoot, 'working-tree');
      }
    },
    reset: () => {
      for (const pending of pendingByRepositoryRoot.values()) {
        if (pending.timer !== null) {
          clearTimeout(pending.timer);
        }
      }
      pendingByRepositoryRoot.clear();
      set(INITIAL_STATE);
    },
  };
});

/**
 * The refetch nonce for one repository's `git-scope` changeset views.
 *
 * A repositoryRoot that has appeared in at least one mapped METADATA event is
 * a metadata-known key. Renderer working-tree keys are deliberately separate:
 * observing `/presentation/repo` locally must not stop a later canonical wire
 * event for `/real/repo` from reaching that unknown metadata consumer.
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
    | 'anyInvalidationNonce'
    | 'metadataNonceByRepositoryRoot'
    | 'unmappedInvalidationNonce'
    | 'workingTreeNonceByRepositoryRoot'
  >,
  repositoryRoot: string
): number {
  const metadataNonce = state.metadataNonceByRepositoryRoot[repositoryRoot];
  const metadataRefreshNonce =
    metadataNonce === undefined
      ? state.anyInvalidationNonce
      : metadataNonce + state.unmappedInvalidationNonce;
  return metadataRefreshNonce + (state.workingTreeNonceByRepositoryRoot[repositoryRoot] ?? 0);
}
