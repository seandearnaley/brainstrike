/**
 * Renderer-side mirror of main's browser pages (BST-1174), every thread's.
 *
 * The main `BrowserViewManager` is the source of truth; this store holds the
 * latest `tabsChanged` push, so each page tab renders off one subscription.
 * `seeded` turns true once main's list has arrived: before that an open page
 * tab cannot be told apart from a closed one. Session-only (never persisted)
 * — reset wiring lives in `register-factory-reset-session-stores.ts`.
 */

import { create } from 'zustand';
import type { BrowserTab } from './browser-bridge';

interface BrowserTabsState {
  readonly reset: () => void;
  readonly seeded: boolean;
  readonly setTabs: (tabs: readonly BrowserTab[]) => void;
  readonly tabs: readonly BrowserTab[];
}

export const useBrowserTabsStore = create<BrowserTabsState>((set) => ({
  reset: () => set({ seeded: false, tabs: [] }),
  seeded: false,
  setTabs: (tabs) => set({ seeded: true, tabs }),
  tabs: [],
}));

/** Main's page list as last pushed, for reads outside React. */
export function liveBrowserTabs(): readonly BrowserTab[] {
  return useBrowserTabsStore.getState().tabs;
}

/** A page's visible label: its title, else its URL, else "New Tab". */
export function browserTabLabel(tab: Pick<BrowserTab, 'title' | 'url'>): string {
  return tab.title || tab.url || 'New Tab';
}
