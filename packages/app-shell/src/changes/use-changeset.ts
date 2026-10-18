/**
 * `useChangeset` (BST-1113, W3 Task 4): resolve a `Changeset` to its
 * `ChangesetView` via the desktop `window.changes` bridge, plus a lazy
 * per-file `fileDiff(path)` loader.
 *
 * Bridge-gated: `resolveChangesBridge()` is resolved ONCE per hook instance
 * (`useMemo` with an empty dependency array) rather than on every render —
 * `isChangesBridgeAvailable()` re-resolves (and, on a malformed bridge,
 * re-LOGS) on every call, which is a known wart of that helper this hook
 * deliberately avoids by holding its own resolved reference.
 *
 * `refresh`/`view`/`error` are also inert (no-ops, `null`) whenever `rootId`
 * or `changeset` is `null` — there is nothing to load, so no fetch fires and
 * no state churns. `available` reflects ONLY the bridge's presence (per the
 * plan), independent of whether a changeset is currently selected.
 *
 * Generation-guarded loads: the generation counter increments BEFORE the
 * await, is captured, and every `setState` (including error branches) is
 * guarded against a stale resolve — while the internal loader still RETURNS
 * its result to the caller regardless of staleness.
 *
 * STRUCTURAL `changeset` IDENTITY (review finding): `changeset` used to be
 * compared by REFERENCE in `loadView`/`fileDiff`'s dependency arrays. A
 * caller that builds an inline literal on every render — the natural way to
 * call this hook, e.g. `useChangeset(rootId, { kind: 'agent-run', runId,
 * threadId })` — would otherwise get a NEW object identity every render, and
 * a successful load's own `setView` triggers exactly such a re-render:
 * `useEffect` fires on `refresh` → `loadView` → the new literal, never
 * settling. Fixed by `stableChangeset` (`useStructuralIdentity`): a fresh
 * literal with the SAME JSON shape reuses the first reference seen for that
 * shape instead of producing a new one. `loadView`/`fileDiff` depend on
 * `stableChangeset` directly (not a ref written during render, which React can
 * replay or discard mid-render).
 *
 * NO ETERNAL LOADING (BST-1115 smoke feedback — the reported "Last Turn sticks
 * on 'Loading changed files…'"). `ChangesSurface` derives its loading state as
 * "a changeset is selected, `view` is null, and `error` is null", so EVERY way
 * this hook can leave both `view` and `error` null while a changeset IS
 * selected paints an indefinite spinner with no explanation and no retry.
 * There were two such ways, and both are now closed:
 *
 * 1. INERT WITH A SELECTION. A missing bridge, or no root able to resolve the
 *    changeset, used to set `view: null, error: null` and return — the honest
 *    "nothing to load" when `changeset === null`, but a silent dead end once
 *    the user HAS picked something. Those cases now set a typed error naming
 *    the missing input (`changeset-unavailable:` / `changeset-unresolvable:`).
 *    Reachable today: a `git-scope` changeset for a worktree with no
 *    containing workspace root resolves to a null `resolutionRootId` while the
 *    surface's own `rootId` stays non-null, so the panes render and wait.
 * 2. A CALL THAT NEVER ANSWERS. `bridge.resolveView` is a main-process
 *    round-trip that reaches PGlite through the DB host. When that host is
 *    wedged (observed in the field: a 30s `VACUUM (ANALYZE)` blowing its own
 *    timeout, every later query queued behind it) the desktop side eventually
 *    rejects with its own 30s per-request timeout — but nothing in the
 *    RENDERER bounded the wait, so a main process that never answers at all
 *    left the surface loading forever. Every resolve is now raced against
 *    {@link RESOLVE_VIEW_TIMEOUT_MS} and a lapsed race is a typed error with
 *    the same Retry affordance as any other failure. That bound deliberately
 *    sits ABOVE the desktop's own 30s timeout: when main is merely slow it
 *    still wins and reports the REAL reason; this only speaks when nothing
 *    answers at all.
 */
import { createLogger } from '@brainstrike/logging';
import type { Changeset, ChangesetView, GitResult, StructuredFileDiff } from '@brainstrike/types';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type ChangesBridge, resolveChangesBridge } from './changes-bridge';
import {
  selectGitScopeRefreshNonce,
  useChangesLiveRefreshStore,
} from './changes-live-refresh-store';
import { useChangesNavigationStore } from './changes-navigation-store';
import { useRewindStore } from './rewind-store';
import { useChangesLiveRefreshSubscription } from './use-changes-live-refresh';
import { useStructuralIdentity } from './use-structural-identity';

