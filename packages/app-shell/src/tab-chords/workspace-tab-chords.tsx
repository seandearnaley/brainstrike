import { selectedWorkspaceTabId, useWorkspaceTabs } from '@brainstrike/file-explorer-ui/shell';
import { type RefObject, useMemo } from 'react';
import { type TabChordStrip, useTabChordStrip } from './tab-chord-registry';

/**
 * Registers the workspace strip with the tab chord router. Renders nothing;
 * mount it inside the `WorkspaceTabsProvider`. It has no panel: the workspace
 * is the strip a chord acts on when focus is in no other strip's panel.
 * `focusRootRef` wraps the strip itself, where lost focus returns after a chord.
 */
export function WorkspaceTabChords({
  focusRootRef,
}: {
  readonly focusRootRef: RefObject<HTMLElement | null>;
}): null {
  const { hasClosedTabs, onActivateTab, onCloseTab, onReopenClosedTab, selection, tabOrder } =
    useWorkspaceTabs();
  const strip = useMemo<TabChordStrip>(
    () => ({
      activate: onActivateTab,
      close: (id) => {
        onCloseTab(id);
        return Promise.resolve();
      },
      getActiveId: () => selectedWorkspaceTabId(selection),
      getFocusRoot: () => focusRootRef.current,
      getPanel: () => null,
      getTabs: () => tabOrder,
      hasClosedTabs,
      reopenClosed: onReopenClosedTab,
    }),
    [focusRootRef, hasClosedTabs, onActivateTab, onCloseTab, onReopenClosedTab, selection, tabOrder]
  );
  useTabChordStrip('workspace', strip);
  return null;
}
