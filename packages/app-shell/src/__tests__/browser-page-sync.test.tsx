/**
 * Each conversation keeps its own browser pages as workspace tabs (BST-1271):
 * main owns the pages, and the shown conversation's tabs follow them.
 */
import {
  resetAssistantThreadStore,
  useAssistantThreadStore,
  WORKSPACE_MEMORY_RESOURCE_ID,
} from '@brainstrike/assistant-data';
import {
  __resetWorkspaceTabSelectionStoreForTests,
  useWorkspaceTabSelectionStore,
} from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import { act } from '@brainstrike/test-utils/react-act';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserBridge, BrowserTab } from '../browser-pane/browser-bridge';
import { browserPageTabId } from '../browser-pane/browser-page-tab';
import { openBrowserPage } from '../browser-pane/browser-pages';
import { useBrowserTabsStore } from '../browser-pane/browser-tabs-store';
import { useBrowserPageSync } from '../browser-pane/use-browser-page-sync';
import { threadWorkspaceNavigation } from '../thread-workspace/live-thread-workspace-navigation';

let push: ((pages: readonly BrowserTab[]) => void) | null = null;
const seed = vi.fn((): Promise<readonly BrowserTab[]> => Promise.resolve([]));
const bridge = {
  closeTab: vi.fn(() => Promise.resolve()),
  createTab: vi.fn(() => Promise.resolve('new')),
  goBack: vi.fn(() => Promise.resolve()),
  goForward: vi.fn(() => Promise.resolve()),
  listTabs: seed,
  navigate: vi.fn(() => Promise.resolve()),
  onTabsChanged: vi.fn((listener: (pages: readonly BrowserTab[]) => void) => {
    push = listener;
    return () => {
      push = null;
    };
  }),
  reload: vi.fn(() => Promise.resolve()),
  setBounds: vi.fn(() => Promise.resolve()),
  setOccluded: vi.fn(() => Promise.resolve()),
  showTab: vi.fn(() => Promise.resolve()),
} satisfies BrowserBridge;

function page(tabId: string, threadId = 'thread-a'): BrowserTab {
  return {
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
    owner: 'agent',
    tabId,
    threadId,
    title: tabId,
    url: `https://${tabId}.test/`,
  };
}

const tabOf = (tabId: string, threadId = 'thread-a'): string =>
  browserPageTabId({ tabId, threadId });

function workspace() {
  return useWorkspaceTabSelectionStore.getState();
}

function show(threadId: string, ready = true): void {
  useAssistantThreadStore.setState({
    activeThreadIdByResourceId: { [WORKSPACE_MEMORY_RESOURCE_ID]: threadId },
  });
  threadWorkspaceNavigation.loading(WORKSPACE_MEMORY_RESOURCE_ID, threadId);
  if (ready) {
    threadWorkspaceNavigation.complete(WORKSPACE_MEMORY_RESOURCE_ID, threadId);
  }
}

/** Mounts the sync and lets main's seed answer. */
async function mount() {
  const mounted = renderHook(() => useBrowserPageSync(bridge));
  await act(async () => {
    await Promise.resolve();
  });
  return mounted;
}

function pushPages(pages: readonly BrowserTab[]): void {
  act(() => push?.(pages));
}

beforeEach(() => {
  vi.clearAllMocks();
  push = null;
  seed.mockResolvedValue([]);
  useBrowserTabsStore.getState().reset();
  __resetWorkspaceTabSelectionStoreForTests();
  resetAssistantThreadStore();
  show('thread-a');
});

describe('browser page tabs', () => {
  it("opens a page the agent starts in the shown conversation as that conversation's selected tab", async () => {
    await mount();
    pushPages([page('p1')]);

    expect(workspace().openAppIds).toContain(tabOf('p1'));
    expect(workspace().selection).toEqual({ appId: tabOf('p1'), kind: 'app' });
  });

  it('selects a page the person opens, unless they switched conversations while it opened', async () => {
    Object.assign(window, { browser: bridge });
    await mount();
    bridge.createTab.mockImplementationOnce(() => {
      pushPages([page('mine')]);
      return Promise.resolve('mine');
    });
    await act(() => openBrowserPage('https://mine.test/'));
    expect(workspace().selection).toEqual({ appId: tabOf('mine'), kind: 'app' });

    let answer = (): void => undefined;
    bridge.createTab.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = () => {
            pushPages([page('mine'), page('late')]);
            resolve('late');
          };
        })
    );
    const opening = openBrowserPage();
    show('thread-b');
    answer();
    await act(() => opening);

    expect(workspace().openAppIds).not.toContain(tabOf('late'));
    Reflect.deleteProperty(window, 'browser');
  });

  it("keeps another conversation's pages out of the shown workspace", async () => {
    await mount();
    pushPages([page('elsewhere', 'thread-b')]);

    expect(workspace().openAppIds).toEqual(['context-explorer']);
  });

  it('adds the pages already open at start without taking the selection', async () => {
    seed.mockResolvedValue([page('p1')]);
    await mount();

    expect(workspace().openAppIds).toEqual(['context-explorer', tabOf('p1')]);
    expect(workspace().selection).toEqual({ appId: 'context-explorer', kind: 'app' });
  });

  it('closes a tab whose page is gone, as after a restart', async () => {
    workspace().hydrate(['context-explorer', tabOf('lost')], { appId: tabOf('lost'), kind: 'app' });
    await mount();

    expect(workspace().openAppIds).toEqual(['context-explorer']);
    expect(bridge.closeTab).not.toHaveBeenCalled();
  });

  it("closes the page when the person closes its tab, and only that conversation's", async () => {
    await mount();
    pushPages([page('p1'), page('p2')]);

    act(() => {
      workspace().closeApp(tabOf('p1'));
    });

    expect(bridge.closeTab).toHaveBeenCalledExactlyOnceWith('p1');
  });

  it("leaves a conversation's pages open when the workspace switches to another", async () => {
    await mount();
    pushPages([page('p1')]);

    act(() => {
      show('thread-b', false);
      workspace().hydrate(['context-explorer'], { appId: 'context-explorer', kind: 'app' });
      threadWorkspaceNavigation.complete(WORKSPACE_MEMORY_RESOURCE_ID, 'thread-b');
    });

    expect(bridge.closeTab).not.toHaveBeenCalled();
  });

  it('adds a page opened while its conversation was out of view once that workspace is applied', async () => {
    await mount();
    act(() => show('thread-b', false));
    pushPages([page('p1'), page('b1', 'thread-b')]);
    expect(workspace().openAppIds).not.toContain(tabOf('b1', 'thread-b'));

    await act(async () => {
      threadWorkspaceNavigation.complete(WORKSPACE_MEMORY_RESOURCE_ID, 'thread-b');
      await Promise.resolve();
    });

    expect(workspace().openAppIds).toContain(tabOf('b1', 'thread-b'));
    expect(workspace().openAppIds).not.toContain(tabOf('p1'));
  });
});
