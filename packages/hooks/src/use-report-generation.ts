import { generateReport, generateReportFromAdapter } from '@brainstrike/utils';
import type { DirectoryHandle, FileSystemAdapter } from '@brainstrike/file-system';
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

  const generateReportWithContent = useCallback(async () => {
    if (!rootDirectoryHandle) {
      throw new Error('No root directory selected');
    }

    setIsGenerating(true);
    try {
      // Check if we have our adapter pattern (DirectoryHandle with platform property)
      if (fileSystemAdapter && 'platform' in rootDirectoryHandle) {
        // Use platform-agnostic version
        return await generateReportFromAdapter(
          selectedFiles,
          fileContents,
          fileSystemAdapter,
          rootDirectoryHandle as DirectoryHandle,
          includeFilters,
          excludeFilters,
          useRegex,
          includeProjectTree,
          folderSummaryThreshold
        );
      }

      // Use original web-only version for backward compatibility
      return await generateReport(
        selectedFiles,
        fileContents,
        rootDirectoryHandle as FileSystemDirectoryHandle,
        includeFilters,
        excludeFilters,
        useRegex,
        includeProjectTree,
        folderSummaryThreshold
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
  };
}
