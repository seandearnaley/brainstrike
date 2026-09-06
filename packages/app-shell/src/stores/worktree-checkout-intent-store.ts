/**
 * One-shot cross-surface checkout intent (BST-1392, spec §10 "New thread here"
 * / "Hand off").
 *
 * The Worktree Map lives in the workspace tab strip; the checkout WRITER
 * (`useThreadCheckout`, mounted by `useWorkspaceBar`) lives in the composer.
 * They are different component trees, so the Map publishes an intent and the
 * composer consumes it — the `changes-navigation-store` idiom. This store is
 * NOT a second source of truth: it holds a request for at most one tick and
 * clears it the moment the real writer takes it.
 *
 * `worktreeId: null` means "hand off to Local", so both directions travel the
 * same seam and neither surface grows a second write path.
 */
import { create } from 'zustand';

export interface WorktreeCheckoutIntent {
  readonly branch: string | null;
  readonly path: string;
  readonly threadId: string;
  readonly worktreeId: string | null;
}

export interface WorktreeCheckoutIntentState {
  /** Returns and CLEARS the intent when it targets `threadId`; else null. */
  readonly consume: (threadId: string) => WorktreeCheckoutIntent | null;
  readonly pending: WorktreeCheckoutIntent | null;
  readonly publish: (intent: WorktreeCheckoutIntent) => void;
  readonly reset: () => void;
}

export const useWorktreeCheckoutIntentStore = create<WorktreeCheckoutIntentState>((set, get) => ({
  consume: (threadId) => {
    const { pending } = get();
    if (!pending || pending.threadId !== threadId) {
      return null;
    }
    // Clear BEFORE the caller starts its async write: a re-render between the
    // read and the write must not see the same intent twice.
    set({ pending: null });
    return pending;
  },
  pending: null,
  publish: (intent) => {
    set({ pending: intent });
  },
  reset: () => set({ pending: null }),
}));
