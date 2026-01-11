import { useAdapters, useToastManager } from '@brainstrike/file-explorer-hooks';
import type { DirectoryHandle } from '@brainstrike/file-system';
import { useReportGeneration, useReportManager } from '@brainstrike/hooks';
import { useCallback } from 'react';
import type { useFileExplorerStoreContext } from '../file-explorer-provider';

interface UsePreviewPanelReportActionsInput {
  store: ReturnType<typeof useFileExplorerStoreContext>;
  selectedFiles: Set<string>;
  fileContents: Record<string, string>;
  rootDirectoryHandle: FileSystemDirectoryHandle | DirectoryHandle | null;
  includeFilters: string[];
  excludeFilters: string[];
  useRegex: boolean;
  includeProjectTree: boolean;
  folderSummaryThreshold: number;
  loadMultipleFileContents: (compositeKeys: string[]) => Promise<void>;
}

export function usePreviewPanelReportActions(input: UsePreviewPanelReportActionsInput): {
  handleDownloadReport: () => void;
  handleCopyReport: () => void;
} {
  const { fileSystemAdapter } = useAdapters();
  const { toast, showToast } = useToastManager();

  // Get fresh file contents from store state when needed (avoids stale closure).
  // The store reference is stable, but we call getState() to get current values.
  const getFileContents = useCallback(() => input.store.getState().fileContents, [input.store]);
  // `useReportGeneration` models "no directory" as `undefined`, whereas the rest of the explorer
  // surfaces missing root directory as `null`.
  const rootDirectoryHandleForGeneration =
    input.rootDirectoryHandle === null ? undefined : input.rootDirectoryHandle;

  const { generateReportWithContent } = useReportGeneration({
    selectedFiles: input.selectedFiles,
    fileContents: input.fileContents,
    rootDirectoryHandle: rootDirectoryHandleForGeneration,
    fileSystemAdapter,
    includeFilters: input.includeFilters,
    excludeFilters: input.excludeFilters,
    useRegex: input.useRegex,
    includeProjectTree: input.includeProjectTree,
    folderSummaryThreshold: input.folderSummaryThreshold,
    loadMissingContent: input.loadMultipleFileContents,
    getFileContents,
  });

  const { handleDownloadReport, handleCopyReport } = useReportManager({
    rootDirectoryHandle: input.rootDirectoryHandle,
    generateReportWithContent,
    showToast,
    toast,
  });

  return {
    handleDownloadReport,
    handleCopyReport,
  };
}
