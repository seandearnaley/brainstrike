import { beforeEach, describe, expect, it } from 'vitest';
import type { BrowserTab } from '../browser-pane/browser-bridge';
import { browserTabLabel, useBrowserTabsStore } from '../browser-pane/browser-tabs-store';

function tab(overrides: Partial<BrowserTab>): BrowserTab {
  return {
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
    owner: 'user',
    tabId: 't',
    threadId: 'thread-1',
    title: '',
    url: 'about:blank',
    ...overrides,
  };
}

describe('useBrowserTabsStore', () => {
  beforeEach(() => {
    useBrowserTabsStore.getState().reset();
  });

  it('holds the latest pushed pages and knows main has answered', () => {
    expect(useBrowserTabsStore.getState().seeded).toBe(false);
    const tabs = [tab({ tabId: 'a' }), tab({ tabId: 'b', title: 'B' })];
    useBrowserTabsStore.getState().setTabs(tabs);
    expect(useBrowserTabsStore.getState().tabs).toBe(tabs);
    expect(useBrowserTabsStore.getState().seeded).toBe(true);
  });

  it('reset clears the mirror (factory reset)', () => {
    useBrowserTabsStore.getState().setTabs([tab({ tabId: 'a' })]);
    useBrowserTabsStore.getState().reset();
    expect(useBrowserTabsStore.getState().tabs).toEqual([]);
    expect(useBrowserTabsStore.getState().seeded).toBe(false);
  });

  it('labels a page by its title, else its address, else New Tab', () => {
    expect(browserTabLabel({ title: 'Docs', url: 'https://a.test/' })).toBe('Docs');
    expect(browserTabLabel({ title: '', url: 'https://a.test/' })).toBe('https://a.test/');
    expect(browserTabLabel({ title: '', url: '' })).toBe('New Tab');
  });
});
