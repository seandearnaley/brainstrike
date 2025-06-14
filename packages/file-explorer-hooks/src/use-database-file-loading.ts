/**
 * Database-First File Loading Hook
 *
 * This hook manages file content loading with database-first approach.
 * It coordinates with the file explorer store to track database population
 * and loads files from the database when available.
 */

import type { FolderService } from '@brainstrike/file-cache';
import { useFileExplorerStore } from '@brainstrike/file-explorer';
import type { DatabaseAwareFileSystemAdapter } from '@brainstrike/file-system';
import { useCallback, useEffect, useRef } from 'react';
import { useAdapters } from './adapters-context';

export interface UseDatabaseFileLoadingOptions {
  folderService?: FolderService;
  onPopulationProgress?: (loaded: number, total: number) => void;
}

export interface UseDatabaseFileLoadingReturn {
  /**
   * Request directory access and optionally populate database
   */
  requestDirectoryWithDatabase: () => Promise<void>;

  /**
   * Check if current folder is populated in database
   */
  isFolderPopulated: boolean;

  /**
   * Current database mode setting
   */
  isDatabaseMode: boolean;

  /**
   * Population progress (if currently populating)
   */
  populationProgress?:
    | {
        loaded: number;
        total: number;
        isLoading: boolean;
      }
    | undefined;

  /**
   * Set database mode on/off
   */
  setDatabaseMode: (enabled: boolean) => void;
}

export function useDatabaseFileLoading(
  options?: UseDatabaseFileLoadingOptions
): UseDatabaseFileLoadingReturn {
  const { fileSystemAdapter } = useAdapters();
  const adapterRef = useRef<DatabaseAwareFileSystemAdapter | null>(null);

  // Get store actions and state
  const {
    currentFolderId,
    databaseMode,
    currentFolderPopulated,
    folderStates,
    setDatabaseMode,
    setCurrentFolderPopulated,
    setFolderPopulated,
    setPopulationProgress,
    clearPopulationProgress,
  } = useFileExplorerStore();

  // Get population progress for current folder
  const populationProgress = currentFolderId
    ? folderStates[currentFolderId]?.populationProgress
    : undefined;

  // Check if adapter is database-aware
  useEffect(() => {
    if (fileSystemAdapter && 'setFolderService' in fileSystemAdapter) {
      adapterRef.current = fileSystemAdapter as DatabaseAwareFileSystemAdapter;

      // Set folder service if provided
      if (options?.folderService) {
        adapterRef.current.setFolderService(options.folderService);
      }

      // Sync database mode with store
      adapterRef.current.setDatabaseMode(databaseMode);
    }
  }, [fileSystemAdapter, options?.folderService, databaseMode]);

  // Request directory with database population
  const requestDirectoryWithDatabase = useCallback(async () => {
    if (!adapterRef.current) {
      throw new Error('File system adapter is not database-aware');
    }

    try {
      // Request directory access with database population
      const handle = await adapterRef.current.requestDirectoryAccess({
        populateDatabase: databaseMode,
        onProgress: (loaded, total) => {
          // Update store progress
          if (currentFolderId) {
            setPopulationProgress(currentFolderId, { loaded, total, isLoading: true });
          }

          // Call user callback if provided
          options?.onPopulationProgress?.(loaded, total);
        },
      });

      // Mark folder as populated when done
      const folderId = (handle as { folderId?: string }).folderId;
      if (folderId) {
        setFolderPopulated(folderId, true);
        clearPopulationProgress(folderId);

        // Update current folder populated status
        if (folderId === currentFolderId) {
          setCurrentFolderPopulated(true);
        }
      }

      // Return void since the interface expects it
      return;
    } catch (error) {
      // Clear progress on error
      if (currentFolderId) {
        clearPopulationProgress(currentFolderId);
      }
      throw error;
    }
  }, [
    databaseMode,
    currentFolderId,
    setPopulationProgress,
    setFolderPopulated,
    setCurrentFolderPopulated,
    clearPopulationProgress,
    options,
  ]);

  // Update database mode in both store and adapter
  const updateDatabaseMode = useCallback(
    (enabled: boolean) => {
      setDatabaseMode(enabled);
      if (adapterRef.current) {
        adapterRef.current.setDatabaseMode(enabled);
      }
    },
    [setDatabaseMode]
  );

  return {
    requestDirectoryWithDatabase,
    isFolderPopulated: currentFolderPopulated,
    isDatabaseMode: databaseMode,
    populationProgress,
    setDatabaseMode: updateDatabaseMode,
  };
}
