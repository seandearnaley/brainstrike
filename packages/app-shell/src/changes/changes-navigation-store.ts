import type { Changeset } from '@brainstrike/types';
import { create } from 'zustand';

/**
 * Session-lived, NON-persisted state for WHICH changeset the Changes surface
 * is showing (BST-1114), plus the thread identity a navigation handoff
 * carried.
 *
 * The active changeset lives here rather than in `ChangesSurface`'s local
 * state on purpose. There is no route-params concept in this app, so an
 * external caller — the assistant turn footer's "→ Review" link — needs a way
 * to say "show this changeset" before switching the panel tab
 * (`quick-open-host.tsx` sets the same two-step precedent). The earlier shape
 * of this store held a separate `pendingChangeset` that the surface copied
 * into its own `useState` inside an effect. That made the store and the
 * component two sources of truth for one fact, needed a consume-and-clear
 * dance so a stale handoff could not silently re-apply on a later tab switch,
 * and put a `setState` inside an effect. One value, written by both the
 * picker and the handoff, has none of those problems.
 *
 * `handoffThreadIdentity` records the thread/run a handoff carried. It
 * deliberately OUTLIVES the changeset that produced it, so the surface can
 * keep offering "Last Turn" and run-range selection after the user moves on
 * to a git scope. It is only ever populated from a real `agent-run`
 * changeset, never synthesised — the surface has no other way to learn a
 * thread id, and inventing one would violate NO SILENT FALLBACKS.
 */
export interface ChangesHandoffThreadIdentity {
  readonly latestRunId: string;
  readonly threadId: string;
}

export interface ChangesNavigationState {
  /** The changeset the surface is showing, or `null` before anything is picked. */
  readonly activeChangeset: Changeset | null;
  /** Thread/run identity from the most recent `agent-run` handoff, if any. */
  readonly handoffThreadIdentity: ChangesHandoffThreadIdentity | null;
  /**
   * Show `changeset` on the Changes surface. Used by the surface's own source
   * picker AND by external entry points, which call this and then switch the
   * active panel tab to `'changes'`.
   */
  readonly requestChangeset: (changeset: Changeset) => void;
  /**
   * Factory-reset entry point (AGENTS.md invariant: "Any new persistent
   * store/state must be wired into factory reset"). Without a reload, a
   * surviving `activeChangeset`/`handoffThreadIdentity` would keep pointing
   * at a runId/threadId or an absolute repository path the reset just wiped.
   */
  readonly reset: () => void;
}

export const useChangesNavigationStore = create<ChangesNavigationState>((set) => ({
  activeChangeset: null,
  handoffThreadIdentity: null,
  requestChangeset: (changeset) =>
    set(
      changeset.kind === 'agent-run'
        ? {
            activeChangeset: changeset,
            handoffThreadIdentity: {
              latestRunId: changeset.runId,
              threadId: changeset.threadId,
            },
          }
        : { activeChangeset: changeset }
    ),
  reset: () => set({ activeChangeset: null, handoffThreadIdentity: null }),
}));
