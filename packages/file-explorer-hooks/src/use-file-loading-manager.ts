/**
 * File Loading Manager Hook
 *
 * This hook manages the loading state of files in the file explorer.
 * It handles loading file content and tracking loading states.
 */

import type { FileContents } from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils/logger';
import { useCallback, useEffect, useState } from 'react';

interface UseFileLoadingManagerProps {
  fileContents: FileContents;
  loadFileContent: (path: string) => Promise<void>;
  selectedFilePaths: Set<string>;
}

export const useFileLoadingManager = ({
  selectedFilePaths,
  fileContents,
  loadFileContent,
}: UseFileLoadingManagerProps) => {
  const logger = createLogger('FileLoadingManager');
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
      } catch (error) {
        logger.warn('Failed to load file content', { error, path });
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

  // biome-ignore lint/plugin: Reactive file loading - triggers load for newly selected files
  useEffect(() => {
    // Load content for all selected files
    for (const path of selectedFilePaths) {
      if (!fileContents[path]) {
        void handleFileLoading(path);
      }
    }
  }, [selectedFilePaths, fileContents, handleFileLoading]);

  return {
    loadingFiles,
  };
};
