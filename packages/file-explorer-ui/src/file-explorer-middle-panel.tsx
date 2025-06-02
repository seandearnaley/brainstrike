import { FileExplorerErrorBoundary } from '@brainstrike/file-explorer-ui';
import { FileExplorerHeader } from '@brainstrike/file-explorer-ui';
import { useUndoableAction } from '@brainstrike/hooks';
import { LoadingFallback } from '@brainstrike/ui';
import { decodeFileSelection } from '@brainstrike/utils';
import { countTokensHeuristic, estimateTokenCost } from '@brainstrike/utils';
import { Suspense, lazy } from 'react';
import { useFileExplorer } from './use-file-explorer-context';
import { useSelectionManager } from './use-selection-manager-context';

// Lazy load the preview panel component
const FileExplorerMainPanel = lazy(() =>
  import('@brainstrike/file-explorer-ui').then((m) => ({
    default: m.PreviewPanel as unknown as React.ComponentType<Record<string, unknown>>,
  }))
);

/**
 * FileExplorerMiddlePanel - Contains the preview panel and action buttons
 * This component can be used independently in the middle panel of an IDE layout
 */
export const FileExplorerMiddlePanel: React.FC = () => {
  const { fileContents, loadingFiles, rootDirectoryHandle } = useFileExplorer({
    onDisplayedFilePathsChange: () => {}, // Empty callback since this component doesn't need to track displayed files
  });

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
      // Adapt onUndo signature to match PreviewPanel expectation
      onUndo: (_item: unknown, snapshot: unknown) => opts.onUndo(key, snapshot as Set<string>),
    });
  };

  return (
    <FileExplorerErrorBoundary>
      <div className="flex flex-col h-full overflow-hidden">
        <FileExplorerHeader />
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 overflow-hidden border-t md:border-t-0 md:border-l bg-card/50">
            <Suspense fallback={<LoadingFallback />}>
              <FileExplorerMainPanel
                rootDirectoryHandle={rootDirectoryHandle}
                selectedFiles={selectedFilePaths}
                fileContents={fileContents}
                loadingFiles={loadingFiles}
                onSelectionChange={handleSelectionChange}
                decodeFileSelection={decodeFileSelection}
                countTokensHeuristic={countTokensHeuristic}
                estimateTokenCost={estimateTokenCost}
                performUndoableAction={performUndoableActionForPanel}
              />
            </Suspense>
          </div>
        </div>
      </div>
    </FileExplorerErrorBoundary>
  );
};
