import { useAdapters } from '@brainstrike/file-explorer-hooks';
import { useIdeFileEditor, useUndoableAction } from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils/logger';
import { decodeFileSelection } from '@brainstrike/utils/selection-utils';
import { generateProjectTreeText } from '@brainstrike/utils/tree-generator';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { ContextExportOptions } from '../context-export-options';
import FileExplorerErrorBoundary from '../file-explorer-error-boundary';
import { useTextTokenCount } from '../indexing/use-text-token-count';
import { useTokenCounting } from '../indexing/use-token-counting';
import { PreviewPanel } from '../preview/preview-panel';
import { usePreviewPanelReportActions } from '../preview/use-preview-panel-report-actions';
import { buildFileNodeCache } from '../utils/file-node-cache';
import { persistFileExplorerStateImmediately } from '../utils/persist-file-explorer-state';
import {
  useFileExplorerStoreContext,
  useFileExplorerStoreSelector,
} from './file-explorer-provider';
import { useFileExplorer } from './use-file-explorer-context';
import { useSelectionManager } from './use-selection-manager-context';

const logger = createLogger('FileExplorerMiddlePanelBase');

interface FileExplorerMiddlePanelBaseProps {
  estimateTokenCost?: (tokens: number) => number;
}

export const FileExplorerMiddlePanelBase: React.FC<FileExplorerMiddlePanelBaseProps> = ({
  estimateTokenCost,
}) => {
  const {
    fileContents,
    loadingFiles,
    fileTree: rawFilteredFileTree,
    unfilteredFileTree: rawUnfilteredFileTree,
    rootDirectoryHandle,
    loadMultipleFileContents,
  } = useFileExplorer();
  const filteredFileTree = Array.isArray(rawFilteredFileTree) ? rawFilteredFileTree : [];
  const unfilteredFileTree = Array.isArray(rawUnfilteredFileTree)
    ? rawUnfilteredFileTree
    : filteredFileTree;

  const tokenCounting = useTokenCounting();
  const { storageAdapter } = useAdapters();

  const store = useFileExplorerStoreContext();
  const previewContentRequestQueueRef = useRef(new Set<string>());
  const previewContentFlushQueuedRef = useRef(false);
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
  ] = useFileExplorerStoreSelector(
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

  const { selectedFilePaths, handleSelectionChange } = useSelectionManager();
  const [projectTreeUsesViewFilters, setProjectTreeUsesViewFilters] = useState(false);

  const fileNodeCache = useMemo(() => buildFileNodeCache(unfilteredFileTree), [unfilteredFileTree]);
  const handleIncludeProjectTreeChange = useCallback(
    (checked: boolean) => {
      setIncludeProjectTree(checked);
      void persistFileExplorerStateImmediately(store, storageAdapter).catch((error: unknown) => {
        logger.error('Failed to persist includeProjectTree immediately', { error });
      });
    },
    [setIncludeProjectTree, store, storageAdapter]
  );

  const projectTreeSource = projectTreeUsesViewFilters ? filteredFileTree : unfilteredFileTree;

  const fileSizes = useMemo(() => {
    if (selectedFilePaths.size === 0 || fileNodeCache.size === 0) {
      return {};
    }

    const sizes: Record<string, number> = {};

    for (const compositeKey of selectedFilePaths) {
      let folderId: string | undefined;
      let path: string | undefined;
      try {
        const decoded = decodeFileSelection(compositeKey);
        folderId = decoded.folderId;
        path = decoded.path;
      } catch {
        // Ignore invalid composite keys
        continue;
      }
      if (!(folderId && path)) {
        continue;
      }
      const folderCache = fileNodeCache.get(folderId);
      if (!folderCache) {
        continue;
      }
      const node = folderCache.get(path);
      if (node && node.type === 'file' && typeof node.size === 'number') {
        sizes[compositeKey] = node.size;
      }
    }

    return sizes;
  }, [fileNodeCache, selectedFilePaths]);

  const reportActions = usePreviewPanelReportActions({
    store,
    selectedFiles: selectedFilePaths,
    fileContents,
    rootDirectoryHandle,
    includeFilters,
    excludeFilters,
    useRegex,
    includeProjectTree,
    projectTreeUsesViewFilters,
    folderSummaryThreshold,
    loadMultipleFileContents,
  });
  const handleDownloadContext = reportActions.handleDownloadContext;
  const handleCopyContext = reportActions.handleCopyContext;

  const projectTreeText = useMemo(
    () =>
      generateProjectTreeText(
        projectTreeSource,
        projectTreeUsesViewFilters ? includeFilters : [],
        projectTreeUsesViewFilters ? excludeFilters : [],
        projectTreeUsesViewFilters ? useRegex : false,
        folderSummaryThreshold
      ),
    [
      excludeFilters,
      projectTreeSource,
      folderSummaryThreshold,
      includeFilters,
      projectTreeUsesViewFilters,
      useRegex,
    ]
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

  const flushPreviewContentRequests = useCallback(() => {
    previewContentFlushQueuedRef.current = false;
    const compositeKeys = Array.from(previewContentRequestQueueRef.current);
    previewContentRequestQueueRef.current.clear();
    if (compositeKeys.length === 0) {
      return;
    }
    void loadMultipleFileContents(compositeKeys);
  }, [loadMultipleFileContents]);

  const handlePreviewContentRequest = useCallback(
    (compositeKey: string) => {
      previewContentRequestQueueRef.current.add(compositeKey);
      if (previewContentFlushQueuedRef.current) {
        return;
      }
      previewContentFlushQueuedRef.current = true;
      queueMicrotask(flushPreviewContentRequests);
    },
    [flushPreviewContentRequests]
  );

  const handleDownloadContextFromPanel = useCallback(
    (options: ContextExportOptions) => {
      void handleDownloadContext(options);
    },
    [handleDownloadContext]
  );

  const handleCopyContextFromPanel = useCallback(
    (options: ContextExportOptions) => {
      void handleCopyContext(options);
    },
    [handleCopyContext]
  );

  return (
    <FileExplorerErrorBoundary>
      <div className="flex h-full flex-col overflow-hidden">
        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="flex-1 overflow-hidden bg-card/50">
            <PreviewPanel
              decodeFileSelection={decodeFileSelection}
              {...(estimateTokenCost ? { estimateTokenCost } : {})}
              fileContents={fileContents}
              fileSizes={fileSizes}
              folderSummaryThreshold={folderSummaryThreshold}
              includeProjectTree={includeProjectTree}
              loadingFiles={loadingFiles}
              onCopyContext={handleCopyContextFromPanel}
              onDownloadContext={handleDownloadContextFromPanel}
              onFileClick={handleFileClick}
              onFolderSummaryThresholdChange={setFolderSummaryThreshold}
              onIncludeProjectTreeChange={handleIncludeProjectTreeChange}
              onProjectTreeUsesViewFiltersChange={setProjectTreeUsesViewFilters}
              onRequestFileContent={handlePreviewContentRequest}
              onSelectionChange={handleSelectionChange}
              onTokenBudgetChange={setTokenBudget}
              performUndoableAction={performUndoableActionForPanel}
              projectTreeTokenCount={projectTreeTokenCount}
              projectTreeTokenCountLoading={projectTreeTokenCountLoading}
              projectTreeUsesViewFilters={projectTreeUsesViewFilters}
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
