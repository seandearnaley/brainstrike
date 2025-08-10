import { FileExplorerErrorBoundary, FileExplorerHeader } from '@brainstrike/file-explorer-ui';
import { useUndoableAction } from '@brainstrike/hooks';
import { useIdeFileEditor } from '@brainstrike/ui';
import { countTokensHeuristic, decodeFileSelection } from '@brainstrike/utils';
import { useCallback } from 'react';
import { PreviewPanel } from './preview-panel';
import { useFileExplorer } from './use-file-explorer-context';
import { useSelectionManager } from './use-selection-manager-context';

/**
 * FileExplorerMiddlePanelTabbed - Contains the preview panel with tab support
 * This component can be used independently in the middle panel of an IDE layout
 */
export const FileExplorerMiddlePanelTabbed: React.FC = () => {
  const { fileContents, loadingFiles } = useFileExplorer();

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
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <FileExplorerHeader />
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          <div className="flex-1 min-h-0 overflow-hidden border-t md:border-t-0 md:border-l bg-card/50">
            <PreviewPanel
              selectedFiles={selectedFilePaths}
              fileContents={fileContents}
              loadingFiles={loadingFiles}
              onSelectionChange={handleSelectionChange}
              decodeFileSelection={decodeFileSelection}
              countTokensHeuristic={countTokensHeuristic}
              performUndoableAction={performUndoableActionForPanel}
              onFileClick={handleFileClick}
            />
          </div>
        </div>
      </div>
    </FileExplorerErrorBoundary>
  );
};
