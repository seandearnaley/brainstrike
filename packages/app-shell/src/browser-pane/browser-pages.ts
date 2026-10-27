import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import { useAssistantThreadStore, WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data';
import { createLogger } from '@brainstrike/logging';
import { resolveBrowserBridge } from './browser-bridge';
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
 * Open a page among the shown conversation's tabs and go to the workspace.
 * The page's tab comes from main's page list (`useBrowserPageSync`), which
 * selects a new page only while its own conversation is shown: a switch
 * during the round trip leaves the page with its conversation. Rejects
 * without the desktop browser or an open conversation, so the caller can say
 * why nothing opened.
 */
export async function openBrowserPage(url?: string): Promise<void> {
  const bridge = resolveBrowserBridge();
  if (!bridge) {
    throw new Error('The built-in browser is not available here.');
  }
  const threadId = activeBrowserThreadId();
  if (threadId === null) {
    throw new Error('Send a message first: each browser tab belongs to a conversation.');
  }
  await bridge.createTab(threadId, url);
  usePanelLayoutStore.getState().setActiveTab('explorer');
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
