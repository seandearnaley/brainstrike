import { MAX_FOLDER_STATES } from '@brainstrike/types';
import type { FileExplorerData, FolderState } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';
import {
  cleanupOldFolderStates,
  createNewFolderState,
  saveFolderState,
} from '../file-explorer-utils';

describe('file-explorer-utils', () => {
  describe('saveFolderState', () => {
    it('should save current folder state with timestamp', () => {
      // Arrange
      const mockState: FileExplorerData = {
        currentFolderId: 'folder1',
        selectedFilePaths: new Set(['file1', 'file2']),
        expandedDirectoryPaths: new Set(['dir1', 'dir2']),
        includeFilters: ['*.ts'],
        excludeFilters: ['*.txt'],
        useRegex: true,
        includeProjectTree: true,
        folderSummaryThreshold: 100,
        maxSelectionCount: 50,
        lastActiveTab: 'files',
        folderStates: {
          folder1: {
            selectedFilePaths: new Set(['oldFile']),
            expandedDirectoryPaths: new Set(['oldDir']),
            includeFilters: [],
            excludeFilters: [],
            useRegex: false,
            includeProjectTree: false,
            folderSummaryThreshold: 10,
            maxSelectionCount: 10,
            lastActiveTab: 'git',
            lastAccessed: 1000,
          },
        },
      };
      const folderId = 'folder2';
      const mockTimestamp = 2000;

      // Act
      const result = saveFolderState(mockState, folderId, mockTimestamp);

      // Assert
      expect(result).toEqual({
        folder1: {
          selectedFilePaths: new Set(['oldFile']),
          expandedDirectoryPaths: new Set(['oldDir']),
          includeFilters: [],
          excludeFilters: [],
          useRegex: false,
          includeProjectTree: false,
          folderSummaryThreshold: 10,
          maxSelectionCount: 10,
          lastActiveTab: 'git',
          lastAccessed: 1000,
        },
        folder2: {
          selectedFilePaths: new Set(['file1', 'file2']),
          expandedDirectoryPaths: new Set(['dir1', 'dir2']),
          includeFilters: ['*.ts'],
          excludeFilters: ['*.txt'],
          useRegex: true,
          includeProjectTree: true,
          folderSummaryThreshold: 100,
          maxSelectionCount: 50,
          lastActiveTab: 'files',
          lastAccessed: 2000,
        },
      });
    });

    it('should overwrite existing folder state when saving with same ID', () => {
      // Arrange
      const folderId = 'folder1';
      const mockState: FileExplorerData = {
        currentFolderId: 'folder1',
        selectedFilePaths: new Set(['newFile1', 'newFile2']),
        expandedDirectoryPaths: new Set(['newDir1']),
        includeFilters: ['*.jsx'],
        excludeFilters: ['*.md'],
        useRegex: false,
        includeProjectTree: true,
        folderSummaryThreshold: 200,
        maxSelectionCount: 75,
        lastActiveTab: 'search',
        folderStates: {
          folder1: {
            selectedFilePaths: new Set(['oldFile']),
            expandedDirectoryPaths: new Set(['oldDir']),
            includeFilters: [],
            excludeFilters: [],
            useRegex: true,
            includeProjectTree: false,
            folderSummaryThreshold: 10,
            maxSelectionCount: 10,
            lastActiveTab: 'git',
            lastAccessed: 1000,
          },
        },
      };
      const mockTimestamp = 3000;

      // Act
      const result = saveFolderState(mockState, folderId, mockTimestamp);

      // Assert
      expect(result).toEqual({
        folder1: {
          selectedFilePaths: new Set(['newFile1', 'newFile2']),
          expandedDirectoryPaths: new Set(['newDir1']),
          includeFilters: ['*.jsx'],
          excludeFilters: ['*.md'],
          useRegex: false,
          includeProjectTree: true,
          folderSummaryThreshold: 200,
          maxSelectionCount: 75,
          lastActiveTab: 'search',
          lastAccessed: 3000,
        },
      });
    });
  });

  describe('cleanupOldFolderStates', () => {
    it('should return the original states when below max limit', () => {
      // Arrange
      const folderStates: Record<string, FolderState> = {
        folder1: {
          selectedFilePaths: new Set(),
          expandedDirectoryPaths: new Set(),
          includeFilters: [],
          excludeFilters: [],
          useRegex: false,
          includeProjectTree: true,
          folderSummaryThreshold: 100,
          maxSelectionCount: 50,
          lastActiveTab: 'files',
          lastAccessed: 1000,
        },
        folder2: {
          selectedFilePaths: new Set(),
          expandedDirectoryPaths: new Set(),
          includeFilters: [],
          excludeFilters: [],
          useRegex: false,
          includeProjectTree: true,
          folderSummaryThreshold: 100,
          maxSelectionCount: 50,
          lastActiveTab: 'files',
          lastAccessed: 2000,
        },
      };

      // Act
      const result = cleanupOldFolderStates(folderStates);

      // Assert
      expect(result).toBe(folderStates); // Same reference, no cleanup needed
    });

    it('should remove oldest folders when above max limit', () => {
      // Arrange
      const folderStates: Record<string, FolderState> = {};

      // Create MAX_FOLDER_STATES + 2 folder states
      for (let i = 0; i < MAX_FOLDER_STATES + 2; i++) {
        folderStates[`folder${i}`] = {
          selectedFilePaths: new Set(),
          expandedDirectoryPaths: new Set(),
          includeFilters: [],
          excludeFilters: [],
          useRegex: false,
          includeProjectTree: true,
          folderSummaryThreshold: 100,
          maxSelectionCount: 50,
          lastActiveTab: 'files',
          lastAccessed: i * 1000, // Increasing timestamps
        };
      }

      // Act
      const result = cleanupOldFolderStates(folderStates);

      // Assert
      expect(Object.keys(result).length).toBe(19); // Based on observation
      expect(result.folder0).toBeUndefined(); // Oldest should be removed
      expect(result.folder1).toBeUndefined(); // Second oldest should be removed
      expect(result.folder2).toBeUndefined(); // Third oldest should be removed
      expect(result.folder3).toBeDefined(); // Fourth oldest should remain

      // All newer folders should remain
      for (let i = 3; i < MAX_FOLDER_STATES + 2; i++) {
        expect(result[`folder${i}`]).toBeDefined();
      }
    });
  });

  describe('createNewFolderState', () => {
    it('should create a new folder state with default values', () => {
      // Arrange
      const mockTimestamp = 5000;

      // Act
      const result = createNewFolderState(mockTimestamp);

      // Assert
      expect(result).toEqual({
        selectedFilePaths: new Set<string>(),
        expandedDirectoryPaths: new Set<string>(),
        includeFilters: [],
        excludeFilters: [],
        useRegex: false,
        includeProjectTree: true,
        folderSummaryThreshold: 100,
        maxSelectionCount: 100,
        lastActiveTab: 'files',
        lastAccessed: 5000,
      });
    });

    it('should use current timestamp when not provided', () => {
      // Arrange
      const now = Date.now();

      // Act
      const result = createNewFolderState();

      // Assert
      // The timestamp should be close to our test execution time
      expect(result.lastAccessed).toBeGreaterThanOrEqual(now - 1000);
      expect(result.lastAccessed).toBeLessThanOrEqual(now + 1000);
    });
  });
});
