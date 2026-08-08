import { beforeEach, describe, expect, it } from 'vitest';
import type { BrowserTab } from '../browser-pane/browser-bridge';
import { selectActiveBrowserTab, useBrowserTabsStore } from '../browser-pane/browser-tabs-store';

function tab(overrides: Partial<BrowserTab>): BrowserTab {
  return {
    active: false,
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
    tabId: 't',
    title: '',
    url: 'about:blank',
    ...overrides,
  };
}

describe('useBrowserTabsStore', () => {
  beforeEach(() => {
    useBrowserTabsStore.getState().reset();
  });

  it('holds the latest pushed tabs and selects the active one', () => {
    const tabs = [tab({ tabId: 'a' }), tab({ active: true, tabId: 'b', title: 'B' })];
    useBrowserTabsStore.getState().setTabs(tabs);
    expect(useBrowserTabsStore.getState().tabs).toBe(tabs);
    expect(selectActiveBrowserTab(useBrowserTabsStore.getState())?.tabId).toBe('b');
  });

  it('reset clears the mirror (factory reset)', () => {
    useBrowserTabsStore.getState().setTabs([tab({ tabId: 'a' })]);
    useBrowserTabsStore.getState().reset();
    expect(useBrowserTabsStore.getState().tabs).toEqual([]);
    expect(selectActiveBrowserTab(useBrowserTabsStore.getState())).toBeUndefined();
  });
});
