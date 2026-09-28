/**
 * Which thread's transcript is on screen RIGHT NOW (BST-1845) — see
 * `hooks/use-on-screen-thread.ts` for the definition and the one publisher.
 *
 * Session-only by design: it is a fact about this window at this instant, so it
 * is never persisted (a restored id would mark a run seen before anything was
 * shown) and it is drained with the other app-shell session stores.
 */
import { create } from 'zustand';

export interface OnScreenThreadState {
  /** `null` when no transcript is showing. */
  readonly onScreenThreadId: string | null;
  /**
   * Withdraws a claim, but only if `threadId` is still the one published: a
   * publisher going away must not clear the claim of one that replaced it.
   */
  readonly releaseOnScreenThreadId: (threadId: string) => void;
  readonly reset: () => void;
  readonly setOnScreenThreadId: (threadId: string | null) => void;
}

export const useOnScreenThreadStore = create<OnScreenThreadState>((set) => ({
  onScreenThreadId: null,
  releaseOnScreenThreadId: (threadId) =>
    set((state) => (state.onScreenThreadId === threadId ? { onScreenThreadId: null } : state)),
  reset: () => set({ onScreenThreadId: null }),
  setOnScreenThreadId: (threadId) => set({ onScreenThreadId: threadId }),
}));
