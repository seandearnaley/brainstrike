import { generateProjectTreeTextResult } from '@brainstrike/file-explorer/project-tree-text';
import { decodeFileSelection } from '@brainstrike/file-explorer/selection';
import { useAdapters } from '@brainstrike/file-explorer-hooks';
import { createLogger } from '@brainstrike/logging';
import { useUndoableAction } from '@brainstrike/ui';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { ContextExportOptions } from '../context-export-options';
import FileExplorerErrorBoundary from '../file-explorer-error-boundary';
import { useTextTokenCount } from '../indexing/use-text-token-count';
import { useTokenCounting } from '../indexing/use-token-counting';
import { usePreviewContentFailure } from '../preview/preview-content-failure';
import { PreviewContentFailureAlert } from '../preview/preview-content-failure-alert';
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

export const FileExplorerMiddlePanelBase = () => {
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

  const { selectedFilePaths, setSelectedFilesFromList } = useSelectionManager();
  const loadBackgroundFileContents = useCallback(
    (compositeKeys: string[]) => loadMultipleFileContents(compositeKeys, 'background'),
    [loadMultipleFileContents]
  );
  // Multi-root (Phase 6): resolve a RootId to its display name so the context
  // snapshot can label same-relative-path files from different roots.
  const rootDescriptors = useFileExplorerStoreSelector((s) => s.rootDescriptors);
  const resolveRootDisplayName = useCallback(
    (rootId: string): string | undefined => rootDescriptors[rootId]?.displayName,
    [rootDescriptors]
  );
  const resolveRootPath = useCallback(
    (rootId: string): string | undefined => rootDescriptors[rootId]?.path,
    [rootDescriptors]
  );
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
    excludeFilters,
    fileContents,
    folderSummaryThreshold,
    includeFilters,
    includeProjectTree,
    // Report generation owns its nested content reads. Passing the raw loader
    // prevents a missing-content read from replacing the outer copy/download
    // failure with a generic preview-only retry.
    loadMultipleFileContents: loadBackgroundFileContents,
    projectTreeUsesViewFilters,
    rootDirectoryHandle,
    selectedFiles: selectedFilePaths,
    store,
    useRegex,
  });
  const handleDownloadContext = reportActions.handleDownloadContext;
  const handleCopyContext = reportActions.handleCopyContext;
  const {
    failure: previewContentFailure,
    invalidate: invalidatePreviewContentFailure,
    loadPreviewFileContents,
    retry: retryPreviewContent,
    runContextExport,
  } = usePreviewContentFailure({
    handleCopyContext,
    handleDownloadContext,
    loadMultipleFileContents: loadBackgroundFileContents,
    selectedFilePaths,
  });
  // Phase 6 cross-root: the preview shows the EFFECTIVE UNION of every active
  // root's selection. Writing the remaining set back (file removal / undo) must
  // re-partition per root via setSelectedFilesFromList — the raw
  // core.handleSelectionChange funnels ALL roots' keys into the focused root's
  // top-level set, mis-attributing non-focused-root keys on the next focus
  // switch. In the single-root case this reduces to the same focused-root write.
  const handlePreviewSelectionChange = useCallback(
    (next: Set<string>) => {
      invalidatePreviewContentFailure();
      setSelectedFilesFromList([...next]);
    },
    [invalidatePreviewContentFailure, setSelectedFilesFromList]
  );

  const projectTreeResult = useMemo(
    () =>
      generateProjectTreeTextResult(
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
  const projectTreeText = projectTreeResult.ok ? projectTreeResult.text : '';
  const projectTreeValidationError = projectTreeResult.ok ? undefined : projectTreeResult.error;

  const { tokenCount: projectTreeTokenCount, loading: projectTreeTokenCountLoading } =
    useTextTokenCount({
      enabled: selectedFilePaths.size > 0 && projectTreeResult.ok,
      text: projectTreeText,
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
        getStateSnapshot: opts.getStateSnapshot,
        itemDescription: opts.itemDescription,
        // Adapt onUndo signature to match VirtualizedPreviewPanelTabbed expectation
        onUndo: (_item: unknown, snapshot: unknown) => opts.onUndo(key, snapshot as Set<string>),
      });
    },
    [performUndoableAction]
  );

  const flushPreviewContentRequests = useCallback(() => {
    previewContentFlushQueuedRef.current = false;
    const compositeKeys = Array.from(previewContentRequestQueueRef.current);
    previewContentRequestQueueRef.current.clear();
    if (compositeKeys.length === 0) {
      return;
    }
    void loadPreviewFileContents(compositeKeys).catch((error: unknown) => {
      logger.error('Preview file-content batch failed', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
        fileCount: compositeKeys.length,
      });
    });
  }, [loadPreviewFileContents]);

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
      runContextExport('download', options);
    },
    [runContextExport]
  );

  const handleCopyContextFromPanel = useCallback(
    (options: ContextExportOptions) => {
      runContextExport('copy', options);
    },
    [runContextExport]
  );

  return (
    <FileExplorerErrorBoundary>
      <div className="flex h-full flex-col overflow-hidden">
        <div className="flex flex-1 flex-col overflow-hidden">
          {previewContentFailure ? (
            <PreviewContentFailureAlert
              failure={previewContentFailure}
              onRetry={retryPreviewContent}
            />
          ) : null}
          <div className="flex-1 overflow-hidden bg-card/50">
            <PreviewPanel
              decodeFileSelection={decodeFileSelection}
              fileContents={fileContents}
              fileSizes={fileSizes}
              folderSummaryThreshold={folderSummaryThreshold}
              includeProjectTree={includeProjectTree}
              loadingFiles={loadingFiles}
              onCopyContext={handleCopyContextFromPanel}
              onDownloadContext={handleDownloadContextFromPanel}
              onFolderSummaryThresholdChange={setFolderSummaryThreshold}
              onIncludeProjectTreeChange={handleIncludeProjectTreeChange}
              onProjectTreeUsesViewFiltersChange={setProjectTreeUsesViewFilters}
              onRequestFileContent={handlePreviewContentRequest}
              onSelectionChange={handlePreviewSelectionChange}
              onTokenBudgetChange={setTokenBudget}
              performUndoableAction={performUndoableActionForPanel}
              projectTreeTokenCount={projectTreeTokenCount}
              projectTreeTokenCountLoading={projectTreeTokenCountLoading}
              projectTreeUsesViewFilters={projectTreeUsesViewFilters}
              projectTreeValidationError={projectTreeValidationError}
              resolveRootDisplayName={resolveRootDisplayName}
              resolveRootPath={resolveRootPath}
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
