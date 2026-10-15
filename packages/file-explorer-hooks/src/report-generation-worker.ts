import { generateContext } from '@brainstrike/file-explorer/context-generation';
import type {
  ReportGenerationRequest,
  ReportGenerationWorkerOptions,
  ReportProgressEvent,
} from './use-report-generation.js';

export type ProgressEvent = ReportProgressEvent;

export function createReportGenerationWorker(options: ReportGenerationWorkerOptions) {
  if (!options?.fileSystemAdapter) {
    throw new Error('File system adapter is required for report generation');
  }
  const { fileSystemAdapter } = options;

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
    } = request;
    const generationOptions = {
      projectTreeUsesViewFilters: projectTreeUsesViewFilters ?? false,
      ...(rootDisplayInfoById ? { rootDisplayInfoById } : {}),
    };

    const context = await generateContext(
      selectedFiles,
      fileContents,
      fileSystemAdapter,
      rootDirectoryHandle,
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
