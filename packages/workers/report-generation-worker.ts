import type { DirectoryHandle, FileSystemAdapter } from '@brainstrike/file-system';
import { generateReport, generateReportFromAdapter } from '@brainstrike/utils';

export interface ReportGenerationRequest {
  selectedFiles: Set<string>;
  fileContents: Record<string, string>;
  rootDirectoryHandle: FileSystemDirectoryHandle | DirectoryHandle;
  includeFilters: string[];
  excludeFilters: string[];
  useRegex: boolean;
  includeProjectTree: boolean;
  folderSummaryThreshold: number;
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
      folderSummaryThreshold,
    } = request;

    const report =
      fileSystemAdapter && 'platform' in rootDirectoryHandle
        ? await generateReportFromAdapter(
            selectedFiles,
            fileContents,
            fileSystemAdapter,
            rootDirectoryHandle as DirectoryHandle,
            includeFilters,
            excludeFilters,
            useRegex,
            includeProjectTree,
            folderSummaryThreshold
          )
        : await generateReport(
            selectedFiles,
            fileContents,
            rootDirectoryHandle as FileSystemDirectoryHandle,
            includeFilters,
            excludeFilters,
            useRegex,
            includeProjectTree,
            folderSummaryThreshold
          );

    onProgress?.({ loaded: 1, total: 1 });
    return report;
  };
}
