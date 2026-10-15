import {
  type ContextGenerationOverrides,
  createReportGenerationWorker,
  useAdapters,
  useReportGeneration,
  useToastManager,
} from '@brainstrike/file-explorer-hooks';
import type { DirectoryHandle } from '@brainstrike/file-system';
import { type ContextExportOutcome, useReportManager } from '@brainstrike/hooks';
import { useCallback } from 'react';
import type { ContextExportOptions } from '../context-export-options';
import type { useFileExplorerStoreContext } from './file-explorer-provider';

interface UseContextExportActionsInput {
  excludeFilters: string[];
  fileContents: Record<string, string>;
  folderSummaryThreshold: number;
  includeFilters: string[];
  includeProjectTree: boolean;
  loadMultipleFileContents: (compositeKeys: string[]) => Promise<void>;
  projectTreeUsesViewFilters?: boolean;
  rootDirectoryHandle: DirectoryHandle | null;
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
    selectedLineRangesByFile: Object.fromEntries(
      Object.entries(options.selectedLineRangesByFile).map(([fileKey, ranges]) => [
        fileKey,
        ranges.map((range) => ({
          endLine: range.endLine,
          isActive: range.isActive,
          startLine: range.startLine,
        })),
      ])
    ),
  };
};

export function useContextExportActions(input: UseContextExportActionsInput): {
  handleDownloadContext: (options?: ContextExportOptions) => Promise<ContextExportOutcome>;
  handleCopyContext: (options?: ContextExportOptions) => Promise<ContextExportOutcome>;
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
    excludeFilters: input.excludeFilters,
    fileContents: input.fileContents,
    fileSystemAdapter,
    folderSummaryThreshold: input.folderSummaryThreshold,
    getFileContents,
    getRootDisplayInfoById,
    includeFilters: input.includeFilters,
    includeProjectTree: input.includeProjectTree,
    loadMissingContent: input.loadMultipleFileContents,
    projectTreeUsesViewFilters: input.projectTreeUsesViewFilters ?? false,
    rootDirectoryHandle: rootDirectoryHandleForGeneration,
    selectedFiles: input.selectedFiles,
    useRegex: input.useRegex,
  });
  const generateContextWithContent = generation.generateContextWithContent;

  const manager = useReportManager({
    generateContextWithContent,
    rootDirectoryHandle: input.rootDirectoryHandle,
    toast,
  });

  const handleDownloadContext = manager.handleDownloadContext;
  const handleCopyContext = manager.handleCopyContext;

  const handleDownloadContextWithOptions = useCallback(
    async (options?: ContextExportOptions): Promise<ContextExportOutcome> =>
      handleDownloadContext(toContextGenerationOverrides(options)),
    [handleDownloadContext]
  );

  const handleCopyContextWithOptions = useCallback(
    async (options?: ContextExportOptions): Promise<ContextExportOutcome> =>
      handleCopyContext(toContextGenerationOverrides(options)),
    [handleCopyContext]
  );

  return {
    handleCopyContext: handleCopyContextWithOptions,
    handleDownloadContext: handleDownloadContextWithOptions,
  };
}
