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
      } = payloadRef.current;
      const worker = createReportGenerationWorker(adapter ? { fileSystemAdapter: adapter } : {});
      return await worker(
        {
          selectedFiles: s,
          fileContents: fc,
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
