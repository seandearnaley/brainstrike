import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import { useAssistantThreadStore, WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data';
import { useWorkspaceTabSelectionStore } from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import { createLogger } from '@brainstrike/logging';
import { resolveBrowserBridge } from './browser-bridge';
import { browserPageTabId } from './browser-page-tab';
import { liveBrowserTabs } from './browser-tabs-store';

const logger = createLogger('BrowserPages');

/** The conversation the workspace shows, whose tabs a new page joins. */
export function activeBrowserThreadId(): string | null {
  return (
    useAssistantThreadStore.getState().activeThreadIdByResourceId[WORKSPACE_MEMORY_RESOURCE_ID] ??
    null
  );
}

/**
 * Open a page in a tab of its own among the shown conversation's tabs, and
 * show it: the person asked for it. Rejects without the desktop browser or
 * an open conversation, so the caller can say why nothing opened.
 */
export async function openBrowserPage(url?: string): Promise<void> {
  const bridge = resolveBrowserBridge();
  if (!bridge) {
    throw new Error('The built-in browser is not available here.');
  }
  const threadId = activeBrowserThreadId();
  if (threadId === null) {
    throw new Error('Open a conversation first: each browser tab belongs to one.');
  }
  const tabId = await bridge.createTab(threadId, url);
  usePanelLayoutStore.getState().setActiveTab('explorer');
  useWorkspaceTabSelectionStore.getState().openApp(browserPageTabId({ tabId, threadId }));
}

/** A deleted conversation's pages close with it: nothing else would ever show them again. */
export function closeBrowserPagesOf(threadIds: ReadonlySet<string>): void {
  const bridge = resolveBrowserBridge();
  if (!bridge) {
    return;
  }
  for (const page of liveBrowserTabs()) {
    if (threadIds.has(page.threadId)) {
      bridge.closeTab(page.tabId).catch((error: unknown) => {
        logger.error("A deleted conversation's browser page could not be closed", {
          error,
          tabId: page.tabId,
        });
      });
    }
  }
}
