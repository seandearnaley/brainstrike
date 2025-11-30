import { FileExplorerErrorBoundary, FileExplorerHeader } from '@brainstrike/file-explorer-ui';
import { useIdeFileEditor, useUndoableAction } from '@brainstrike/ui';
import { decodeFileSelection } from '@brainstrike/utils';
import { useCallback } from 'react';
import { PreviewPanel } from './preview-panel';
import { useFileExplorer } from './use-file-explorer-context';
import { useSelectionManager } from './use-selection-manager-context';
import { useTokenCounting } from './use-token-counting';

/**
 * FileExplorerMiddlePanelTabbed - Contains the preview panel with tab support
 * This component can be used independently in the middle panel of an IDE layout
 */
export const FileExplorerMiddlePanelTabbed: React.FC = () => {
  const { fileContents, loadingFiles } = useFileExplorer();
  const tokenCounting = useTokenCounting();

  const { selectedFilePaths, handleSelectionChange } = useSelectionManager({
    onSelectionLimitExceeded: () => {}, // Handled by left panel
  });

  const { performUndoableAction } = useUndoableAction();

  const performUndoableActionForPanel = (
    key: string,
    _itemKey: string,
    opts: {
      actionName: string;
      itemDescription: string;
      getStateSnapshot: () => Set<string>;
      onUndo: (key: string, snapshot: Set<string>) => void;
    }
  ) => {
    performUndoableAction(key, opts.getStateSnapshot(), {
      actionName: opts.actionName,
      itemDescription: opts.itemDescription,
      getStateSnapshot: opts.getStateSnapshot,
      // Adapt onUndo signature to match VirtualizedPreviewPanelTabbed expectation
      onUndo: (_item: unknown, snapshot: unknown) => opts.onUndo(key, snapshot as Set<string>),
    });
  };

  const { openFileInTab } = useIdeFileEditor();

  // Handle file clicks to open in tabs
  const handleFileClick = useCallback(
    (compositeKey: string) => {
      if (openFileInTab) {
        openFileInTab(compositeKey);
      }
    },
    [openFileInTab]
  );

  return (
    <FileExplorerErrorBoundary>
      <div className="flex h-full flex-col overflow-hidden">
        <FileExplorerHeader />
        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="flex-1 overflow-hidden border-t bg-card/50 md:border-t-0 md:border-l">
            <PreviewPanel
              decodeFileSelection={decodeFileSelection}
              fileContents={fileContents}
              loadingFiles={loadingFiles}
              onFileClick={handleFileClick}
              onSelectionChange={handleSelectionChange}
              performUndoableAction={performUndoableActionForPanel}
              selectedFiles={selectedFilePaths}
              tokenCounting={tokenCounting}
            />
          </div>
        </div>
      </div>
    </FileExplorerErrorBoundary>
  );
};
