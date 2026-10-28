/**
 * The one-slot handoff that repopulates the composer after a Conversation
 * Rewind (BST-1115, Amendment 2).
 *
 * WHY A STORE AND NOT A CALLBACK. A successful rewind hides the target message,
 * which UNMOUNTS the button that raised it — the natural place to call
 * `composer().setText(...)` is gone by the time the rewind succeeds. The
 * consumer therefore has to be something that outlives the rewind, and the
 * producer (app-shell's confirm modal) sits in a different package. A
 * module-scope store with a render-nothing bridge outlives that unmount.
 *
 * ONE SLOT, CONSUMED ONCE. A rewind is a single user action, and a queue here
 * would let an abandoned handoff resurface into a later thread's composer. A
 * second request before the first is consumed REPLACES it: the newer rewind is
 * the one the user is looking at.
 */
import { create } from 'zustand';

export interface RewindComposerState {
  /** Clear the slot. Called by the bridge once the text is in the draft. */
  readonly consume: () => void;
  /** Text awaiting the composer, or `null` when there is nothing to restore. */
  readonly pendingText: string | null;
  /**
   * Hand `text` to the composer. Whitespace-only text is REFUSED rather than
   * silently stored: repopulating with an empty prompt looks identical to the
   * feature not working.
   */
  readonly requestComposerText: (text: string) => void;
}

export const useRewindComposerStore = create<RewindComposerState>((set) => ({
  consume: () => set({ pendingText: null }),
  pendingText: null,
  requestComposerText: (text) => {
    if (text.trim() === '') {
      throw new Error('Rewind composer repopulation requires non-whitespace text.');
    }
    set({ pendingText: text });
  },
}));
