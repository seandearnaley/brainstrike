/**
 * Everything the Worktree Map renders, composed from surfaces that already
 * exist. The ONLY new read is `worktrees.list()`; the PR pills, thread
 * occupancy, run state and indexing opt-ins all come from live queries and
 * stores the app already maintains for other surfaces, so the Map can never
 * disagree with the composer chip or the thread list about the same fact.
 *
 * Refresh is EVENT-TRIGGERED, exactly like W4's forge reads: the shared
 * `changes:invalidated` nonce (`anyInvalidationNonce`) is the only repeat
 * trigger, plus an explicit user refresh. No timer.
 */
import { useBackgroundIndexingPreferencesStore } from '@brainstrike/app-state/stores/background-indexing-preferences-store';
import { type AssistantMemoryThread, useAssistantThreadStore } from '@brainstrike/assistant-data';
import type { DbHandle } from '@brainstrike/db/react';
import { createLogger } from '@brainstrike/logging';
import type { WorktreeListEntry } from '@brainstrike/types';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChangesLiveRefreshStore } from '../changes/changes-live-refresh-store';
import { useChangesLiveRefreshSubscription } from '../changes/use-changes-live-refresh';
import { useForgePrCache } from '../hooks/use-forge-pr-cache';
import { useOptionalRootIdentity } from '../roots/root-identity-context';
import { resolveWorktreesBridge } from '../worktrees/worktrees-bridge';
import {
  useWorktreeCheckoutStatuses,
  type WorktreeCheckoutStatusState,
} from './use-worktree-checkout-status';
import { buildWorktreeMap, type WorktreeMapRepositoryModel } from './worktree-map-model';

const logger = createLogger('WorktreeMap');

/**
 * Module scope, ABOVE the hook: a zustand selector that allocated `[]` inline
 * would return a fresh array identity on every render and re-run every
 * downstream `useMemo` forever (the identity-churn class recorded in
 * `project_file_tree_perf`). Declared before its only reader so the reference
 * is initialized when the hook first runs, never in a TDZ window.
 */
const EMPTY_THREADS: readonly AssistantMemoryThread[] = [];

export interface UseWorktreeMapInput {
  /** `null` until the PGlite handle resolves; the PR-cache query stays disabled. */
  readonly database: DbHandle | null;
  readonly resourceId: string;
  readonly runningThreadIds: ReadonlySet<string>;
}