const logger = createLogger('UseChangeset');

/**
 * How long the renderer waits for a `changes:resolveView` round-trip before
 * reporting an honest timeout. Above the desktop DB host's own 30s
 * per-request timeout (`DbHostManager`) so a slow-but-answering main process
 * still reports its real failure and this bound only fires when nothing
 * answers — see this module's "NO ETERNAL LOADING" note.
 */
export const RESOLVE_VIEW_TIMEOUT_MS = 45_000;

const RESOLVE_VIEW_TIMEOUT_ERROR = `changeset-resolve-timeout: the changes service did not answer within ${Math.round(
  RESOLVE_VIEW_TIMEOUT_MS / 1000
)}s. It may be busy with a long-running database operation.`;

/**
 * Race `pending` against a timer, resolving to a typed timeout failure rather
 * than leaving the caller waiting forever. The timer is always cleared, so a
 * settled call never leaves a pending handle behind.
 */
async function withResolveTimeout(
  pending: Promise<GitResult<ChangesetView>>
): Promise<GitResult<ChangesetView>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<GitResult<ChangesetView>>((resolve) => {
        timer = setTimeout(() => {
          resolve({ error: RESOLVE_VIEW_TIMEOUT_ERROR, ok: false });
        }, RESOLVE_VIEW_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * One resolve attempt, reduced to a typed result: bounded by
 * {@link RESOLVE_VIEW_TIMEOUT_MS} and with a thrown bridge failure folded into
 * the same `{ ok: false }` shape, so the caller only ever branches on `ok`.
 */
async function resolveViewSafely(
  bridge: ChangesBridge,
  rootId: string,
  changeset: Changeset
): Promise<GitResult<ChangesetView>> {
  try {
    return await withResolveTimeout(bridge.resolveView(rootId, changeset));
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    logger.error('Failed to resolve changeset view', { error: caught });
    return { error: message, ok: false };
  }
}

/**
 * Why an inert hook cannot load the changeset the user HAS selected. Never
 * called with `changeset === null` — that is the one honest "nothing to load"
 * state, and it keeps `error` null.
 */
function describeInertReason(bridgePresent: boolean, rootId: string | null): string {
  if (!bridgePresent) {
    return 'changeset-unavailable: the changes service is not available in this build.';
  }
  if (!rootId) {
    return 'changeset-unresolvable: no workspace root can resolve this changeset. For a Git scope, the worktree is outside every mounted root.';
  }
  return 'changeset-unresolvable: this changeset cannot be resolved right now.';
}

export interface UseChangesetResult {
  /** True when the desktop `window.changes` bridge is present and well-formed. */
  readonly available: boolean;
  /** The most recent load failure, or `null`. Cleared by a successful load. */
  readonly error: string | null;
  /**
   * Lazy per-file diff load — not hook state. Returns a typed failure
   * (never throws) when the bridge, rootId, or changeset is absent.
   *
   * `entryRootId` overrides this hook's own `rootId` for the call — a
   * multi-root `agent-run` turn can edit more than one workspace root in a
   * single run, and `resolveJournalFileDiff` identifies a file by
   * `(rootId, path)`, not `path` alone. Omitted/`null` falls back to the
   * hook's `rootId` (the pre-fix behavior, still correct for a
   * single-root turn or a `git-scope` changeset).
   */
  readonly fileDiff: (
    path: string,
    entryRootId?: string | null
  ) => Promise<GitResult<StructuredFileDiff>>;
  /** Re-resolve the active changeset's view. A no-op when nothing is active. */
  readonly refresh: () => Promise<void>;
  /**
   * `null` means "not yet resolved" (no active changeset/root, bridge
   * absent, or a load still in flight) — NOT the same fact as a resolved
   * view with an empty `files` array, which is an honest "no changes".
   */
  readonly view: ChangesetView | null;
}

export function useChangeset(
  rootId: string | null,
  changeset: Changeset | null
): UseChangesetResult {
  // Resolved ONCE per hook instance, not per render/call — see doc comment.
  const bridge = useMemo(() => resolveChangesBridge(), []);
  const [view, setView] = useState<ChangesetView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);

  // STRUCTURAL identity — see this module's doc comment.
  const stableChangeset = useStructuralIdentity(changeset);

  // REWIND INVALIDATION (BST-1115). A rewind reverts the very files an open
  // changeset describes, so afterwards the SAME `Changeset` value resolves to a
  // DIFFERENT view. Nothing about the changeset itself changes, which is why
  // this is its own input: before it, the Changes surface behind the confirm
  // modal kept listing files the rewind had already put back.
  //
  // It is a DEPENDENCY of `loadView` rather than a second effect: the load
  // belongs to a (changeset, generation) pair, and a bump makes the previous
  // load stale in exactly the way a changeset change does.
  const rewindGeneration = useRewindStore((state) => state.generation);

  // LIVE LAST TURN (BST-1115 smoke feedback): a run writing files while the
  // user watches the Changes surface must grow the list as it goes. The
  // journal rows land in main per edit, so a re-resolve of the SAME changeset
  // returns more files — nothing about the changeset itself changes, which is
  // why (exactly like `rewindGeneration` above) this is its own `loadView`
  // input rather than a second effect. The store only bumps it when the
  // active changeset IS the running thread's Last Turn, so a git scope or a
  // pinned run never refetches behind the user's back.
  const liveRefreshNonce = useChangesNavigationStore((state) => state.liveRefreshNonce);

  // LIVE GIT SCOPE (BST-1161 + BST-1180): the shared renderer subscription
  // consumes both git-metadata pushes and canonical root-scoped file-explorer
  // refresh events. A mounted git scope registers the exact root/repository /
  // worktree tuple needed to map working-tree changes without loading
  // inventory or refreshing an unrelated repository. Snapshot changesets
  // register nothing and pin 0: neither signal can change captured content.
  useChangesLiveRefreshSubscription(
    stableChangeset?.kind === 'git-scope' && rootId
      ? {
          repositoryRoot: stableChangeset.repositoryRoot,
          rootId,
          worktreePath: stableChangeset.worktreePath,
        }
      : null
  );
  const gitInvalidationNonce = useChangesLiveRefreshStore((state) =>
    stableChangeset?.kind === 'git-scope'
      ? selectGitScopeRefreshNonce(state, stableChangeset.repositoryRoot)
      : 0
  );

  const loadView = useCallback(async (): Promise<GitResult<ChangesetView> | null> => {
    generationRef.current += 1;
    const generation = generationRef.current;
    if (!(bridge && rootId && stableChangeset)) {
      if (generation === generationRef.current) {
        setView(null);
        // A selection the hook cannot load is a VISIBLE dead end, never a
        // silent one — see "NO ETERNAL LOADING" in this module's doc comment.
        setError(stableChangeset ? describeInertReason(bridge !== null, rootId) : null);
      }
      return null;
    }
    const result = await resolveViewSafely(bridge, rootId, stableChangeset);
    if (generation === generationRef.current) {
      setView(result.ok ? result.value : null);
      setError(result.ok ? null : result.error);
    }
    return result;
  }, [bridge, rootId, stableChangeset]);

  const refresh = useCallback(async (): Promise<void> => {
    await loadView();
  }, [loadView]);

  // The reload signals above re-run the LOAD EFFECT, never `loadView`'s
  // memoization: the shipped renderer is built with the React Compiler, which
  // memoizes a callback on what its body reads, so a signal listed only in a
  // callback's dependencies (as these once were) never re-created it and no
  // bump ever reloaded the view. An effect's dependency array is kept as
  // written.
  useEffect(() => {
    void refresh();
  }, [refresh, gitInvalidationNonce, liveRefreshNonce, rewindGeneration]);

  const fileDiff = useCallback(
    async (path: string, entryRootId?: string | null): Promise<GitResult<StructuredFileDiff>> => {
      const resolvedRootId = entryRootId ?? rootId;
      if (!(bridge && resolvedRootId && stableChangeset)) {
        return {
          error: 'changeset-unavailable: no active bridge, root, or changeset',
          ok: false,
        };
      }
      try {
        const result = await bridge.fileDiff(resolvedRootId, stableChangeset, path);
        if (!result.ok) {
          // The diff card shows a bounded summary and output (BST-2136); the
          // full text lives here.
          logger.warn('File diff failed', { error: result.error, path });
        }
        return result;
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        logger.error('Failed to load file diff', { error: caught, path });
        return { error: message, ok: false };
      }
    },
    [bridge, rootId, stableChangeset]
  );

  return {
    available: bridge !== null,
    error,
    fileDiff,
    refresh,
    view,
  };
}
