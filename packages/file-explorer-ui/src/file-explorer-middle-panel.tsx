import { FileExplorerErrorBoundary, FileExplorerHeader } from '@brainstrike/file-explorer-ui';
import { useIdeFileEditor, useUndoableAction } from '@brainstrike/ui';
import { countTokensHeuristic, decodeFileSelection, estimateTokenCost } from '@brainstrike/utils';
import { useCallback } from 'react';
import { PreviewPanel } from './preview-panel';
import { useFileExplorer } from './use-file-explorer-context';
import { useSelectionManager } from './use-selection-manager-context';

/**
 * FileExplorerMiddlePanel - Contains the preview panel and action buttons
 * This component can be used independently in the middle panel of an IDE layout
 */
export const FileExplorerMiddlePanel: React.FC = () => {
  const { fileContents, loadingFiles } = useFileExplorer();

  const { selectedFilePaths, handleSelectionChange } = useSelectionManager({
    onSelectionLimitExceeded: () => {}, // Handled by left panel
  });

  const { performUndoableAction } = useUndoableAction();

  const performUndoableActionForPanel = (
    key: string,
    _itemKey: string, // renamed to avoid unused var lint
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
      <div className="flex flex-col h-full overflow-hidden">
        <FileExplorerHeader />
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 overflow-hidden border-t md:border-t-0 md:border-l bg-card/50">
            <PreviewPanel
              selectedFiles={selectedFilePaths}
              fileContents={fileContents}
              loadingFiles={loadingFiles}
              onSelectionChange={handleSelectionChange}
              decodeFileSelection={decodeFileSelection}
              countTokensHeuristic={countTokensHeuristic}
              estimateTokenCost={estimateTokenCost}
              performUndoableAction={performUndoableActionForPanel}
              onFileClick={handleFileClick}
            />
          </div>
        </div>
      </div>
    </FileExplorerErrorBoundary>
  );
};