export interface WorktreeMapState {
  readonly error: string | null;
  readonly loading: boolean;
  readonly refresh: () => Promise<void>;
  readonly repositories: readonly WorktreeMapRepositoryModel[];
  readonly statusByPath: ReadonlyMap<string, WorktreeCheckoutStatusState>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useWorktreeMap(input: UseWorktreeMapInput): WorktreeMapState {
  const bridge = useMemo(() => resolveWorktreesBridge(), []);
  const [entries, setEntries] = useState<readonly WorktreeListEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [manualNonce, setManualNonce] = useState(0);

  // Hold the shared dual-source live-refresh owner while the Map is mounted;
  // no Git-scope registration, because the Map is repository-wide.
  useChangesLiveRefreshSubscription();
  const invalidationNonce = useChangesLiveRefreshStore((state) => state.anyInvalidationNonce);
  // The two nonce consumers deliberately see DIFFERENT triggers. The load
  // effect keys on `invalidationNonce` only: the manual `refresh()` already
  // gets its list read from the `load()` it awaits, so folding `manualNonce`
  // into the effect key would issue a second concurrent `worktrees.list()`
  // per manual refresh (PR #2671 review note 3). The status reads key on the
  // combined nonce because they have no other manual-refresh path — the bump
  // is what re-runs `git status` per card. Known cost (PR #2673 review): the
  // bump re-keys against the PRE-refresh path set; if the awaited list then
  // changes the paths, the status effect runs once more on the new content.
  const refreshNonce = invalidationNonce + manualNonce;
  // Third repeat trigger (PR #2671 review finding): mounting a checkout as a
  // workspace root does NOT write the `roots` row the entries' `rootId`
  // resolves from — the row lands later, in the fire-and-forget mid-session
  // registration (`performRootRegistration`), whose completion emits no
  // `changes:invalidated`. A caller-side refresh right after the mount promise
  // therefore races the write and usually re-reads `rootId: null`. The
  // canonical mapping publication IS the deterministic post-write signal:
  // `RootIdentityProvider` re-memoizes its context value only when a new
  // adapter→DB pair lands (after `reconcileRoots` wrote the row), so keying
  // the load effect on it re-reads exactly when the row provably exists —
  // for mounts started from ANY surface, not just this Map. `null` (web, or
  // no provider above) is honest absence: no extra trigger, never a stub.
  const rootIdentity = useOptionalRootIdentity();

  // Superseded-read guard (PR #2673 review): with `manualNonce` out of the
  // load effect's key, a manual refresh no longer tears down an in-flight
  // effect-driven read via the effect cleanup, so an older `list()` resolving
  // late could overwrite a fresher result last-writer-wins. Every `load()`
  // claims a generation at call time; a resolution whose generation is no
  // longer current discards itself, making the ordering last-STARTED-wins.
  const listGeneration = useRef(0);

  const load = useCallback(
    // A `.then()` chain, not `async`/`await`: an `async` function's body runs
    // SYNCHRONOUSLY up to its first `await`, so `setLoading(true)` would fire
    // in the SAME tick as whichever caller invoked this — including the mount
    // effect below, which is exactly what `react-hooks/set-state-in-effect`
    // flags. Chaining on `Promise.resolve()` instead defers every state
    // update to a real microtask, matching `use-worktree-mode.ts`'s
    // `refreshList` shape (this hook's other caller, the manual `refresh()`
    // below, is an event handler, where the one-microtask delay is
    // unobservable either way).
    (isCancelled?: () => boolean): Promise<void> => {
      // Claimed synchronously, before the deferred chain: a later load() call
      // from EITHER caller supersedes this one the moment it starts.
      const mine = ++listGeneration.current;
      const stale = (): boolean => mine !== listGeneration.current || isCancelled?.() === true;
      return Promise.resolve()
        .then(() => {
          if (!bridge) {
            setLoading(false);
            return null;
          }
          setLoading(true);
          return bridge.list();
        })
        .then((result) => {
          if (result === null || stale()) {
            return;
          }
          if (result.ok) {
            setEntries(result.value);
            setError(null);
            return;
          }
          // A failed list is a stated failure, never an empty Map: an empty
          // Map is the honest rendering of "no worktrees", a different fact.
          setEntries([]);
          setError(result.error);
        })
        .catch((caught: unknown) => {
          logger.error('worktree map list threw', { error: caught });
          if (!stale()) {
            setEntries([]);
            setError(errorMessage(caught));
          }
        })
        .finally(() => {
          if (!stale()) {
            setLoading(false);
          }
        });
    },
    [bridge]
  );

  useEffect(() => {
    let cancelled = false;
    void load(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [load, invalidationNonce, rootIdentity]);

  const prCache = useForgePrCache({ database: input.database, enabled: bridge !== null });
  const threads = useAssistantThreadStore(
    (state) => state.threadsByResourceId[input.resourceId] ?? EMPTY_THREADS
  );
  const indexingOptInByRootId = useBackgroundIndexingPreferencesStore(
    (state) => state.worktreeRootIndexingOptInById
  );

  const repositories = useMemo(
    () =>
      buildWorktreeMap({
        entries,
        indexingOptInByRootId,
        prCache: prCache.byRepoBranch,
        runningThreadIds: input.runningThreadIds,
        threads,
      }),
    [entries, indexingOptInByRootId, prCache.byRepoBranch, input.runningThreadIds, threads]
  );

  const paths = useMemo(
    () =>
      repositories.flatMap((repository) =>
        repository.cards
          // A ghost row has no directory to run git in; asking would produce a
          // confusing "not a git repository" beside a card that already says
          // "missing on disk".
          .filter((card) => card.entry.provenance !== 'agent-reported')
          .map((card) => card.entry.path)
      ),
    [repositories]
  );
  const statusByPath = useWorktreeCheckoutStatuses({ bridge, paths, refreshNonce });

  const refresh = useCallback(async (): Promise<void> => {
    // The awaited load IS the list read; the bump only re-keys the status
    // reads (the load effect does not see `manualNonce` — see `refreshNonce`).
    setManualNonce((previous) => previous + 1);
    await load();
  }, [load]);

  return {
    error:
      error ?? (prCache.error ? `Pull-request cache unavailable: ${prCache.error.message}` : null),
    loading,
    refresh,
    repositories,
    statusByPath,
  };
}
