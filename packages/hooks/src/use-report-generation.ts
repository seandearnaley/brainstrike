import type { DirectoryHandle, FileSystemAdapter } from '@brainstrike/file-system';
import {
  createReportGenerationWorker,
  type ProgressEvent as ReportProgressEvent,
} from '@brainstrike/workers/report-generation-worker';
import { useCallback, useState } from 'react';

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

  const generateReportWithContent = useCallback(async () => {
    if (!rootDirectoryHandle) {
      throw new Error('No root directory selected');
    }

    setIsGenerating(true);
    setProgress({ loaded: 0, total: 1 });
    try {
      const worker = createReportGenerationWorker(fileSystemAdapter ? { fileSystemAdapter } : {});
      return await worker(
        {
          selectedFiles,
          fileContents,
          rootDirectoryHandle,
          includeFilters,
          excludeFilters,
          useRegex,
          includeProjectTree,
          folderSummaryThreshold,
        },
        (e: ReportProgressEvent) => setProgress(e)
      );
    } finally {
      setIsGenerating(false);
    }
  }, [
    selectedFiles,
    fileContents,
    rootDirectoryHandle,
    fileSystemAdapter,
    includeFilters,
    excludeFilters,
    useRegex,
    includeProjectTree,
    folderSummaryThreshold,
  ]);

  return {
    generateReportWithContent,
    isGenerating,
    progress,
  };
}
