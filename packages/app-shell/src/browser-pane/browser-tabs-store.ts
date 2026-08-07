/**
 * Renderer-side mirror of the main-process browser tab list (BST-1174).
 *
 * The main `BrowserViewManager` is the source of truth; this store just holds
 * the latest `tabsChanged` push so the tab strip / URL bar render off a single
 * subscription. Session-only (never persisted) — reset wiring lives in
 * `register-factory-reset-session-stores.ts`.
 */

import { create } from 'zustand';
import type { BrowserTab } from './browser-bridge';

interface BrowserTabsState {
  readonly reset: () => void;
  readonly setTabs: (tabs: readonly BrowserTab[]) => void;
  readonly tabs: readonly BrowserTab[];
}

export const useBrowserTabsStore = create<BrowserTabsState>((set) => ({
  reset: () => set({ tabs: [] }),
  setTabs: (tabs) => set({ tabs }),
  tabs: [],
}));

/** The currently active tab, or `undefined` when the pane has no tabs. */
export function selectActiveBrowserTab(state: BrowserTabsState): BrowserTab | undefined {
  return state.tabs.find((tab) => tab.active);
}
