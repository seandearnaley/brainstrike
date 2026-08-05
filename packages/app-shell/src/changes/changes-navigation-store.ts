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
 *
 * `activeWorkspacePanelTab`/`changesTabMounted` own WHICH tab of the
 * workspace panel (`workspace-panel-tabs.tsx`) is showing. React Doctor
 * flagged an earlier shape of this fix (BST-1114 smoke feedback,
 * `no-adjust-state-on-prop-change`): `WorkspacePanelTabs` held its own
 * `activeTab` local state and used a `useEffect` watching a bumped
 * `openRequestId` counter to sync it — the classic "adjust state after a
 * prop changes" bug, which paints one stale frame of the previous tab before
 * the effect corrects it. The fix is the same one this store already applied
 * to `activeChangeset` above: ONE owned value, written directly by every
 * event that changes it (`openChangeset` for the external "→ Review" handoff,
 * `setActiveWorkspacePanelTab` for the user's own tab click) instead of one
 * component deriving its state from another's.
 */
export interface ChangesHandoffThreadIdentity {
  readonly latestRunId: string;
  readonly threadId: string;
}

/** Which tab of the workspace panel is active — see this file's doc comment. */
export type WorkspacePanelTab = 'changes' | 'context-explorer';

export interface ChangesNavigationState {
  /** The changeset the surface is showing, or `null` before anything is picked. */
  readonly activeChangeset: Changeset | null;
  /**
   * Which workspace-panel tab is currently shown. Defaults to
   * `'context-explorer'`. Written directly by `setActiveWorkspacePanelTab`
   * (the user's own click) and by `openChangeset` (an external "→ Review"
   * handoff) — never derived from a prop inside `WorkspacePanelTabs` itself.
   */
  readonly activeWorkspacePanelTab: WorkspacePanelTab;
  /**
   * Once the Changes tab has been shown at least once, its content stays
   * mounted (mirrors the old `KeepMountedRoute` contract for the top-level
   * Changes route this replaced) so switching away and back doesn't lose the
   * surface's scroll/selection state. Sticky: sets to `true` and never back
   * to `false` outside of `reset()`.
   */
  readonly changesTabMounted: boolean;
  /** Thread/run identity from the most recent `agent-run` handoff, if any. */
  readonly handoffThreadIdentity: ChangesHandoffThreadIdentity | null;
  /**
   * Show `changeset` on the Changes surface AND switch the workspace panel
   * to the Changes tab. Used ONLY by external entry points — today the
   * assistant turn footer's "→ Review" link (BST-1114 smoke feedback:
   * `useChangesReviewValue` in `root-layout-content.tsx`) and the git
   * panel's worktree dropdown (BST-1116 W6, `git-workbench-header.tsx`).
   * Both pair this call with a SHELL-route switch to `explorer` via
   * `usePanelLayoutStore.setActiveTab`, since the workspace panel only
   * exists on that route; this action owns only the panel-tab half. Sets
   * `activeWorkspacePanelTab: 'changes'` UNCONDITIONALLY on every call, so a
   * second "Review" click for the same changeset still re-activates the tab
   * even if the user had since clicked back to Context Explorer — no
   * separate "did this already fire" counter needed, because the write is
   * direct and idempotent-safe (re-setting an already-active tab to the same
   * value is simply a no-op re-render, not a bug).
   */
  readonly openChangeset: (changeset: Changeset) => void;
  /**
   * Show `changeset` on the Changes surface, WITHOUT switching the workspace
   * panel tab. Used by the surface's own internal source picker — it only
   * fires while the surface is already visible, so there is nothing to
   * switch to.
   */
  readonly requestChangeset: (changeset: Changeset) => void;
  /**
   * Factory-reset entry point (AGENTS.md invariant: "Any new persistent
   * store/state must be wired into factory reset"). Without a reload, a
   * surviving `activeChangeset`/`handoffThreadIdentity` would keep pointing
   * at a runId/threadId or an absolute repository path the reset just wiped.
   */
  readonly reset: () => void;
  /** Switch the workspace panel to `tab`. The user's own tab-click event. */
  readonly setActiveWorkspacePanelTab: (tab: WorkspacePanelTab) => void;
}

export const useChangesNavigationStore = create<ChangesNavigationState>((set, get) => ({
  activeChangeset: null,
  activeWorkspacePanelTab: 'context-explorer',
  changesTabMounted: false,
  handoffThreadIdentity: null,
  openChangeset: (changeset) => {
    get().requestChangeset(changeset);
    set({ activeWorkspacePanelTab: 'changes', changesTabMounted: true });
  },
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
  reset: () =>
    set({
      activeChangeset: null,
      activeWorkspacePanelTab: 'context-explorer',
      changesTabMounted: false,
      handoffThreadIdentity: null,
    }),
  setActiveWorkspacePanelTab: (tab) =>
    set((state) => ({
      activeWorkspacePanelTab: tab,
      changesTabMounted: state.changesTabMounted || tab === 'changes',
    })),
}));
