import { useToastManager } from '@brainstrike/file-explorer-hooks';
import { FileExplorerErrorBoundary, FileExplorerHeader } from '@brainstrike/file-explorer-ui';
import { useIdeFileEditor, useUndoableAction } from '@brainstrike/ui';
import { decodeFileSelection, generateProjectTreeText } from '@brainstrike/utils';
import { useCallback, useMemo } from 'react';
import { useFileExplorerStoreContext } from './file-explorer-provider';
import { usePreviewPanelReportActions } from './hooks/use-preview-panel-report-actions';
import { useTextTokenCount } from './hooks/use-text-token-count';
import { PreviewPanel } from './preview-panel';
import { useFileExplorer } from './use-file-explorer-context';
import { useSelectionManager } from './use-selection-manager-context';
import { useTokenCounting } from './use-token-counting';
import { buildFileNodeCache } from './utils/file-node-cache';

type FileExplorerMiddlePanelBaseProps = {
  estimateTokenCost?: (tokens: number) => number;
};

export const FileExplorerMiddlePanelBase: React.FC<FileExplorerMiddlePanelBaseProps> = ({
  estimateTokenCost,
}) => {
  const {
    fileContents,
    loadingFiles,
    fileTree: rawFileTree,
    rootDirectoryHandle,
    loadMultipleFileContents,
  } = useFileExplorer();
  const fileTree = Array.isArray(rawFileTree) ? rawFileTree : [];

  const tokenCounting = useTokenCounting();
  const { handleSelectionLimitError } = useToastManager();

  const store = useFileExplorerStoreContext();
  const [
    tokenBudget,
    setTokenBudget,
    includeProjectTree,
    setIncludeProjectTree,
    includeFilters,
    excludeFilters,
    useRegex,
    folderSummaryThreshold,
    setFolderSummaryThreshold,
  ] = store(
    (s) =>
      [
        s.tokenBudget,
        s.setTokenBudget,
        s.includeProjectTree,
        s.setIncludeProjectTree,
        s.includeFilters,
        s.excludeFilters,
        s.useRegex,
        s.folderSummaryThreshold,
        s.setFolderSummaryThreshold,
      ] as const
  );

  const { selectedFilePaths, handleSelectionChange } = useSelectionManager({
    onSelectionLimitExceeded: handleSelectionLimitError,
  });

  const fileNodeCache = useMemo(() => buildFileNodeCache(fileTree), [fileTree]);

  const fileSizes = useMemo(() => {
    if (selectedFilePaths.size === 0 || fileNodeCache.size === 0) {
      return {};
    }

    const sizes: Record<string, number> = {};

    for (const compositeKey of selectedFilePaths) {
      try {
        const { folderId, path } = decodeFileSelection(compositeKey);
        const node = fileNodeCache.get(folderId)?.get(path);
        if (node?.type === 'file' && typeof node.size === 'number') {
          sizes[compositeKey] = node.size;
        }
      } catch {
        // Ignore invalid composite keys
      }
    }

    return sizes;
  }, [fileNodeCache, selectedFilePaths]);

  const { handleDownloadReport, handleCopyReport } = usePreviewPanelReportActions({
    store,
    selectedFiles: selectedFilePaths,
    fileContents,
    rootDirectoryHandle,
    includeFilters,
    excludeFilters,
    useRegex,
    includeProjectTree,
    folderSummaryThreshold,
    loadMultipleFileContents,
  });

  const projectTreeText = useMemo(
    () =>
      generateProjectTreeText(
        fileTree,
        includeFilters,
        excludeFilters,
        useRegex,
        folderSummaryThreshold
      ),
    [excludeFilters, fileTree, folderSummaryThreshold, includeFilters, useRegex]
  );

  const { tokenCount: projectTreeTokenCount, loading: projectTreeTokenCountLoading } =
    useTextTokenCount({
      text: projectTreeText,
      enabled: selectedFilePaths.size > 0,
    });

  const { performUndoableAction } = useUndoableAction();

  const performUndoableActionForPanel = useCallback(
    (
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
    },
    [performUndoableAction]
  );

  const { openFileInTab } = useIdeFileEditor();

  const handleFileClick = useCallback(
    (compositeKey: string) => {
      if (openFileInTab) {
        openFileInTab(compositeKey);
      }
    },
    [openFileInTab]
  );

  const handlePreviewContentRequest = useCallback(
    (compositeKey: string) => {
      void loadMultipleFileContents([compositeKey]);
    },
    [loadMultipleFileContents]
  );

  return (
    <FileExplorerErrorBoundary>
      <div className="flex h-full flex-col overflow-hidden">
        <FileExplorerHeader />
        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="flex-1 overflow-hidden border-t bg-card/50 md:border-t-0 md:border-l">
            <PreviewPanel
              decodeFileSelection={decodeFileSelection}
              {...(estimateTokenCost ? { estimateTokenCost } : {})}
              fileContents={fileContents}
              fileSizes={fileSizes}
              folderSummaryThreshold={folderSummaryThreshold}
              includeProjectTree={includeProjectTree}
              loadingFiles={loadingFiles}
              onCopyReport={handleCopyReport}
              onDownloadReport={handleDownloadReport}
              onFileClick={handleFileClick}
              onFolderSummaryThresholdChange={setFolderSummaryThreshold}
              onIncludeProjectTreeChange={setIncludeProjectTree}
              onRequestFileContent={handlePreviewContentRequest}
              onSelectionChange={handleSelectionChange}
              onTokenBudgetChange={setTokenBudget}
              performUndoableAction={performUndoableActionForPanel}
              projectTreeTokenCount={projectTreeTokenCount}
              projectTreeTokenCountLoading={projectTreeTokenCountLoading}
              selectedFiles={selectedFilePaths}
              tokenBudget={tokenBudget}
              tokenCounting={tokenCounting}
            />
          </div>
        </div>
      </div>
    </FileExplorerErrorBoundary>
  );
};

FileExplorerMiddlePanelBase.displayName = 'FileExplorerMiddlePanelBase';
