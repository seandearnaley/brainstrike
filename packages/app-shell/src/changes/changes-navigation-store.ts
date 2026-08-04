import type { Changeset } from '@brainstrike/types';
import { create } from 'zustand';

/**
 * Session-lived, NON-persisted handoff for navigating INTO the Changes
 * surface with a specific changeset pre-selected (BST-1114). There is no
 * route-params concept in this app (mirrors the two-step "switch tab, then
 * hand over the payload" precedent in `quick-open-host.tsx`), so this store is
 * the smallest honest equivalent: a caller (e.g. the assistant turn footer's
 * "→ Review" link) calls `requestChangeset` then switches the active panel
 * tab to `'changes'`; the Changes surface reads it back on mount via
 * `consumePendingChangeset`.
 *
 * `consumePendingChangeset` reads AND clears in one call so a later manual
 * tab switch (the user just clicking the Changes nav item again) never
 * silently re-applies a stale changeset from a previous handoff.
 */
export interface ChangesNavigationState {
  readonly consumePendingChangeset: () => Changeset | null;
  readonly pendingChangeset: Changeset | null;
  readonly requestChangeset: (changeset: Changeset) => void;
}

export const useChangesNavigationStore = create<ChangesNavigationState>((set, get) => ({
  consumePendingChangeset: () => {
    const changeset = get().pendingChangeset;
    if (changeset !== null) {
      set({ pendingChangeset: null });
    }
    return changeset;
  },
  pendingChangeset: null,
  requestChangeset: (changeset) => set({ pendingChangeset: changeset }),
}));
