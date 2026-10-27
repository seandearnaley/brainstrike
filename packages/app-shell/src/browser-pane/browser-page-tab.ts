/**
 * The workspace tab address of one browser page (BST-1271): each page opens
 * in a tab of its own among its conversation's tabs, so a thread keeps its
 * own pages and switching threads switches them. The address names the
 * thread main filed the page under and the page's id there.
 */
export interface BrowserPageTab {
  readonly tabId: string;
  readonly threadId: string;
}

const PREFIX = 'browser-page:';

function requireTab(value: unknown): BrowserPageTab {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error('Invalid browser tab address.');
  }
  const [threadId, tabId]: unknown[] = value;
  if (
    typeof threadId !== 'string' ||
    !threadId.trim() ||
    typeof tabId !== 'string' ||
    !tabId.trim()
  ) {
    throw new Error('Invalid browser tab identity.');
  }
  return { tabId, threadId };
}

export function browserPageTabId(tab: BrowserPageTab): string {
  const tuple = [tab.threadId, tab.tabId];
  requireTab(tuple);
  return PREFIX + encodeURIComponent(JSON.stringify(tuple));
}

export function isBrowserPageTabId(id: string): boolean {
  return id.startsWith(PREFIX);
}

/** Ordinary app ids pass through; a corrupted page id is a visible error. */
export function readBrowserPageTab(id: string): BrowserPageTab | undefined {
  if (!id.startsWith(PREFIX)) {
    return;
  }
  return requireTab(JSON.parse(decodeURIComponent(id.slice(PREFIX.length))));
}
