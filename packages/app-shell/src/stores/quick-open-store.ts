import { create } from 'zustand';

/**
 * Session-lived, NON-persisted state for the ⌘P quick-open file finder. Unlike
 * the command palette it captures nothing target-specific — quick-open is a
 * global file finder, so it only needs open/close. The search query itself is
 * local component state owned by the host (it drives the live query), reset on
 * close.
 */
export interface QuickOpenState {
  close: () => void;
  readonly isOpen: boolean;
  open: () => void;
}

export const useQuickOpenStore = create<QuickOpenState>((set) => ({
  close: () => set({ isOpen: false }),
  isOpen: false,
  open: () => set({ isOpen: true }),
}));
