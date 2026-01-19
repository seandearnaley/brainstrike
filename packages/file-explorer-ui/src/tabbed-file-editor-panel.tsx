import { useTabFileRestoration } from '@brainstrike/file-explorer-hooks';
import { useIdeFileEditor } from '@brainstrike/ui';
import { decodeFileSelection } from '@brainstrike/utils';
import { memo, useCallback, useEffect, useMemo } from 'react';
import { useTabManager } from './hooks/use-tab-manager';
import { TabbedFileEditor, type TabStripAction } from './tabbed-file-editor';
import { useFileExplorer } from './use-file-explorer-context';

export interface TabbedFileEditorPanelProps {
  className?: string;
}

export const TabbedFileEditorPanel = memo<TabbedFileEditorPanelProps>(
  function TabbedFileEditorPanel({ className }) {
    const { registerOpenFileInTab } = useIdeFileEditor();
    const {
      rootDirectoryHandle,
      fileContents,
      loadingFiles,
      loadFileContent,
      fileTree,
      canLoadWithoutTree,
    } = useFileExplorer();

    const { tabs, activeTabId, openTab, closeTab, clearTabs, setActiveTab } = useTabManager();

    // BST-307: Use file restoration hook to restore file handles for persisted tabs
    const { tabStatuses, requestTabPermission, getStatusMessage } = useTabFileRestoration(
      tabs,
      // Remove tabs whose files can't be found
      (tabId: string) => {
        closeTab(tabId);
      }
    );

    // Handle tab click - also handles permission requests for tabs needing restoration
    const handleTabClick = useCallback(
      async (tabId: string) => {
        const tab = tabs.find((t) => t.id === tabId);
        if (!tab) {
          // Tab not found - shouldn't happen in practice since click comes from rendered tab
          return;
        }

        const status = tabStatuses.get(tab.compositeKey);
        // If tab needs permission, request it first (must be from user click)
        if (status?.status === 'needs-permission') {
          const granted = await requestTabPermission(tab.compositeKey);
          if (granted) {
            // Permission granted - load the file content
            void loadFileContent(tab.compositeKey);
          }
          // If not granted, still select the tab to show the permission message
        }

        setActiveTab(tabId);
      },
      [setActiveTab, tabs, tabStatuses, requestTabPermission, loadFileContent]
    );

    // Handle tab close
    const handleTabClose = useCallback(
      (tabId: string) => {
        closeTab(tabId);
      },
      [closeTab]
    );

    const handleCloseAllTabs = useCallback((): void => {
      clearTabs();
    }, [clearTabs]);

    // Handle loading file content for tabs
    const handleLoadFileContent = useCallback(
      (compositeKey: string) => {
        void loadFileContent(compositeKey);
      },
      [loadFileContent]
    );

    useEffect(() => {
      if (!activeTabId) {
        return;
      }
      // On Electron (canLoadWithoutTree), we can load files without the tree.
      // On web, we need the tree to get file handles.
      if (!canLoadWithoutTree && fileTree.length === 0) {
        return;
      }
      const activeTab = tabs.find((tab) => tab.id === activeTabId);
      if (!activeTab) {
        return;
      }
      if (fileContents[activeTab.compositeKey] || loadingFiles.has(activeTab.compositeKey)) {
        return;
      }
      void loadFileContent(activeTab.compositeKey);
    }, [
      activeTabId,
      canLoadWithoutTree,
      fileContents,
      fileTree,
      loadingFiles,
      loadFileContent,
      tabs,
    ]);

    // NOTE: Tab content is read directly from fileContents in TabbedFileEditor (line 306),
    // not from tab.content. The sync effect was removed as it maintained unused state.

    // Function to open a file in a tab (exposed globally for preview panel to use)
    const handleOpenFileInTab = useCallback(
      (compositeKey: string) => {
        const { path } = decodeFileSelection(compositeKey);
        // Create a more unique ID by prepending the root directory name
        const uniqueTabId = `${rootDirectoryHandle?.name ?? 'default'}:${compositeKey}`;
        openTab(path, uniqueTabId, compositeKey);

        // Load content if not already loaded or loading
        if (!(fileContents[compositeKey] || loadingFiles.has(compositeKey))) {
          void loadFileContent(compositeKey);
        }
      },
      [openTab, loadFileContent, rootDirectoryHandle] // Remove fileContents and loadingFiles to prevent infinite loops
    );

    // Register the openFileInTab function with the IDE layout context
    useEffect(() => {
      registerOpenFileInTab(handleOpenFileInTab);
    }, [registerOpenFileInTab, handleOpenFileInTab]);

    const tabStripActions = useMemo<TabStripAction[]>(
      () => [
        {
          id: 'close-all',
          label: 'Close All',
          enabled: tabs.length > 0,
          onSelect: handleCloseAllTabs,
        },
      ],
      [handleCloseAllTabs, tabs.length]
    );

    return (
      <div className={className}>
        <TabbedFileEditor
          activeTabId={activeTabId}
          decodeFileSelection={decodeFileSelection}
          fileContents={fileContents}
          getTabStatusMessage={getStatusMessage}
          loadingFiles={loadingFiles}
          onLoadFileContent={handleLoadFileContent}
          onTabClick={handleTabClick}
          onTabClose={handleTabClose}
          tabStatuses={tabStatuses}
          tabStripActions={tabStripActions}
          tabs={tabs}
        />
      </div>
    );
  }
);

TabbedFileEditorPanel.displayName = 'TabbedFileEditorPanel';
