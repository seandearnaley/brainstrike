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
   * Show `changeset` on the Changes surface AND ask whatever is hosting the
   * surface to switch to it. Used ONLY by external entry points — currently
   * the assistant turn footer's "→ Review" link (BST-1114 smoke feedback:
   * `useChangesReviewValue` in `root-layout-content.tsx`) — since the Changes
   * surface now lives as a tab inside the workspace panel
   * (`workspace-panel-tabs.tsx`), not its own top-level route, and that tab
   * host has no other way to learn "an external caller wants the Changes tab
   * open" than watching this store.
   *
   * Bumps {@link ChangesNavigationState.openRequestId} in addition to setting
   * `activeChangeset` (via `requestChangeset`) so a second "Review" click on
   * the SAME changeset still re-triggers the tab switch: zustand's `set`
   * always produces a fresh state slice, but `activeChangeset`'s value can be
   * referentially unchanged (re-requesting the same object), and a consumer
   * diffing on `activeChangeset` alone would treat that as a no-op. The
   * monotonically increasing token has no such ambiguity.
   */
  readonly openChangeset: (changeset: Changeset) => void;
  /**
   * Bumped by every {@link ChangesNavigationState.openChangeset} call —
   * never by `requestChangeset`. See `openChangeset`'s doc comment for why a
   * separate counter exists instead of diffing `activeChangeset`.
   */
  readonly openRequestId: number;
  /**
   * Show `changeset` on the Changes surface, WITHOUT requesting a tab switch.
   * Used by the surface's own internal source picker — it only fires while
   * the surface is already visible, so there is nothing to switch to.
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

export const useChangesNavigationStore = create<ChangesNavigationState>((set, get) => ({
  activeChangeset: null,
  handoffThreadIdentity: null,
  openChangeset: (changeset) => {
    get().requestChangeset(changeset);
    set((state) => ({ openRequestId: state.openRequestId + 1 }));
  },
  openRequestId: 0,
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
  reset: () => set({ activeChangeset: null, handoffThreadIdentity: null, openRequestId: 0 }),
}));
