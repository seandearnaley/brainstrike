import { generateReport } from '@brainstrike/utils';
import { useCallback, useState } from 'react';

interface UseReportGenerationProps {
  selectedFiles: Set<string>;
  fileContents: { [path: string]: string };
  rootDirectoryHandle: FileSystemDirectoryHandle | undefined;
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
      return await generateReport(
        selectedFiles,
        fileContents,
        rootDirectoryHandle,
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
