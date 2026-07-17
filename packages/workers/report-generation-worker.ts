import type { DirectoryHandle, FileSystemAdapter } from '@brainstrike/file-system';
import {
  type ContextLineRange,
  generateContext,
  generateContextFromAdapter,
  type RootDisplayInfo,
} from '@brainstrike/utils';

export interface ReportGenerationRequest {
  excludeFilters: string[];
  fileContents: Record<string, string>;
  folderSummaryThreshold: number;
  includeFilters: string[];
  includeProjectTree: boolean;
  projectTreeUsesViewFilters?: boolean;
  rootDirectoryHandle: FileSystemDirectoryHandle | DirectoryHandle;
  /**
   * RootId UUID → display metadata (storage v5) so `<file path>` attributes
   * render human-readable paths instead of composite selection keys.
   * Plain data — the request must stay structured-cloneable.
   */
  rootDisplayInfoById?: Record<string, RootDisplayInfo>;
  selectedFiles: Set<string>;
  selectedLineRangesByFile?: Record<string, ContextLineRange[]>;
  useRegex: boolean;
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
