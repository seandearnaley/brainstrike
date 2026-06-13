import { useAdapters, useToastManager } from '@brainstrike/file-explorer-hooks';
import type { DirectoryHandle } from '@brainstrike/file-system';
import type { ContextGenerationOverrides } from '@brainstrike/hooks';
import { useReportGeneration, useReportManager } from '@brainstrike/hooks';
import { createReportGenerationWorker } from '@brainstrike/workers/report-generation-worker';
import { useCallback } from 'react';
import type { ContextExportOptions } from '../context-export-options';
import type { useFileExplorerStoreContext } from '../shell/file-explorer-provider';

interface UsePreviewPanelReportActionsInput {
  excludeFilters: string[];
  fileContents: Record<string, string>;
  folderSummaryThreshold: number;
  includeFilters: string[];
  includeProjectTree: boolean;
  loadMultipleFileContents: (compositeKeys: string[]) => Promise<void>;
  projectTreeUsesViewFilters?: boolean;
  rootDirectoryHandle: FileSystemDirectoryHandle | DirectoryHandle | null;
  selectedFiles: Set<string>;
  store: ReturnType<typeof useFileExplorerStoreContext>;
  useRegex: boolean;
}

// Strip UI-only range fields (id, color) before passing ranges to context generation.
const toContextGenerationOverrides = (
  options: ContextExportOptions | undefined
): ContextGenerationOverrides | undefined => {
  if (!options) {
    return;
  }

  return {
    projectTreeUsesViewFilters: options.projectTreeUsesViewFilters,
    useTapestryRanges: options.useTapestryRanges,
    selectedLineRangesByFile: Object.fromEntries(
      Object.entries(options.selectedLineRangesByFile).map(([fileKey, ranges]) => [
        fileKey,
        ranges.map((range) => ({
          startLine: range.startLine,
          endLine: range.endLine,
          isActive: range.isActive,
        })),
      ])
    ),
  };
};

export function usePreviewPanelReportActions(input: UsePreviewPanelReportActionsInput): {
  handleDownloadContext: (options?: ContextExportOptions) => Promise<void>;
  handleCopyContext: (options?: ContextExportOptions) => Promise<void>;
} {
  const { fileSystemAdapter } = useAdapters();
  const { toast } = useToastManager();

  // Get fresh file contents from store state when needed (avoids stale closure).
  // The store reference is stable, but we call getState() to get current values.
  const getFileContents = useCallback(() => input.store.getState().fileContents, [input.store]);
  // Storage v5: selection keys carry RootId UUIDs — give the generator the
  // descriptor registry so report file paths render human-readably.
  const getRootDisplayInfoById = useCallback(() => {
    const descriptors = input.store.getState().rootDescriptors;
    return Object.fromEntries(
      Object.entries(descriptors).map(([rootId, descriptor]) => [
        rootId,
        { displayName: descriptor.displayName, path: descriptor.path },
      ])
    );
  }, [input.store]);
  // `useReportGeneration` models "no directory" as `undefined`, whereas the rest of the explorer
  // surfaces missing root directory as `null`.
  const rootDirectoryHandleForGeneration =
    input.rootDirectoryHandle === null ? undefined : input.rootDirectoryHandle;

  const generation = useReportGeneration({
    createReportGenerator: createReportGenerationWorker,
    selectedFiles: input.selectedFiles,
    fileContents: input.fileContents,
    rootDirectoryHandle: rootDirectoryHandleForGeneration,
    fileSystemAdapter,
    includeFilters: input.includeFilters,
    excludeFilters: input.excludeFilters,
    useRegex: input.useRegex,
    includeProjectTree: input.includeProjectTree,
    projectTreeUsesViewFilters: input.projectTreeUsesViewFilters ?? false,
    folderSummaryThreshold: input.folderSummaryThreshold,
    loadMissingContent: input.loadMultipleFileContents,
    getFileContents,
    getRootDisplayInfoById,
  });
  const generateContextWithContent = generation.generateContextWithContent;

  const manager = useReportManager({
    rootDirectoryHandle: input.rootDirectoryHandle,
    generateContextWithContent,
    toast,
  });

  const handleDownloadContext = manager.handleDownloadContext;
  const handleCopyContext = manager.handleCopyContext;

  const handleDownloadContextWithOptions = useCallback(
    async (options?: ContextExportOptions): Promise<void> =>
      handleDownloadContext(toContextGenerationOverrides(options)),
    [handleDownloadContext]
  );

  const handleCopyContextWithOptions = useCallback(
    async (options?: ContextExportOptions): Promise<void> =>
      handleCopyContext(toContextGenerationOverrides(options)),
    [handleCopyContext]
  );

  return {
    handleDownloadContext: handleDownloadContextWithOptions,
    handleCopyContext: handleCopyContextWithOptions,
  };
}
