/**
 * Session-lived, NON-persisted state for the ONE Conversation Rewind confirm
 * modal (BST-1115, W5 T4).
 *
 * Two entry points raise a rewind — the assistant panel's "Restore to before
 * this message" (which knows a `messageId`) and the Changes header's "Restore
 * to before this" (which knows a `runId`, Amendment 1 A1.3) — and both must
 * land in the SAME modal. A store, rather than local state in either surface,
 * is what lets the modal live at one place in the tree while being opened from
 * two unrelated ones. Same shape and same reasoning as
 * `changes-navigation-store.ts`: ONE owned value, written directly by each
 * event, never a `useEffect` copying a prop into state (React Doctor
 * `no-adjust-state-on-prop-change` — the defect W4's store exists to avoid).
 *
 * NOTHING here is a rewind ARGUMENT. `request` says which target the user asked
 * about; the scope choice, the conflict acknowledgment and the resolved
 * message id all come from the preview and the modal's own controls, so a
 * stale store value can never become a filesystem write.
 */
import { create } from 'zustand';
import type { RewindPreviewPayload } from './changes-bridge';
import { useChangesStore } from './changes-store';
import type { RewindPort } from './rewind-port';

export interface RewindRequest {
  /**
   * The TARGET USER MESSAGE's text, restored into the composer after a
   * successful rewind so the user can immediately re-send a variant (Amendment
   * 2 — rewind-and-retry is the actual workflow). `null` when the target is an
   * assistant message, or when the raiser has no text to offer: there is
   * deliberately no fallback that invents a prompt.
   */
  readonly composerText: string | null;
  /**
   * The thread's agent-host rewind owner. The raiser knows which thread it serves.
   */
  readonly port: RewindPort;
  /** How the raiser identified the target — see {@link RewindPreviewPayload}. */
  readonly target: RewindPreviewPayload;
}

export interface RewindNavigationState {
  /** Close the modal, discarding the request. Never applies anything. */
  readonly closeRewind: () => void;
  /**
   * THE RE-HYDRATION COUNTER. Rewind changes the host's committed conversation
   * branch and may restore files. Consumers append this to the assistant
   * runtime's key and to useChangeset's load so they read the committed branch
   * and re-resolve the changeset instead of retaining the previous view.
   *
   * It is deliberately NOT folded into `threadKey`. Per-thread state across the
   * panel — the follow-up queue, `ActiveThreadKeyContext`, the viewport store's
   * pinnedness — is keyed by `threadKey` and must SURVIVE a rewind; bumping it
   * would reset all of it, including the composer text the rewind just
   * repopulated (Amendment 2's whole point).
   */
  readonly generation: number;
  /**
   * Bumped once per rewind that CHANGED durable state — a successful apply and
   * a successful redo alike. See {@link RewindNavigationState.generation}.
   */
  readonly markRewindApplied: () => void;
  /** Raise the confirm modal for `request`. */
  readonly openRewind: (request: RewindRequest) => void;
  /** The rewind awaiting confirmation, or `null` when the modal is closed. */
  readonly request: RewindRequest | null;
  /** Factory-reset entry point (AGENTS.md invariant). */
  readonly reset: () => void;
}

/**
 * The modal renders the run-range changeset through the SAME
 * `ChangedFilesTree`/`ChangesetDiffPane` the Changes surface uses, and those
 * two panes agree on which files are checked through the shared
 * `useChangesStore`. Without this, a file checked inside the modal would stay
 * checked in the surface behind it — over a tree of visibly unchecked boxes,
 * because the surface only clears the selection when its OWN changeset
 * changes, and it did not change. Cleared on BOTH edges so neither direction
 * leaks a selection into the other surface.
 */
function clearSharedFileSelection(): void {
  useChangesStore.getState().clearSelection();
}

export const useRewindStore = create<RewindNavigationState>((set) => ({
  closeRewind: () => {
    clearSharedFileSelection();
    set({ request: null });
  },
  generation: 0,
  // Monotonic, never reset to a value it has already held while the app runs:
  // consumers key a React remount on it, and a repeated value is not a remount.
  markRewindApplied: () => set((state) => ({ generation: state.generation + 1 })),
  openRewind: (request) => {
    clearSharedFileSelection();
    set({ request });
  },
  request: null,
  // Factory reset wipes the durable state the counter exists to re-read, so
  // starting over from 0 is correct here and only here.
  reset: () => set({ generation: 0, request: null }),
}));
