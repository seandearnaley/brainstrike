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
 * Generation-guarded loads copy the discipline from `use-edit-checkpoints.ts`:
 * the generation counter increments BEFORE the await, is captured, and every
 * `setState` (including error branches) is guarded against a stale resolve —
 * while the internal loader still RETURNS its result to the caller regardless
 * of staleness, mirroring `loadEntries`/`refetch` there.
 *
 * STRUCTURAL `changeset` IDENTITY (review finding): `changeset` used to be
 * compared by REFERENCE in `loadView`/`fileDiff`'s dependency arrays. A
 * caller that builds an inline literal on every render — the natural way to
 * call this hook, e.g. `useChangeset(rootId, { kind: 'agent-run', runId,
 * threadId })` — would otherwise get a NEW object identity every render, and
 * a successful load's own `setView` triggers exactly such a re-render:
 * `useEffect` fires on `refresh` → `loadView` → the new literal, never
 * settling. Fixed by `stableChangeset`, a `useMemo` keyed on `changesetKey`
 * (a `JSON.stringify`, `null` when `changeset` is `null`): `useMemo` returns
 * its PREVIOUS result whenever the dep array is unchanged, so a fresh
 * literal with the SAME shape reuses the prior render's reference instead of
 * producing a new one. `loadView`/`fileDiff` depend on `stableChangeset`
 * directly (not a ref written during render, which React can replay or
 * discard mid-render — this stays a pure render-time computation).
 */
import { createLogger } from '@brainstrike/logging';
import type { Changeset, ChangesetView, GitResult, StructuredFileDiff } from '@brainstrike/types';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { resolveChangesBridge } from './changes-bridge';

const logger = createLogger('UseChangeset');

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

  // STRUCTURAL identity — see this module's doc comment. `changesetKey` is
  // recomputed every render (cheap); `stableChangeset` is not — `useMemo`
  // returns the PREVIOUS render's `changeset` whenever `changesetKey` is
  // unchanged, so a structurally-equal fresh literal settles onto one stable
  // reference instead of producing a new one every render.
  const changesetKey = changeset === null ? null : JSON.stringify(changeset);
  const stableChangeset = useMemo(() => changeset, [changesetKey]);

  const loadView = useCallback(async (): Promise<GitResult<ChangesetView> | null> => {
    generationRef.current += 1;
    const generation = generationRef.current;
    if (!(bridge && rootId && stableChangeset)) {
      if (generation === generationRef.current) {
        setView(null);
        setError(null);
      }
      return null;
    }
    try {
      const result = await bridge.resolveView(rootId, stableChangeset);
      if (generation === generationRef.current) {
        if (result.ok) {
          setView(result.value);
          setError(null);
        } else {
          setView(null);
          setError(result.error);
        }
      }
      return result;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      logger.error('Failed to resolve changeset view', { error: caught });
      if (generation === generationRef.current) {
        setView(null);
        setError(message);
      }
      return { error: message, ok: false };
    }
  }, [bridge, rootId, stableChangeset]);

  const refresh = useCallback(async (): Promise<void> => {
    await loadView();
  }, [loadView]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
        return await bridge.fileDiff(resolvedRootId, stableChangeset, path);
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
