import {
  CANVAS_APP_ID,
  CHANGES_APP_ID,
  useWorkspaceTabSelectionStore,
} from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
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
 * keep offering run-range selection after the user moves on to a git scope
 * (BST-1114). It is only ever populated from a real `agent-run` changeset,
 * never synthesised — the surface has no other way to learn a thread id, and
 * inventing one would violate NO SILENT FALLBACKS. It is written on every
 * `agent-run` `requestChangeset` call (both the "→ Review" handoff AND the
 * picker's own "Last Turn"/run selections go through it) but nothing reads it
 * for "Last Turn" enablement anymore — see `activeThreadIdentity` below.
 *
 * `activeThreadIdentity` (BST-1115 smoke feedback) is the STANDING scope
 * "Last Turn" needs: Codex parity means the control must work without a
 * Review-link handoff ever happening, and must track the active thread's
 * most recent run live. `AssistantUiPanelWrapper` publishes it directly — on
 * thread selection (`latestRunId: null`, an honest "no completed turns yet"
 * since there is no run-history IPC to hydrate a thread's PAST runs without
 * inventing one — see `ChangesetSourcePicker`'s own doc comment) and on every
 * `run.finished`/`run.failed` event for the active thread. It is a SEPARATE
 * field from `handoffThreadIdentity` on purpose: the handoff's write-once,
 * outlives-the-changeset semantics stay exactly as they were for whatever
 * still reads it, and this field's own reset-on-thread-switch behavior would
 * be wrong for that one.
 *
 * `isOnLastTurn` tracks whether the user's CURRENT selection is "Last Turn"
 * — set by `selectLastTurn`, cleared by `requestChangeset` (any other pick,
 * including a re-pick of the very same run by id). It exists so a live
 * `run.finished` can tell "retarget this" from "leave this alone" WITHOUT
 * comparing run ids: an explicitly pinned run that happens to equal the
 * latest one must never start following new runs just because the ids
 * matched at pin time.
 *
 * `liveRefreshNonce` (BST-1115 smoke feedback: "the ux needs to show changes
 * in real time — we need to review what the agent is doing") is how the
 * Last Turn view GROWS while the run that produced it is still going. The
 * live view diffs the work tree against the turn-start snapshot, so
 * re-resolving the SAME `agent-run` changeset mid-run returns the files
 * edited so far —
 * there is nothing to invent and no new IPC to add. `AssistantUiPanelWrapper`
 * bumps this (throttled) from the renderer's own run stream every time a
 * file-mutation tool completes, and `useChangeset` re-resolves on it exactly
 * as it already does on `useRewindStore`'s generation. NOT polling (the house
 * rule forbids it): the bump is caused by an observed tool completion, so a
 * quiet run costs nothing. NOT a main→renderer push channel either — that is
 * BST-1161's larger job; this is the smallest honest mechanism using a seam
 * the renderer already has.
 *
 * WHICH workspace tab is showing no longer lives here (BST-1258): the unified
 * workspace tab panel owns it in `useWorkspaceTabSelectionStore`
 * (`@brainstrike/file-explorer-ui`), where Changes and Canvas are closable
 * singleton app tabs. `openChangeset`/`openCanvasPanel` route activation
 * through that store's `openApp` — one owned value, written directly by every
 * event that changes it (the React Doctor `no-adjust-state-on-prop-change`
 * ruling that shaped the previous `activeWorkspacePanelTab` field carries
 * over unchanged).
 */
export interface ChangesHandoffThreadIdentity {
  readonly latestRunId: string;
  readonly threadId: string;
}

/**
 * The active thread's standing identity — see `activeThreadIdentity`'s doc
 * comment above. `latestRunId` is `null` until a run has been OBSERVED to
 * finish/fail for this thread in this session.
 */
export interface ChangesActiveThreadIdentity {
  readonly latestRunId: string | null;
  readonly threadId: string;
}

export interface ChangesNavigationState {
  /** The changeset the surface is showing, or `null` before anything is picked. */
  readonly activeChangeset: Changeset | null;
  /** The active thread's standing identity — see this file's doc comment. */
  readonly activeThreadIdentity: ChangesActiveThreadIdentity | null;
  /**
   * Monotonic counter the Canvas panel re-queries on (BST-1173). Bumped by
   * `requestCanvasRefresh` when a `manageCanvas` completion crosses the
   * edit-activity stream — same re-resolve-not-push design as
   * {@link ChangesNavigationState.liveRefreshNonce}.
   */
  readonly canvasRefreshNonce: number;
  /**
   * The canvas the Canvas panel should show, or `null` for the thread's
   * newest. Written by `openCanvas` (a `canvas://` chip on a manageCanvas tool
   * card, via the app-shell link seam) and by the panel's own picker through
   * `selectCanvas`; READ by the panel as derivation — a focused id that is not
   * in the active thread's summaries falls back to the newest, never an
   * effect re-writing state. One owner, so a chip click and the picker cannot
   * disagree.
   */
  readonly focusedCanvasId: string | null;
  /** Thread/run identity from the most recent `agent-run` handoff, if any. */
  readonly handoffThreadIdentity: ChangesHandoffThreadIdentity | null;
  /** Whether the current selection is "Last Turn" — see this file's doc comment. */
  readonly isOnLastTurn: boolean;
  /**
   * Monotonic counter `useChangeset` re-resolves on (BST-1115 smoke feedback:
   * "the ux needs to show changes in real time — we need to review what the
   * agent is doing"). Bumped ONLY by
   * {@link ChangesNavigationState.requestLiveLastTurnRefresh}; see that
   * action's doc comment for the guard and this file's for why the live view
   * is a re-resolve rather than a push channel.
   */
  readonly liveRefreshNonce: number;
  /**
   * Focus `canvasId` AND open/activate the Canvas workspace app tab. External
   * entry points only — the `canvas://<id>` chip. Same unconditional-write
   * reasoning as {@link ChangesNavigationState.openChangeset}: a second click
   * on the same chip still re-activates the tab.
   */
  readonly openCanvas: (canvasId: string) => void;
  /**
   * Open + activate the Canvas workspace app tab (BST-1258: routed through
   * `useWorkspaceTabSelectionStore.openApp`). External entry points only
   * (BST-1173) — e.g. a "canvas updated" affordance near the assistant turn.
   * Same unconditional-write reasoning as {@link ChangesNavigationState.openChangeset}.
   */
  readonly openCanvasPanel: () => void;
  /**
   * Show `changeset` on the Changes surface AND open/activate the Changes
   * workspace app tab. Used ONLY by external entry points — today the
   * assistant turn footer's "→ Review" link (BST-1114 smoke feedback:
   * `useChangesReviewValue` in `root-layout-content.tsx`) and the git
   * panel's worktree dropdown (BST-1116 W6, `git-workbench-header.tsx`).
   * Both pair this call with a SHELL-route switch to `explorer` via
   * `usePanelLayoutStore.setActiveTab`, since the workspace panel only
   * exists on that route; this action owns only the panel-tab half. The tab
   * activation (BST-1258: `useWorkspaceTabSelectionStore.openApp('changes')`)
   * is UNCONDITIONAL on every call, so a second "Review" click for the same
   * changeset still re-activates the tab even if the user had since clicked
   * away — the write is direct and idempotent-safe.
   */
  readonly openChangeset: (changeset: Changeset) => void;
  /** Ask the Canvas panel to re-query because a canvas mutation completed. */
  readonly requestCanvasRefresh: () => void;
  /**
   * Show `changeset` on the Changes surface, WITHOUT switching the workspace
   * panel tab. Used by the surface's own internal source picker — it only
   * fires while the surface is already visible, so there is nothing to
   * switch to. Always clears `isOnLastTurn` — a pick through here (a git
   * scope, or the "→ Review" handoff's specific run) is never "Last Turn"
   * unless it comes through `selectLastTurn` below.
   */
  readonly requestChangeset: (changeset: Changeset) => void;
  /**
   * Ask the Changes surface to re-resolve its view because the running turn
   * just journaled another edit (BST-1115 smoke feedback). A STRICT no-op
   * unless the surface is actually showing `threadId`'s Last Turn: the
   * selection must be "Last Turn" (`isOnLastTurn`), the active changeset must
   * be an `agent-run` one, and it must belong to `threadId`. A git scope, a
   * pinned run, or another thread's run is never refetched behind the user —
   * a live refresh is only ever the thing the user asked to watch.
   *
   * Callers throttle (see `AssistantUiPanelWrapper`); this action itself is
   * unconditional per call so the store stays a pure state transition.
   */
  readonly requestLiveLastTurnRefresh: (threadId: string) => void;
  /**
   * Factory-reset entry point (AGENTS.md invariant: "Any new persistent
   * store/state must be wired into factory reset"). Without a reload, a
   * surviving `activeChangeset`/`handoffThreadIdentity` would keep pointing
   * at a runId/threadId or an absolute repository path the reset just wiped.
   */
  readonly reset: () => void;
  /** Focus `canvasId` WITHOUT switching tabs — the Canvas panel's own picker. */
  readonly selectCanvas: (canvasId: string) => void;
  /**
   * The picker's "Last Turn" action (BST-1115 smoke feedback). Resolves
   * `activeThreadIdentity` into an `agent-run` Changeset at CALL time (never a
   * stale prop) and sets `isOnLastTurn: true`. A no-op — never fabricates a
   * changeset — when no thread is active or the thread has no completed runs
   * yet (NO SILENT FALLBACKS); the picker itself disables the control for
   * exactly that state, so this is defense-in-depth, not the primary guard.
   */
  readonly selectLastTurn: () => void;
  /**
   * Publishes the active thread's standing identity — see
   * `activeThreadIdentity`'s doc comment. When the caller is currently "Last
   * Turn" (`isOnLastTurn`) AND the incoming identity is for the SAME thread
   * as the active `agent-run` changeset AND its `latestRunId` actually moved,
   * the active changeset is retargeted to the new run in the SAME set — this
   * is the live-tracking behavior, not a separate effect. A git-scope
   * changeset, or an agent-run changeset the user explicitly pinned
   * (`isOnLastTurn: false`), is never touched.
   */
  readonly setActiveThreadIdentity: (identity: ChangesActiveThreadIdentity | null) => void;
}

export const useChangesNavigationStore = create<ChangesNavigationState>((set, get) => ({
  activeChangeset: null,
  activeThreadIdentity: null,
  canvasRefreshNonce: 0,
  focusedCanvasId: null,
  handoffThreadIdentity: null,
  isOnLastTurn: false,
  liveRefreshNonce: 0,
  openCanvas: (canvasId) => {
    set({ focusedCanvasId: canvasId });
    useWorkspaceTabSelectionStore.getState().openApp(CANVAS_APP_ID);
  },
  openCanvasPanel: () => {
    useWorkspaceTabSelectionStore.getState().openApp(CANVAS_APP_ID);
  },
  openChangeset: (changeset) => {
    get().requestChangeset(changeset);
    useWorkspaceTabSelectionStore.getState().openApp(CHANGES_APP_ID);
  },
  requestCanvasRefresh: () =>
    set((state) => ({ canvasRefreshNonce: state.canvasRefreshNonce + 1 })),
  requestChangeset: (changeset) =>
    set(
      changeset.kind === 'agent-run'
        ? {
            activeChangeset: changeset,
            handoffThreadIdentity: {
              latestRunId: changeset.runId,
              threadId: changeset.threadId,
            },
            isOnLastTurn: false,
          }
        : { activeChangeset: changeset, isOnLastTurn: false }
    ),
  requestLiveLastTurnRefresh: (threadId) =>
    set((state) => {
      if (
        !state.isOnLastTurn ||
        state.activeChangeset?.kind !== 'agent-run' ||
        state.activeChangeset.threadId !== threadId
      ) {
        return {};
      }
      return { liveRefreshNonce: state.liveRefreshNonce + 1 };
    }),
  reset: () =>
    set({
      activeChangeset: null,
      activeThreadIdentity: null,
      canvasRefreshNonce: 0,
      focusedCanvasId: null,
      handoffThreadIdentity: null,
      isOnLastTurn: false,
      liveRefreshNonce: 0,
    }),
  selectCanvas: (canvasId) => set({ focusedCanvasId: canvasId }),
  selectLastTurn: () => {
    const identity = get().activeThreadIdentity;
    if (!identity?.latestRunId) {
      return;
    }
    get().requestChangeset({
      kind: 'agent-run',
      runId: identity.latestRunId,
      threadId: identity.threadId,
    });
    set({ isOnLastTurn: true });
  },
  setActiveThreadIdentity: (identity) =>
    set((state) => {
      if (
        state.isOnLastTurn &&
        identity?.latestRunId &&
        state.activeChangeset?.kind === 'agent-run' &&
        state.activeChangeset.threadId === identity.threadId &&
        state.activeChangeset.runId !== identity.latestRunId
      ) {
        return {
          activeChangeset: {
            kind: 'agent-run',
            runId: identity.latestRunId,
            threadId: identity.threadId,
          },
          activeThreadIdentity: identity,
        };
      }
      return { activeThreadIdentity: identity };
    }),
}));
