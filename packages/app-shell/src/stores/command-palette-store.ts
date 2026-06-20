import type { ContextTarget } from '@brainstrike/context-actions';
import { create } from 'zustand';

/**
 * Session-lived, NON-persisted state for the ⌘K command palette. `openTarget`
 * captures the surface focused AT OPEN TIME so the app can rebuild the command
 * list with that target as the `CommandContext.target` (the bridge snapshots the
 * target eagerly — see `bridgeActionToCommand`). Closing clears the target so a
 * later targetless open does not carry a stale snapshot.
 */
export interface CommandPaletteState {
  close: () => void;
  readonly isOpen: boolean;
  open: (target?: ContextTarget) => void;
  readonly openTarget: ContextTarget | null;
}

export const useCommandPaletteStore = create<CommandPaletteState>((set) => ({
  isOpen: false,
  openTarget: null,
  open: (target) => set({ isOpen: true, openTarget: target ?? null }),
  close: () => set({ isOpen: false, openTarget: null }),
}));
