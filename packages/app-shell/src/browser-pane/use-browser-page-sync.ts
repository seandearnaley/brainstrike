import { useAssistantThreadStore, WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data';
import { useWorkspaceTabSelectionStore } from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import { createLogger } from '@brainstrike/logging';
import { useEffect } from 'react';
import { threadWorkspaceNavigation } from '../thread-workspace/live-thread-workspace-navigation';
import type { BrowserBridge, BrowserTab } from './browser-bridge';
import { type BrowserPageTab, browserPageTabId, readBrowserPageTab } from './browser-page-tab';
import { activeBrowserThreadId } from './browser-pages';
import { liveBrowserTabs, useBrowserTabsStore } from './browser-tabs-store';

const logger = createLogger('BrowserPageSync');

/** The conversation the workspace shows, once its stored workspace is applied; null while one loads. */
function readyThreadId(): string | null {
  const threadId = activeBrowserThreadId();
  return threadId !== null &&
    threadWorkspaceNavigation.isReady(WORKSPACE_MEMORY_RESOURCE_ID, threadId)
    ? threadId
    : null;
}

function pageTabOf(appId: string): BrowserPageTab | undefined {
  try {
    return readBrowserPageTab(appId);
  } catch {
    // A corrupted address shows its own failure in its tab.
    return;
  }
}

/**
 * Bring the shown conversation's tabs in line with main's pages: a tab whose
 * page is gone (closed, or lost with a restart) closes, and each of the
 * thread's pages without a tab gets one. A page in `selected` is also shown:
 * it was opened while the person watched this thread, as a canvas the
 * assistant writes is.
 */
function reconcile(selected: ReadonlySet<string>): void {
  const threadId = readyThreadId();
  const { seeded, tabs: pages } = useBrowserTabsStore.getState();
  if (threadId === null || !seeded) {
    return;
  }
  const live = new Set(pages.map((page) => page.tabId));
  const workspace = useWorkspaceTabSelectionStore.getState();
  const gone = workspace.openAppIds.filter((appId) => {
    const tab = pageTabOf(appId);
    return tab !== undefined && !live.has(tab.tabId);
  });
  if (gone.length > 0) {
    workspace.closeApps(gone);
  }
  const own = pages.filter((page) => page.threadId === threadId);
  workspace.addApps(own.map(browserPageTabId));
  for (const page of own) {
    if (selected.has(page.tabId)) {
      workspace.openApp(browserPageTabId(page));
    }
  }
}

/**
 * Mirrors main's browser pages and keeps each conversation's page tabs in
 * step with them (BST-1271). Main owns the pages; the workspace shows the
 * active conversation's as tabs, so switching threads switches pages. Closing
 * a page's tab closes the page; replacing the workspace with another thread's
 * leaves the outgoing thread's pages open for its return.
 */
export function useBrowserPageSync(bridge: BrowserBridge | null): void {
  const activeThreadId = useAssistantThreadStore(
    (state) => state.activeThreadIdByResourceId[WORKSPACE_MEMORY_RESOURCE_ID] ?? null
  );

  // Subscribe FIRST and skip the seed if ANY push already arrived, so a push
  // during the seed round-trip is never clobbered by the stale snapshot; an
  // authoritative EMPTY push must win too. `cancelled` guards StrictMode's
  // setup→cleanup→setup: the first seed outlives its own unsubscribe.
  useEffect(() => {
    if (!bridge) {
      return;
    }
    let pushed = false;
    let cancelled = false;
    const apply = (pages: readonly BrowserTab[], fresh: ReadonlySet<string>): void => {
      useBrowserTabsStore.getState().setTabs(pages);
      reconcile(fresh);
    };
    const unsubscribe = bridge.onTabsChanged((pages) => {
      pushed = true;
      // Only a page that appears after the mirror holds main's list is new.
      const { seeded } = useBrowserTabsStore.getState();
      const known = new Set(liveBrowserTabs().map((page) => page.tabId));
      apply(
        pages,
        new Set(pages.flatMap((page) => (!seeded || known.has(page.tabId) ? [] : [page.tabId])))
      );
    });
    bridge
      .listTabs()
      .then((seed) => {
        if (!(cancelled || pushed)) {
          apply(seed, new Set());
        }
      })
      .catch((error: unknown) => logger.error('Browser page seed failed', { error }));
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [bridge]);

  // A thread's workspace is reconciled once it is applied, so a page the
  // agent opened while the thread was out of view joins its tabs.
  useEffect(() => {
    if (!bridge || activeThreadId === null) {
      return;
    }
    threadWorkspaceNavigation.whenReady(WORKSPACE_MEMORY_RESOURCE_ID, activeThreadId).then(
      () => reconcile(new Set()),
      // The coordinator reports a failed workspace read itself; nothing to add here.
      () => undefined
    );
  }, [activeThreadId, bridge]);

  // Closing a page's tab closes the page. A hydration REPLACES the open set
  // with another thread's workspace: that closes nothing.
  useEffect(() => {
    if (!bridge) {
      return;
    }
    return useWorkspaceTabSelectionStore.subscribe((state, previous) => {
      const threadId = readyThreadId();
      if (
        threadId === null ||
        state.openAppIds === previous.openAppIds ||
        state.hydration !== previous.hydration
      ) {
        return;
      }
      const stillOpen = new Set(state.openAppIds);
      const pages = new Set(liveBrowserTabs().map((page) => page.tabId));
      for (const appId of previous.openAppIds) {
        const tab = stillOpen.has(appId) ? undefined : pageTabOf(appId);
        if (tab?.threadId === threadId && pages.has(tab.tabId)) {
          bridge.closeTab(tab.tabId).catch((error: unknown) => {
            logger.error('Closing the browser page failed', { error, tabId: tab.tabId });
          });
        }
      }
    });
  }, [bridge]);
}
