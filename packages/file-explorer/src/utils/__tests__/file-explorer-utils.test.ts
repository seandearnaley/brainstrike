import type { FileExplorerData, FolderState } from '@brainstrike/types';
import {
  DEFAULT_FOLDER_SUMMARY_THRESHOLD,
  DEFAULT_MAX_SELECTION_COUNT,
  DEFAULT_TOKEN_BUDGET,
  MAX_FOLDER_STATES,
} from '@brainstrike/types';
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
        folderAccessOrder: [],
        fileContents: {},
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
        folderAccessOrder: [],
        fileContents: {},
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
      const order = ['folder1', 'folder2'];

      // Act
      const result = cleanupOldFolderStates(folderStates, order);

      // Assert
      expect(result.folderStates).toStrictEqual(folderStates);
      expect(result.order).toEqual(order);
    });

    it('should remove oldest folders when above max limit', () => {
      // Arrange
      const folderStates: Record<string, FolderState> = {};
      const order: string[] = [];

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
        order.push(`folder${i}`);
      }

      // Act
      const result = cleanupOldFolderStates(folderStates, order);

      // Assert
      expect(Object.keys(result.folderStates).length).toBe(MAX_FOLDER_STATES);
      // NOTE: Bracket notation with string literal is required for index signature access in TypeScript
      const folder0Key = 'folder0';
      const folder1Key = 'folder1';
      const folder2Key = 'folder2';
      expect(result.folderStates[folder0Key]).toBeUndefined();
      expect(result.folderStates[folder1Key]).toBeUndefined();
      expect(result.folderStates[folder2Key]).toBeDefined();

      for (let i = 2; i < MAX_FOLDER_STATES + 2; i++) {
        expect(result.folderStates[`folder${i}`]).toBeDefined();
      }

      expect(result.order.length).toBe(MAX_FOLDER_STATES);
      expect(result.order[0]).toBe('folder2');
    });

    it('should remove ids from the order that have no matching folder state', () => {
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
      const order = ['folder1', 'orphan', 'folder2'];

      // Act
      const result = cleanupOldFolderStates(folderStates, order);

      // Assert
      expect(result.folderStates).toStrictEqual(folderStates);
      expect(result.order).toEqual(['folder1', 'folder2']);
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
        tokenBudget: DEFAULT_TOKEN_BUDGET,
        folderSummaryThreshold: DEFAULT_FOLDER_SUMMARY_THRESHOLD,
        maxSelectionCount: DEFAULT_MAX_SELECTION_COUNT,
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
