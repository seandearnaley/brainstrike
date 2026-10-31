import type { WorkspaceApp } from '@brainstrike/file-explorer-ui/shell';
import { useWorkspaceTabSelectionStore } from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import { Bot, Globe } from 'lucide-react';

import type { BrowserBridge, BrowserTab } from './browser-bridge';
import { type BrowserPageTab, readBrowserPageTab } from './browser-page-tab';
import { BrowserPageView } from './browser-page-view';
import { openBrowserPage } from './browser-pages';
import { browserTabLabel, useBrowserTabsStore } from './browser-tabs-store';

const pageIcon: WorkspaceApp['icon'] = ({ className }) => <Globe className={className} />;
// The agent's own pages browse on their own partition behind the egress proxy (BST-1238).
const agentPageIcon: WorkspaceApp['icon'] = ({ className }) => <Bot className={className} />;
const FALLBACK_LABEL = 'Browser';

function corruptedPageApp(id: string, error: unknown): WorkspaceApp {
  const message = error instanceof Error ? error.message : String(error);
  return {
    icon: pageIcon,
    id,
    label: FALLBACK_LABEL,
    placement: 'dynamic',
    render: () => (
      <p className="text-destructive p-4 text-xs" role="alert">
        {message}
      </p>
    ),
  };
}

/** The tab of the page `id` names; null for an id that names no page. */
function pageApp(
  id: string,
  bridge: BrowserBridge,
  pages: readonly BrowserTab[]
): WorkspaceApp | null {
  let tab: BrowserPageTab | undefined;
  try {
    tab = readBrowserPageTab(id);
  } catch (error) {
    return corruptedPageApp(id, error);
  }
  if (!tab) {
    return null;
  }
  const shown = tab;
  const page = pages.find((candidate) => candidate.tabId === shown.tabId);
  return {
    icon: page?.owner === 'agent' ? agentPageIcon : pageIcon,
    id,
    label: page ? browserTabLabel(page) : FALLBACK_LABEL,
    placement: 'dynamic',
    render: () => <BrowserPageView bridge={bridge} tab={shown} />,
    // Closing the tab closes the page, so reopening it opens a new page at its address.
    reopen: page ? () => openBrowserPage(page.url) : undefined,
    status: page?.isLoading ? 'loading' : undefined,
    tooltip: page?.url || undefined,
  };
}

/**
 * Every open browser page is a dynamic workspace tab of its own (BST-1271),
 * named after the page's title and marked while it loads. `bridge` is null
 * without the desktop browser, which then registers no page tab at all.
 */
export function useBrowserWorkspaceApps(bridge: BrowserBridge | null): readonly WorkspaceApp[] {
  const openIds = useWorkspaceTabSelectionStore((state) => state.openAppIds);
  const pages = useBrowserTabsStore((state) => state.tabs);
  return bridge === null
    ? []
    : openIds.flatMap((id) => {
        const app = pageApp(id, bridge, pages);
        return app ? [app] : [];
      });
}
