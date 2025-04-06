/**
 * File Loading Manager Hook
 *
 * This hook manages the loading state of files in the file explorer.
 * It handles loading file content and tracking loading states.
 */

import type { FileContents } from '@brainstrike/types';
import { useCallback, useEffect, useState } from 'react';

interface UseFileLoadingManagerProps {
  selectedFilePaths: Set<string>;
  fileContents: FileContents;
  loadFileContent: (path: string) => Promise<void>;
}

export const useFileLoadingManager = ({
  selectedFilePaths,
  fileContents,
  loadFileContent,
}: UseFileLoadingManagerProps) => {
  const [loadingFiles, setLoadingFiles] = useState<Set<string>>(new Set());

  const handleFileLoading = useCallback(
    async (path: string) => {
      setLoadingFiles((prev) => {
        const newSet = new Set(prev);
        newSet.add(path);
        return newSet;
      });

      try {
        await loadFileContent(path);
      } finally {
        setLoadingFiles((prev) => {
          const newSet = new Set(prev);
          newSet.delete(path);
          return newSet;
        });
      }
    },
    [loadFileContent]
  );

  useEffect(() => {
    // Load content for all selected files
    for (const path of selectedFilePaths) {
      if (!fileContents[path]) {
        handleFileLoading(path);
      }
    }
  }, [selectedFilePaths, fileContents, handleFileLoading]);

  return {
    loadingFiles,
  };
};
