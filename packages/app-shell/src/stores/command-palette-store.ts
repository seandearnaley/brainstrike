import type { ContextTarget } from '@brainstrike/context-actions';
import { create } from 'zustand';
import type { TabChordStripId } from '../tab-chords/tab-chord-registry';

/**
 * Session-lived, NON-persisted state for the ⌘K command palette. `openTarget`
 * captures the surface focused AT OPEN TIME so the app can rebuild the command
 * list with that target as the `CommandContext.target` (the bridge snapshots the
 * target eagerly — see `bridgeActionToCommand`). Closing clears the target so a
 * later targetless open does not carry a stale snapshot. `tabScope` is the
 * strip whose panel held focus at open time, which the tab commands act on
 * (focus moves into the palette once it opens).
 */
export interface CommandPaletteState {
  close: () => void;
  readonly isOpen: boolean;
  open: (options: { target?: ContextTarget; tabScope: TabChordStripId }) => void;
  readonly openTarget: ContextTarget | null;
  readonly tabScope: TabChordStripId | null;
}

export const useCommandPaletteStore = create<CommandPaletteState>((set) => ({
  close: () => set({ isOpen: false, openTarget: null, tabScope: null }),
  isOpen: false,
  open: ({ target, tabScope }) => set({ isOpen: true, openTarget: target ?? null, tabScope }),
  openTarget: null,
  tabScope: null,
}));
