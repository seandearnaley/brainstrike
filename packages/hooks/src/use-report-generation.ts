import type { DirectoryHandle, FileSystemAdapter } from '@brainstrike/file-system';
import {
  createReportGenerationWorker,
  type ProgressEvent as ReportProgressEvent,
} from '@brainstrike/workers/report-generation-worker';
import { useCallback, useMemo, useRef, useState } from 'react';

interface UseReportGenerationProps {
  selectedFiles: Set<string>;
  fileContents: { [path: string]: string };
  rootDirectoryHandle: FileSystemDirectoryHandle | DirectoryHandle | undefined;
  fileSystemAdapter?: FileSystemAdapter;
  includeFilters: string[];
  excludeFilters: string[];
  useRegex: boolean;
  includeProjectTree: boolean;
  folderSummaryThreshold: number;
  /**
   * Optional callback to load missing file contents before report generation.
   * When provided, the hook will load content for selected files that aren't
   * already in fileContents before generating the report.
   */
  loadMissingContent?: (compositeKeys: string[]) => Promise<void>;
  /**
   * Optional callback to get current file contents from state.
   * Used after loadMissingContent to get the fresh state with loaded content.
   * If not provided, the static fileContents prop is used.
   */
  getFileContents?: () => { [path: string]: string };
}

export function useReportGeneration({
  selectedFiles,
  fileContents,
  rootDirectoryHandle,
  fileSystemAdapter,
  includeFilters,
  excludeFilters,
  useRegex,
  includeProjectTree,
  folderSummaryThreshold,
  loadMissingContent,
  getFileContents,
}: UseReportGenerationProps) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState<ReportProgressEvent | null>(null);

  const stablePayload = useMemo(
    () => ({
      selectedFiles,
      fileContents,
      rootDirectoryHandle,
      includeFilters,
      excludeFilters,
      useRegex,
      includeProjectTree,
      folderSummaryThreshold,
      fileSystemAdapter,
      loadMissingContent,
      getFileContents,
    }),
    [
      selectedFiles,
      fileContents,
      rootDirectoryHandle,
      includeFilters,
      excludeFilters,
      useRegex,
      includeProjectTree,
      folderSummaryThreshold,
      fileSystemAdapter,
      loadMissingContent,
      getFileContents,
    ]
  );

  const payloadRef = useRef(stablePayload);
  // Keep the current payload synchronized without introducing conditional hooks.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  payloadRef.current = stablePayload;

  const generateReportWithContent = useCallback(async () => {
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
        folderSummaryThreshold: thr,
        loadMissingContent: loadContent,
        getFileContents: getContents,
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

      const worker = createReportGenerationWorker(adapter ? { fileSystemAdapter: adapter } : {});
      return await worker(
        {
          selectedFiles: s,
          fileContents: finalFileContents,
          rootDirectoryHandle: stableRoot as FileSystemDirectoryHandle | DirectoryHandle,
          includeFilters: inc,
          excludeFilters: exc,
          useRegex: rx,
          includeProjectTree: proj,
          folderSummaryThreshold: thr,
        },
        (e: ReportProgressEvent) => setProgress(e)
      );
    } finally {
      setIsGenerating(false);
    }
  }, []);

  return {
    generateReportWithContent,
    isGenerating,
    progress,
  };
}
