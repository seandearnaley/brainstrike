import type { FileExplorerData, FolderState } from '@brainstrike/types';
import {
  createEmptySelectionModel,
  DEFAULT_FOLDER_SUMMARY_THRESHOLD,
  DEFAULT_MAX_SELECTION_COUNT,
  MAX_FOLDER_STATES,
} from '@brainstrike/types';
import { describe, expect, it } from 'vitest';
import {
  cleanupOldFolderStates,
  createNewFolderState,
  getFocusedSelectionCount,
  saveFolderState,
} from '../file-explorer-utils';

describe('file-explorer-utils', () => {
  describe('saveFolderState', () => {
    it('should save current folder state with timestamp', () => {
      // Arrange
      const mockState: FileExplorerData = {
        activeRootIds: [],
        currentFolderId: 'folder1',
        devInlineFixtureEnabled: false,
        disabledExcludeFilters: new Set<string>(),
        disabledIncludeFilters: new Set<string>(),
        excludeFilters: ['*.txt'],
        expandedDirectoryPaths: new Set(['dir1', 'dir2']),
        explorerScrollTop: 0,
        fileContents: {},
        folderAccessOrder: [],
        folderStates: {
          folder1: {
            excludeFilters: [],
            expandedDirectoryPaths: new Set(['oldDir']),
            folderSummaryThreshold: 10,
            includeFilters: [],
            includeProjectTree: false,
            lastAccessed: 1000,
            lastActiveTab: 'git',
            maxSelectionCount: 10,
            selectedFilePaths: new Set(['oldFile']),
            selectionModel: createEmptySelectionModel(),
            useRegex: false,
            viewFilterPresetId: null,
          },
        },
        folderSummaryThreshold: 100,
        includeFilters: ['*.ts'],
        includeProjectTree: true,
        isAccessLoading: false,
        isFilterChipsVisible: true,
        isFiltersExpanded: true,
        lastActiveTab: 'files',
        maxSelectionCount: 50,
        persistenceRecoveryNotice: null,
        querySelectionManifest: null,
        quickFilter: '',
        rootDescriptors: {},
        selectedFilePaths: new Set(['file1', 'file2']),
        selectionModel: createEmptySelectionModel(),
        selectionVersion: 0,
        useRegex: true,
        viewFilterPresetId: null,
      };
      const folderId = 'folder2';
      const mockTimestamp = 2000;

      // Act
      const result = saveFolderState(mockState, folderId, mockTimestamp);

      // Assert
      expect(result).toEqual({
        folder1: {
          excludeFilters: [],
          expandedDirectoryPaths: new Set(['oldDir']),
          folderSummaryThreshold: 10,
          includeFilters: [],
          includeProjectTree: false,
          lastAccessed: 1000,
          lastActiveTab: 'git',
          maxSelectionCount: 10,
          selectedFilePaths: new Set(['oldFile']),
          selectionModel: createEmptySelectionModel(),
          useRegex: false,
          viewFilterPresetId: null,
        },
        folder2: {
          excludeFilters: ['*.txt'],
          expandedDirectoryPaths: new Set(['dir1', 'dir2']),
          folderSummaryThreshold: 100,
          includeFilters: ['*.ts'],
          includeProjectTree: true,
          lastAccessed: 2000,
          lastActiveTab: 'files',
          maxSelectionCount: 50,
          selectedFilePaths: new Set(['file1', 'file2']),
          selectionModel: createEmptySelectionModel(),
          useRegex: true,
          viewFilterPresetId: null,
        },
      });
    });

    it('should overwrite existing folder state when saving with same ID', () => {
      // Arrange
      const folderId = 'folder1';
      const mockState: FileExplorerData = {
        activeRootIds: [],
        currentFolderId: 'folder1',
        devInlineFixtureEnabled: false,
        disabledExcludeFilters: new Set<string>(),
        disabledIncludeFilters: new Set<string>(),
        excludeFilters: ['*.md'],
        expandedDirectoryPaths: new Set(['newDir1']),
        explorerScrollTop: 0,
        fileContents: {},
        folderAccessOrder: [],
        folderStates: {
          folder1: {
            excludeFilters: [],
            expandedDirectoryPaths: new Set(['oldDir']),
            folderSummaryThreshold: 10,
            includeFilters: [],
            includeProjectTree: false,
            lastAccessed: 1000,
            lastActiveTab: 'git',
            maxSelectionCount: 10,
            selectedFilePaths: new Set(['oldFile']),
            selectionModel: createEmptySelectionModel(),
            useRegex: true,
            viewFilterPresetId: null,
          },
        },
        folderSummaryThreshold: 200,
        includeFilters: ['*.jsx'],
        includeProjectTree: true,
        isAccessLoading: false,
        isFilterChipsVisible: true,
        isFiltersExpanded: true,
        lastActiveTab: 'search',
        maxSelectionCount: 75,
        persistenceRecoveryNotice: null,
        querySelectionManifest: null,
        quickFilter: '',
        rootDescriptors: {},
        selectedFilePaths: new Set(['newFile1', 'newFile2']),
        selectionModel: createEmptySelectionModel(),
        selectionVersion: 0,
        useRegex: false,
        viewFilterPresetId: null,
      };
      const mockTimestamp = 3000;

      // Act
      const result = saveFolderState(mockState, folderId, mockTimestamp);

      // Assert
      expect(result).toEqual({
        folder1: {
          excludeFilters: ['*.md'],
          expandedDirectoryPaths: new Set(['newDir1']),
          folderSummaryThreshold: 200,
          includeFilters: ['*.jsx'],
          includeProjectTree: true,
          lastAccessed: 3000,
          lastActiveTab: 'search',
          maxSelectionCount: 75,
          selectedFilePaths: new Set(['newFile1', 'newFile2']),
          selectionModel: createEmptySelectionModel(),
          useRegex: false,
          viewFilterPresetId: null,
        },
      });
    });
    it('materializes descriptor overrides when saving a query-backed forest root', () => {
      const mockState: FileExplorerData = {
        activeRootIds: ['folder-a', 'folder-b'],
        currentFolderId: 'folder-a',
        devInlineFixtureEnabled: false,
        disabledExcludeFilters: new Set<string>(),
        disabledIncludeFilters: new Set<string>(),
        excludeFilters: [],
        expandedDirectoryPaths: new Set<string>(),
        explorerScrollTop: 0,
        fileContents: {},
        folderAccessOrder: [],
        folderStates: {
          'folder-b': createNewFolderState(1000),
        },
        folderSummaryThreshold: DEFAULT_FOLDER_SUMMARY_THRESHOLD,
        includeFilters: [],
        includeProjectTree: true,
        isAccessLoading: false,
        isFilterChipsVisible: true,
        isFiltersExpanded: true,
        lastActiveTab: 'files',
        maxSelectionCount: DEFAULT_MAX_SELECTION_COUNT,
        persistenceRecoveryNotice: null,
        querySelectionManifest: {
          directoryCounts: new Map<string, number>(),
          errorMessage: null,
          filePaths: ['a.ts'],
          fingerprint: 'fingerprint-a',
          pathSet: new Set(['a.ts']),
          snapshotId: 'snapshot-a',
          status: 'ready',
        },
        quickFilter: '',
        rootDescriptors: {},
        selectedFilePaths: new Set<string>(),
        selectionModel: {
          explicitPaths: new Set<string>(),
          materializedAt: null,
          materializedPaths: new Set(['a.ts']),
          mode: 'query',
          queryDescriptor: {
            coveredDirectoryPaths: [],
            excludedPaths: [],
            excludeFilters: [],
            folderId: 'folder-a',
            includedPaths: ['b.ts'],
            includeFilters: [],
            kind: 'recursive-select-all',
            manifestFingerprint: 'fingerprint-a',
            manifestSnapshotId: 'snapshot-a',
            rootPath: null,
            totalSelectedCount: 2,
            useRegex: false,
          },
        },
        selectionVersion: 0,
        useRegex: false,
        viewFilterPresetId: null,
      };

      expect(getFocusedSelectionCount(mockState)).toBe(2);

      const savedState = saveFolderState(mockState, 'folder-a', 2000);

      expect(savedState['folder-a']?.selectedFilePaths).toEqual(
        new Set(['folder-a|@|a.ts', 'folder-a|@|b.ts'])
      );

      for (const status of ['loading', 'error'] as const) {
        mockState.querySelectionManifest = {
          directoryCounts: new Map<string, number>(),
          errorMessage: status === 'error' ? 'snapshot unavailable' : null,
          filePaths: [],
          fingerprint: 'fingerprint-a',
          pathSet: new Set<string>(),
          snapshotId: 'snapshot-a',
          status,
        };

        expect(getFocusedSelectionCount(mockState)).toBe(2);
        expect(saveFolderState(mockState, 'folder-a', 2000)['folder-a']?.selectedFilePaths).toEqual(
          new Set(['folder-a|@|a.ts', 'folder-a|@|b.ts'])
        );
      }
    });
  });

  describe('cleanupOldFolderStates', () => {
    it('should return the original states when below max limit', () => {
      // Arrange
      const folderStates: Record<string, FolderState> = {
        folder1: {
          excludeFilters: [],
          expandedDirectoryPaths: new Set(),
          folderSummaryThreshold: 100,
          includeFilters: [],
          includeProjectTree: true,
          lastAccessed: 1000,
          lastActiveTab: 'files',
          maxSelectionCount: 50,
          selectedFilePaths: new Set(),
          selectionModel: createEmptySelectionModel(),
          useRegex: false,
          viewFilterPresetId: null,
        },
        folder2: {
          excludeFilters: [],
          expandedDirectoryPaths: new Set(),
          folderSummaryThreshold: 100,
          includeFilters: [],
          includeProjectTree: true,
          lastAccessed: 2000,
          lastActiveTab: 'files',
          maxSelectionCount: 50,
          selectedFilePaths: new Set(),
          selectionModel: createEmptySelectionModel(),
          useRegex: false,
          viewFilterPresetId: null,
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
          excludeFilters: [],
          expandedDirectoryPaths: new Set(),
          folderSummaryThreshold: 100,
          includeFilters: [],
          includeProjectTree: true,
          lastAccessed: i * 1000, // Increasing timestamps
          lastActiveTab: 'files',
          maxSelectionCount: 50,
          selectedFilePaths: new Set(),
          selectionModel: createEmptySelectionModel(),
          useRegex: false,
          viewFilterPresetId: null,
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
          excludeFilters: [],
          expandedDirectoryPaths: new Set(),
          folderSummaryThreshold: 100,
          includeFilters: [],
          includeProjectTree: true,
          lastAccessed: 1000,
          lastActiveTab: 'files',
          maxSelectionCount: 50,
          selectedFilePaths: new Set(),
          selectionModel: createEmptySelectionModel(),
          useRegex: false,
          viewFilterPresetId: null,
        },
        folder2: {
          excludeFilters: [],
          expandedDirectoryPaths: new Set(),
          folderSummaryThreshold: 100,
          includeFilters: [],
          includeProjectTree: true,
          lastAccessed: 2000,
          lastActiveTab: 'files',
          maxSelectionCount: 50,
          selectedFilePaths: new Set(),
          selectionModel: createEmptySelectionModel(),
          useRegex: false,
          viewFilterPresetId: null,
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
        excludeFilters: [],
        expandedDirectoryPaths: new Set<string>(),
        folderSummaryThreshold: DEFAULT_FOLDER_SUMMARY_THRESHOLD,
        includeFilters: [],
        includeProjectTree: true,
        lastAccessed: 5000,
        lastActiveTab: 'files',
        maxSelectionCount: DEFAULT_MAX_SELECTION_COUNT,
        selectedFilePaths: new Set<string>(),
        selectionModel: createEmptySelectionModel(),
        useRegex: false,
        viewFilterPresetId: null,
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
