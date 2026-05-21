import type { DirectoryHandle, FileSystemAdapter } from '@brainstrike/file-system';
import type { ContextLineRange } from '@brainstrike/utils/report-generator';
import { useCallback, useRef, useState } from 'react';

export type { ContextLineRange } from '@brainstrike/utils/report-generator';

export interface ReportGenerationRequest {
  excludeFilters: string[];
  fileContents: Record<string, string>;
  folderSummaryThreshold: number;
  includeFilters: string[];
  includeProjectTree: boolean;
  projectTreeUsesViewFilters?: boolean;
  rootDirectoryHandle: FileSystemDirectoryHandle | DirectoryHandle;
  selectedFiles: Set<string>;
  selectedLineRangesByFile?: Record<string, ContextLineRange[]>;
  useRegex: boolean;
  useTapestryRanges?: boolean;
}

export interface ReportProgressEvent {
  loaded: number;
  total: number;
}

export interface ReportGenerationWorkerOptions {
  fileSystemAdapter?: FileSystemAdapter;
}

export type ReportGenerator = (
  request: ReportGenerationRequest,
  onProgress?: (event: ReportProgressEvent) => void
) => Promise<string>;

export type CreateReportGenerator = (options?: ReportGenerationWorkerOptions) => ReportGenerator;

export interface ContextGenerationOverrides {
  projectTreeUsesViewFilters?: boolean;
  selectedLineRangesByFile?: Record<string, ContextLineRange[]>;
  useTapestryRanges?: boolean;
}

interface UseReportGenerationProps {
  createReportGenerator: CreateReportGenerator;
  excludeFilters: string[];
  fileContents: { [path: string]: string };
  fileSystemAdapter?: FileSystemAdapter;
  folderSummaryThreshold: number;
  /**
   * Optional callback to get current file contents from state.
   * Used after loadMissingContent to get the fresh state with loaded content.
   * If not provided, the static fileContents prop is used.
   */
  getFileContents?: () => { [path: string]: string };
  includeFilters: string[];
  includeProjectTree: boolean;
  /**
   * Optional callback to load missing file contents before report generation.
   * When provided, the hook will load content for selected files that aren't
   * already in fileContents before generating the report.
   */
  loadMissingContent?: (compositeKeys: string[]) => Promise<void>;
  projectTreeUsesViewFilters?: boolean;
  rootDirectoryHandle: FileSystemDirectoryHandle | DirectoryHandle | undefined;
  selectedFiles: Set<string>;
  useRegex: boolean;
}

export function useReportGeneration({
  selectedFiles,
  fileContents,
  rootDirectoryHandle,
  fileSystemAdapter,
  createReportGenerator,
  includeFilters,
  excludeFilters,
  useRegex,
  includeProjectTree,
  projectTreeUsesViewFilters = false,
  folderSummaryThreshold,
  loadMissingContent,
  getFileContents,
}: UseReportGenerationProps) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState<ReportProgressEvent | null>(null);

  const payload = {
    selectedFiles,
    fileContents,
    rootDirectoryHandle,
    fileSystemAdapter,
    includeFilters,
    excludeFilters,
    useRegex,
    includeProjectTree,
    projectTreeUsesViewFilters,
    folderSummaryThreshold,
    loadMissingContent,
    getFileContents,
    createReportGenerator,
  };
  const payloadRef = useRef(payload);
  payloadRef.current = payload;

  // Keep callback identity stable; runtime inputs are read from payloadRef at call time.
  const generateContextWithContent = useCallback(async (overrides?: ContextGenerationOverrides) => {
    if (!payloadRef.current.rootDirectoryHandle) {
      throw new Error('No root directory selected');
    }

    setIsGenerating(true);
    setProgress({ loaded: 0, total: 1 });
    try {
      const {
        fileSystemAdapter: adapter,
        rootDirectoryHandle: stableRoot,
        selectedFiles: s,
        fileContents: fc,
        includeFilters: inc,
        excludeFilters: exc,
        useRegex: rx,
        includeProjectTree: proj,
        projectTreeUsesViewFilters: treeUsesViewFilters,
        folderSummaryThreshold: thr,
        loadMissingContent: loadContent,
        getFileContents: getContents,
        createReportGenerator: createGenerator,
      } = payloadRef.current;

      // Load missing file contents if the loader is provided
      let finalFileContents = fc;
      if (loadContent) {
        // Find selected files that don't have content loaded yet
        const missingKeys = Array.from(s).filter((key) => !(key in fc));
        if (missingKeys.length > 0) {
          await loadContent(missingKeys);
          // Get the updated file contents from state after loading
          finalFileContents = getContents ? getContents() : fc;
        }
      }

      const worker = createGenerator(adapter ? { fileSystemAdapter: adapter } : {});
      return await worker(
        {
          selectedFiles: s,
          fileContents: finalFileContents,
          rootDirectoryHandle: stableRoot as FileSystemDirectoryHandle | DirectoryHandle,
          includeFilters: inc,
          excludeFilters: exc,
          useRegex: rx,
          includeProjectTree: proj,
          // When override is undefined, use the latest persisted toggle from payloadRef.
          projectTreeUsesViewFilters: overrides?.projectTreeUsesViewFilters ?? treeUsesViewFilters,
          folderSummaryThreshold: thr,
          ...(overrides?.selectedLineRangesByFile
            ? { selectedLineRangesByFile: overrides.selectedLineRangesByFile }
            : {}),
          useTapestryRanges: overrides?.useTapestryRanges ?? false,
        },
        (e: ReportProgressEvent) => setProgress(e)
      );
    } finally {
      setIsGenerating(false);
      setProgress(null);
    }
  }, []);

  return {
    generateContextWithContent,
    isGenerating,
    progress,
  };
}
