import { useTabFileRestoration } from '@brainstrike/file-explorer-hooks';
import { useIdeFileEditor } from '@brainstrike/ui';
import { createLogger, decodeFileSelection } from '@brainstrike/utils';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';

const logger = createLogger('TabbedFileEditorPanel');

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

    // Track in-progress permission requests to prevent race conditions from double-clicks
    const permissionRequestsInProgressRef = useRef<Set<string>>(new Set());

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
          // Prevent duplicate permission requests (race condition from double-clicks)
          if (permissionRequestsInProgressRef.current.has(tab.compositeKey)) {
            setActiveTab(tabId);
            return;
          }

          const tabCompositeKey = tab.compositeKey;
          permissionRequestsInProgressRef.current.add(tabCompositeKey);
          try {
            const granted = await requestTabPermission(tabCompositeKey);
            if (granted) {
              // Permission granted - load the file content
              void loadFileContent(tabCompositeKey);
            }
            // If not granted, still select the tab to show the permission message
            permissionRequestsInProgressRef.current.delete(tabCompositeKey);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            logger.error('Failed to request file permission', {
              compositeKey: tabCompositeKey,
              error: errMsg,
            });
            // Still select the tab to show the current status
            permissionRequestsInProgressRef.current.delete(tabCompositeKey);
          }
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
      logger.debug('Active tab effect triggered', {
        activeTabId,
        canLoadWithoutTree,
        treeLength: fileTree.length,
        tabsCount: tabs.length,
      });

      if (!activeTabId) {
        logger.debug('Bailing: no activeTabId');
        return;
      }
      // On Electron (canLoadWithoutTree), we can load files without the tree.
      // On web, we need the tree to get file handles.
      if (!canLoadWithoutTree && fileTree.length === 0) {
        logger.debug('Bailing: no tree and canLoadWithoutTree is false');
        return;
      }
      const activeTab = tabs.find((tab) => tab.id === activeTabId);
      if (!activeTab) {
        logger.debug('Bailing: activeTab not found in tabs', {
          activeTabId,
          tabs: tabs.map((t) => t.id),
        });
        return;
      }
      const alreadyLoaded = !!fileContents[activeTab.compositeKey];
      const isLoading = loadingFiles.has(activeTab.compositeKey);
      if (alreadyLoaded || isLoading) {
        logger.debug('Bailing: already loaded or loading', {
          alreadyLoaded,
          isLoading,
          compositeKey: activeTab.compositeKey,
        });
        return;
      }
      logger.debug('Loading file content for active tab', {
        compositeKey: activeTab.compositeKey,
        path: activeTab.path,
      });
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

    // Keep latest fileContents and loadingFiles in refs so the open-file callback can read
    // them without listing them as deps (which would cause infinite re-registration loops).
    // Sync via useLayoutEffect (after commit, not during render) to keep refs up-to-date.
    const fileContentsRef = useRef(fileContents);
    const loadingFilesRef = useRef(loadingFiles);
    useLayoutEffect(() => {
      fileContentsRef.current = fileContents;
    });
    useLayoutEffect(() => {
      loadingFilesRef.current = loadingFiles;
    });

    // Function to open a file in a tab (exposed globally for preview panel to use)
    const handleOpenFileInTab = useCallback(
      (compositeKey: string) => {
        const { path } = decodeFileSelection(compositeKey);
        // Create a more unique ID by prepending the root directory name
        const uniqueTabId = `${rootDirectoryHandle?.name ?? 'default'}:${compositeKey}`;
        openTab(path, uniqueTabId, compositeKey);

        // Load content if not already loaded or loading (read latest values via refs)
        if (!(fileContentsRef.current[compositeKey] || loadingFilesRef.current.has(compositeKey))) {
          void loadFileContent(compositeKey);
        }
      },
      [openTab, loadFileContent, rootDirectoryHandle]
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
