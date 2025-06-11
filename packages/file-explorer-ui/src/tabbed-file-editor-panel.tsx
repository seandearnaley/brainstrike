import { decodeFileSelection } from '@brainstrike/utils';
import { memo, useCallback, useEffect } from 'react';
import { useTabManager } from './hooks/use-tab-manager';
import { TabbedFileEditor } from './tabbed-file-editor';
import { useFileExplorer } from './use-file-explorer-context';

export interface TabbedFileEditorPanelProps {
  className?: string;
}

export const TabbedFileEditorPanel = memo<TabbedFileEditorPanelProps>(
  function TabbedFileEditorPanel({ className }) {
    const { fileContents, loadingFiles, loadFileContent } = useFileExplorer({
      onDisplayedFilePathsChange: () => {},
    });

    const { tabs, activeTabId, openTab, closeTab, setActiveTab, updateTabContent } =
      useTabManager();

    // Handle tab click
    const handleTabClick = useCallback(
      (tabId: string) => {
        setActiveTab(tabId);
      },
      [setActiveTab]
    );

    // Handle tab close
    const handleTabClose = useCallback(
      (tabId: string) => {
        closeTab(tabId);
      },
      [closeTab]
    );

    // Handle loading file content for tabs
    const handleLoadFileContent = useCallback(
      (compositeKey: string) => {
        loadFileContent(compositeKey);
      },
      [loadFileContent]
    );

    // Sync tab content with file contents when they load
    useEffect(() => {
      for (const tab of tabs) {
        const content = fileContents[tab.id];
        if (content && tab.content !== content) {
          updateTabContent(tab.id, content);
        }
      }
    }, [tabs, updateTabContent, fileContents]);

    // Function to open a file in a tab (exposed globally for preview panel to use)
    const handleOpenFileInTab = useCallback(
      (compositeKey: string) => {
        const { path } = decodeFileSelection(compositeKey);
        openTab(path, compositeKey);

        // Load content if not already loaded or loading
        if (!fileContents[compositeKey] && !loadingFiles.has(compositeKey)) {
          loadFileContent(compositeKey);
        }
      },
      [openTab, loadingFiles, fileContents, loadFileContent]
    );

    // Expose the open function globally for other components to use
    useEffect(() => {
      window.__openFileInTab = handleOpenFileInTab;
      return () => {
        window.__openFileInTab = undefined;
      };
    }, [handleOpenFileInTab]);

    return (
      <div className={className}>
        <TabbedFileEditor
          tabs={tabs}
          activeTabId={activeTabId}
          fileContents={fileContents}
          loadingFiles={loadingFiles}
          onTabClick={handleTabClick}
          onTabClose={handleTabClose}
          onLoadFileContent={handleLoadFileContent}
          decodeFileSelection={decodeFileSelection}
        />
      </div>
    );
  }
);

TabbedFileEditorPanel.displayName = 'TabbedFileEditorPanel';
