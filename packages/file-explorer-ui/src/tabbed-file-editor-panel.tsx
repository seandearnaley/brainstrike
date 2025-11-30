import { useIdeFileEditor } from '@brainstrike/ui';
import { decodeFileSelection } from '@brainstrike/utils';
import { memo, useCallback, useEffect } from 'react';
import { useTabManager } from './hooks/use-tab-manager';
import { TabbedFileEditor } from './tabbed-file-editor';
import { useFileExplorer } from './use-file-explorer-context';

export type TabbedFileEditorPanelProps = {
  className?: string;
};

export const TabbedFileEditorPanel = memo<TabbedFileEditorPanelProps>(
  function TabbedFileEditorPanel({ className }) {
    const { registerOpenFileInTab } = useIdeFileEditor();
    const { rootDirectoryHandle, fileContents, loadingFiles, loadFileContent } = useFileExplorer();

    const { tabs, activeTabId, openTab, closeTab, setActiveTab } = useTabManager();

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
        void loadFileContent(compositeKey);
      },
      [loadFileContent]
    );

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

    return (
      <div className={className}>
        <TabbedFileEditor
          activeTabId={activeTabId}
          decodeFileSelection={decodeFileSelection}
          fileContents={fileContents}
          loadingFiles={loadingFiles}
          onLoadFileContent={handleLoadFileContent}
          onTabClick={handleTabClick}
          onTabClose={handleTabClose}
          tabs={tabs}
        />
      </div>
    );
  }
);

TabbedFileEditorPanel.displayName = 'TabbedFileEditorPanel';
