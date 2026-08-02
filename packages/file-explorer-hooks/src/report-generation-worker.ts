import {
  generateContext,
  generateContextFromAdapter,
} from '@brainstrike/file-explorer/context-generation';
import type { DirectoryHandle } from '@brainstrike/file-system';
import type {
  ReportGenerationRequest,
  ReportGenerationWorkerOptions,
  ReportProgressEvent,
} from './use-report-generation.js';

export type ProgressEvent = ReportProgressEvent;

export function createReportGenerationWorker({
  fileSystemAdapter,
}: ReportGenerationWorkerOptions = {}) {
  return async function generate(
    request: ReportGenerationRequest,
    onProgress?: (event: ReportProgressEvent) => void
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
      rootDisplayInfoById,
      selectedLineRangesByFile,
    } = request;
    const generationOptions = {
      projectTreeUsesViewFilters: projectTreeUsesViewFilters ?? false,
      ...(rootDisplayInfoById ? { rootDisplayInfoById } : {}),
      ...(selectedLineRangesByFile ? { selectedLineRangesByFile } : {}),
    };

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
