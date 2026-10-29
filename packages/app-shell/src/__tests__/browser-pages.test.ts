import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import {
  resetAssistantThreadStore,
  useAssistantThreadStore,
  WORKSPACE_MEMORY_RESOURCE_ID,
} from '@brainstrike/assistant-data';
import {
  __resetWorkspaceTabSelectionStoreForTests,
  useWorkspaceTabSelectionStore,
} from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserBridge, BrowserTab } from '../browser-pane/browser-bridge';
import { browserPageTabId, readBrowserPageTab } from '../browser-pane/browser-page-tab';
import { closeBrowserPagesOf, openBrowserPage } from '../browser-pane/browser-pages';
import { useBrowserTabsStore } from '../browser-pane/browser-tabs-store';
import { useBrowserWorkspaceApps } from '../browser-pane/use-browser-workspace-apps';

const bridge = {
  closeTab: vi.fn(() => Promise.resolve()),
  createTab: vi.fn(() => Promise.resolve('new-page')),
  goBack: vi.fn(() => Promise.resolve()),
  goForward: vi.fn(() => Promise.resolve()),
  listTabs: vi.fn(() => Promise.resolve([] as BrowserTab[])),
  navigate: vi.fn(() => Promise.resolve()),
  onTabsChanged: vi.fn(() => () => undefined),
  reload: vi.fn(() => Promise.resolve()),
  setBounds: vi.fn(() => Promise.resolve()),
  setOccluded: vi.fn(() => Promise.resolve()),
  showTab: vi.fn(() => Promise.resolve()),
} satisfies BrowserBridge;

function page(tabId: string, threadId: string): BrowserTab {
  return {
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
    owner: 'user',
    tabId,
    threadId,
    title: '',
    url: 'about:blank',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAssistantThreadStore();
  useAssistantThreadStore.setState({
    activeThreadIdByResourceId: { [WORKSPACE_MEMORY_RESOURCE_ID]: 'thread-a' },
  });
  usePanelLayoutStore.getState().setActiveTab('settings');
  (window as Window & { browser?: BrowserBridge }).browser = bridge;
});

afterEach(() => {
  Reflect.deleteProperty(window as Window & { browser?: unknown }, 'browser');
  useBrowserTabsStore.getState().reset();
  __resetWorkspaceTabSelectionStoreForTests();
});

describe('browser pages', () => {
  it('opens a new page in the shown conversation and goes to the workspace', async () => {
    await openBrowserPage('https://a.test/');

    expect(bridge.createTab).toHaveBeenCalledExactlyOnceWith('thread-a', 'https://a.test/');
    expect(usePanelLayoutStore.getState().activeTab).toBe('explorer');
  });

  it('reopens a closed page tab as a new page at its address', async () => {
    useBrowserTabsStore.getState().setTabs([{ ...page('a1', 'thread-a'), url: 'https://a.test/' }]);
    const id = browserPageTabId({ tabId: 'a1', threadId: 'thread-a' });
    useWorkspaceTabSelectionStore.getState().openApp(id);
    const { result } = renderHook(() => useBrowserWorkspaceApps(bridge));
    const app = result.current.find((candidate) => candidate.id === id);

    await app?.reopen?.();

    expect(bridge.createTab).toHaveBeenCalledExactlyOnceWith('thread-a', 'https://a.test/');
  });

  it('says why no page opened without a conversation or without the desktop browser', async () => {
    useAssistantThreadStore.setState({ activeThreadIdByResourceId: {} });
    await expect(openBrowserPage()).rejects.toThrow(/Send a message first/u);

    Reflect.deleteProperty(window as Window & { browser?: unknown }, 'browser');
    await expect(openBrowserPage()).rejects.toThrow(/browser is not available/u);
    expect(bridge.createTab).not.toHaveBeenCalled();
  });

  it('closes the pages of deleted conversations only', () => {
    useBrowserTabsStore
      .getState()
      .setTabs([page('a1', 'thread-a'), page('b1', 'thread-b'), page('a2', 'thread-a')]);

    closeBrowserPagesOf(new Set(['thread-a']));

    expect(bridge.closeTab.mock.calls).toEqual([['a1'], ['a2']]);
  });

  it('round-trips a page tab address and rejects a corrupted one', () => {
    const id = browserPageTabId({ tabId: 'p:1', threadId: 'thread/a' });
    expect(readBrowserPageTab(id)).toEqual({ tabId: 'p:1', threadId: 'thread/a' });
    expect(readBrowserPageTab('context-explorer')).toBeUndefined();
    expect(() => readBrowserPageTab('browser-page:%5B%22only-one%22%5D')).toThrow(
      'Invalid browser tab address.'
    );
  });
});
