import { useIdeFileEditor } from '@brainstrike/ui';
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
    const { registerOpenFileInTab } = useIdeFileEditor();
    const { rootDirectoryHandle, fileContents, loadingFiles, loadFileContent } = useFileExplorer({
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
        const content = fileContents[tab.compositeKey];
        if (content && tab.content !== content) {
          updateTabContent(tab.id, content);
        }
      }
    }, [tabs, updateTabContent, fileContents]);

    // Function to open a file in a tab (exposed globally for preview panel to use)
    const handleOpenFileInTab = useCallback(
      (compositeKey: string) => {
        const { path } = decodeFileSelection(compositeKey);
        // Create a more unique ID by prepending the root directory name
        const uniqueTabId = `${rootDirectoryHandle?.name ?? 'default'}:${compositeKey}`;
        openTab(path, uniqueTabId, compositeKey);

        // Load content if not already loaded or loading
        if (!fileContents[compositeKey] && !loadingFiles.has(compositeKey)) {
          loadFileContent(compositeKey);
        }
      },
      [openTab, loadFileContent, rootDirectoryHandle, fileContents, loadingFiles] // Remove fileContents and loadingFiles to prevent infinite loops
    );

    // Register the openFileInTab function with the IDE layout context
    useEffect(() => {
      registerOpenFileInTab(handleOpenFileInTab);
    }, [registerOpenFileInTab, handleOpenFileInTab]);

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
