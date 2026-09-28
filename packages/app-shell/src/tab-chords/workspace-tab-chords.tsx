import { selectedWorkspaceTabId, useWorkspaceTabs } from '@brainstrike/file-explorer-ui/shell';
import { useMemo } from 'react';
import { type TabChordStrip, useTabChordStrip } from './tab-chord-registry';

/**
 * Registers the workspace strip with the tab chord router. Renders nothing;
 * mount it inside the `WorkspaceTabsProvider`. It has no panel: the workspace
 * is the strip a chord acts on when focus is in no other strip's panel.
 */
export function WorkspaceTabChords(): null {
  const { hasClosedTabs, onActivateTab, onCloseTab, onReopenClosedTab, selection, tabOrder } =
    useWorkspaceTabs();
  const strip = useMemo<TabChordStrip>(
    () => ({
      activate: onActivateTab,
      close: onCloseTab,
      getActiveId: () => selectedWorkspaceTabId(selection),
      getPanel: () => null,
      getTabs: () => tabOrder,
      hasClosedTabs,
      reopenClosed: onReopenClosedTab,
    }),
    [hasClosedTabs, onActivateTab, onCloseTab, onReopenClosedTab, selection, tabOrder]
  );
  useTabChordStrip('workspace', strip);
  return null;
}
