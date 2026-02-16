import type { DirectoryHandle, FileSystemAdapter } from '@brainstrike/file-system';
import {
  type ContextLineRange,
  generateContext,
  generateContextFromAdapter,
} from '@brainstrike/utils';

export interface ReportGenerationRequest {
  selectedFiles: Set<string>;
  fileContents: Record<string, string>;
  rootDirectoryHandle: FileSystemDirectoryHandle | DirectoryHandle;
  includeFilters: string[];
  excludeFilters: string[];
  useRegex: boolean;
  includeProjectTree: boolean;
  projectTreeUsesViewFilters?: boolean;
  folderSummaryThreshold: number;
  selectedLineRangesByFile?: Record<string, ContextLineRange[]>;
  useTapestryRanges?: boolean;
}

export interface ProgressEvent {
  loaded: number;
  total: number;
}

export interface ReportGenerationWorkerOptions {
  fileSystemAdapter?: FileSystemAdapter;
}

export function createReportGenerationWorker({
  fileSystemAdapter,
}: ReportGenerationWorkerOptions = {}) {
  return async function generate(
    request: ReportGenerationRequest,
    onProgress?: (e: ProgressEvent) => void
  ): Promise<string> {
    onProgress?.({ loaded: 0, total: 1 });

    const {
      selectedFiles,
      fileContents,
      rootDirectoryHandle,
      includeFilters,
      excludeFilters,
      useRegex,
      includeProjectTree,
      projectTreeUsesViewFilters,
      folderSummaryThreshold,
      selectedLineRangesByFile,
      useTapestryRanges = false,
    } = request;
    const resolvedProjectTreeUsesViewFilters = projectTreeUsesViewFilters ?? false;
    const hasExplicitTreeFilterMode = projectTreeUsesViewFilters !== undefined;
    const generationOptions =
      hasExplicitTreeFilterMode || useTapestryRanges || selectedLineRangesByFile
        ? {
            ...(hasExplicitTreeFilterMode
              ? { projectTreeUsesViewFilters: resolvedProjectTreeUsesViewFilters }
              : {}),
            ...(selectedLineRangesByFile ? { selectedLineRangesByFile } : {}),
            useTapestryRanges,
          }
        : undefined;

    const context =
      fileSystemAdapter && 'platform' in rootDirectoryHandle
        ? await generateContextFromAdapter(
            selectedFiles,
            fileContents,
            fileSystemAdapter,
            rootDirectoryHandle as DirectoryHandle,
            includeFilters,
            excludeFilters,
            useRegex,
            includeProjectTree,
            folderSummaryThreshold,
            generationOptions
          )
        : await generateContext(
            selectedFiles,
            fileContents,
            rootDirectoryHandle as FileSystemDirectoryHandle,
            includeFilters,
            excludeFilters,
            useRegex,
            includeProjectTree,
            folderSummaryThreshold,
            generationOptions
          );

    onProgress?.({ loaded: 1, total: 1 });
    return context;
  };
}
