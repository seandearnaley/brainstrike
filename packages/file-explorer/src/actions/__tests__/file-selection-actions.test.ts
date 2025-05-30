import type { FileExplorerState } from '@brainstrike/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileSelectionActions } from '../file-selection-actions';

// Mock the file-selection-utils module
vi.mock('@brainstrike/utils', () => ({
  encodeFileSelection: (folderId: string, path: string) => `${folderId}|@|${path}`,
}));

describe('file-selection-actions', () => {
  // Setup common mocks
  const mockSet = vi.fn();
  const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

  beforeEach(() => {
    mockSet.mockClear();
    consoleSpy.mockClear();
  });

  // Helper to create a full mock state
  const createMockState = (overrides: Partial<FileExplorerState> = {}): FileExplorerState => ({
    currentFolderId: 'folder1',
    folderStates: {},
    selectedFilePaths: new Set<string>(),
    expandedDirectoryPaths: new Set<string>(),
    includeFilters: [],
    excludeFilters: [],
    useRegex: false,
    includeProjectTree: true,
    folderSummaryThreshold: 100,
    maxSelectionCount: 100,
    lastActiveTab: 'files',
    folderAccessOrder: [],
    setCurrentFolderId: vi.fn(),
    hydrateFolderState: vi.fn(),
    setSelectedFiles: vi.fn(),
    addSelectedFile: vi.fn(),
    removeSelectedFile: vi.fn(),
    toggleSelectedFile: vi.fn(),
    clearSelectedFiles: vi.fn(),
    setExpandedPaths: vi.fn(),
    toggleDirectoryExpansion: vi.fn(),
    setFilters: vi.fn(),
    setUseRegex: vi.fn(),
    setIncludeProjectTree: vi.fn(),
    setFolderSummaryThreshold: vi.fn(),
    setMaxSelectionCount: vi.fn(),
    setLastActiveTab: vi.fn(),
    expandAllDirectories: vi.fn(),
    collapseAllDirectories: vi.fn(),
    ...overrides,
  });

  describe('setSelectedFiles', () => {
    it('should set selected files with a new Set instance', () => {
      // Arrange
      const initialSet = ['folder1|@|file1.ts', 'folder1|@|file2.ts'];
      const selectedFiles = new Set(initialSet);
      const fileSelectionActions = createFileSelectionActions(mockSet, vi.fn());

      // Act
      fileSelectionActions.setSelectedFiles(selectedFiles);

      // Assert
      expect(mockSet).toHaveBeenCalledTimes(1);
      // @ts-expect-error - TS struggles with mock call type narrowing
      const arg = mockSet.mock.calls[0][0];

      let updatedState: Partial<FileExplorerState> | undefined;
      if (typeof arg === 'function') {
        // If set was called with a function: set(state => newState)
        // Provide a minimal mock state if needed for the update function
        updatedState = arg(createMockState({ selectedFilePaths: new Set() }));
      } else {
        // If set was called with an object: set(newState)
        updatedState = arg as Partial<FileExplorerState>; // Type assertion
      }

      expect(updatedState).toBeDefined();
      // Use non-null assertion after check
      expect(updatedState?.selectedFilePaths).toEqual(new Set(initialSet));
      expect(updatedState?.selectedFilePaths).not.toBe(initialSet);
    });

    it('should filter out invalid composite keys', () => {
      // Arrange
      const selectedFiles = new Set(['folder1|@|file1.ts', 'invalid-key']);
      const fileSelectionActions = createFileSelectionActions(mockSet, vi.fn());

      // Act
      fileSelectionActions.setSelectedFiles(selectedFiles);

      // Assert
      expect(mockSet).toHaveBeenCalledTimes(1);
      // @ts-expect-error - TS struggles with mock call type narrowing
      const arg = mockSet.mock.calls[0][0];

      let updatedState: Partial<FileExplorerState> | undefined;
      if (typeof arg === 'function') {
        updatedState = arg(createMockState({ selectedFilePaths: new Set<string>() }));
      } else {
        updatedState = arg as Partial<FileExplorerState>;
      }

      expect(updatedState).toBeDefined();
      expect(updatedState?.selectedFilePaths).toEqual(new Set(['folder1|@|file1.ts']));
      expect(updatedState?.selectedFilePaths?.has('invalid-key')).toBe(false);
    });

    it('should handle empty sets', () => {
      // Arrange
      const selectedFiles = new Set<string>();
      const fileSelectionActions = createFileSelectionActions(mockSet, vi.fn());

      // Act
      fileSelectionActions.setSelectedFiles(selectedFiles);

      // Assert
      expect(mockSet).toHaveBeenCalledTimes(1);
      // @ts-expect-error - TS struggles with mock call type narrowing
      const arg = mockSet.mock.calls[0][0];

      let updatedState: Partial<FileExplorerState> | undefined;
      if (typeof arg === 'function') {
        updatedState = arg(createMockState({ selectedFilePaths: new Set() }));
      } else {
        updatedState = arg as Partial<FileExplorerState>;
      }

      expect(updatedState).toBeDefined();
      expect(updatedState?.selectedFilePaths).toEqual(new Set<string>());
    });
  });

  describe('addSelectedFile', () => {
    it('should add file to selected files', () => {
      // Arrange
      const mockState = createMockState({
        currentFolderId: 'folder1',
        selectedFilePaths: new Set(['folder1|@|file1.ts']),
      });
      const get = vi.fn().mockReturnValue(mockState);
      const fileSelectionActions = createFileSelectionActions(mockSet, get);

      // Act
      fileSelectionActions.addSelectedFile('folder1', 'file2.ts');

      // Assert
      expect(mockSet).toHaveBeenCalledTimes(1);

      // Get the state update function
      // @ts-expect-error - TS struggles with mock call type narrowing
      const updateFn = mockSet.mock.calls[0][0];
      expect(typeof updateFn).toBe('function');

      // Call the update function with our mock state
      const updatedState = updateFn(mockState) as Partial<FileExplorerState>; // Assert return type

      expect(updatedState).toBeDefined();
      expect(updatedState.selectedFilePaths).toBeDefined(); // Assert Set exists
      expect(updatedState.selectedFilePaths?.size).toBe(2);
      expect(updatedState.selectedFilePaths?.has('folder1|@|file1.ts')).toBe(true);
      expect(updatedState.selectedFilePaths?.has('folder1|@|file2.ts')).toBe(true);
    });

    it('should not add file if max selection count is reached', () => {
      // Arrange
      const mockState = createMockState({
        currentFolderId: 'folder1',
        selectedFilePaths: new Set(['folder1|@|file1.ts']),
        maxSelectionCount: 1,
      });
      const get = vi.fn().mockReturnValue(mockState);
      const fileSelectionActions = createFileSelectionActions(mockSet, get);

      // Act
      fileSelectionActions.addSelectedFile('folder1', 'file2.ts');

      // Assert
      expect(mockSet).toHaveBeenCalledTimes(1);

      // Call the update function with our mock state
      // @ts-expect-error - TS struggles with mock call type narrowing
      const updateFn = mockSet.mock.calls[0][0];
      const updatedState = updateFn(mockState) as Partial<FileExplorerState>; // Assert return type

      // Verify the file wasn't added (same size as before)
      expect(updatedState).toBeDefined();
      expect(updatedState.selectedFilePaths).toBeDefined();
      expect(updatedState.selectedFilePaths?.size).toBe(1);
      expect(updatedState.selectedFilePaths?.has('folder1|@|file1.ts')).toBe(true);
      expect(updatedState.selectedFilePaths?.has('folder1|@|file2.ts')).toBe(false);
    });

    it('should work normally with null currentFolderId', () => {
      // Arrange
      const mockState = createMockState({
        currentFolderId: null,
        selectedFilePaths: new Set(['folder1|@|file1.ts']),
      });
      const get = vi.fn().mockReturnValue(mockState);
      const fileSelectionActions = createFileSelectionActions(mockSet, get);

      // Act
      fileSelectionActions.addSelectedFile('folder1', 'file2.ts');

      // Assert
      expect(mockSet).toHaveBeenCalledTimes(1);

      // Verify the file was added
      // @ts-expect-error - TS struggles with mock call type narrowing
      const updateFn = mockSet.mock.calls[0][0];
      const updatedState = updateFn(mockState) as Partial<FileExplorerState>; // Assert return type
      expect(updatedState).toBeDefined();
      expect(updatedState.selectedFilePaths).toBeDefined();
      expect(updatedState.selectedFilePaths?.size).toBe(2);
      expect(updatedState.selectedFilePaths?.has('folder1|@|file1.ts')).toBe(true);
      expect(updatedState.selectedFilePaths?.has('folder1|@|file2.ts')).toBe(true);
    });
  });

  describe('removeSelectedFile', () => {
    it('should remove file from selected files', () => {
      // Arrange
      const mockState = createMockState({
        currentFolderId: 'folder1',
        selectedFilePaths: new Set(['folder1|@|file1.ts', 'folder1|@|file2.ts']),
      });
      const get = vi.fn().mockReturnValue(mockState);
      const fileSelectionActions = createFileSelectionActions(mockSet, get);

      // Act
      fileSelectionActions.removeSelectedFile('folder1', 'file1.ts');

      // Assert
      expect(mockSet).toHaveBeenCalledTimes(1);

      // Get the state update function
      // @ts-expect-error - TS struggles with mock call type narrowing
      const updateFn = mockSet.mock.calls[0][0];
      expect(typeof updateFn).toBe('function');

      // Call the update function with our mock state
      const updatedState = updateFn(mockState) as Partial<FileExplorerState>; // Assert return type

      expect(updatedState).toBeDefined();
      expect(updatedState.selectedFilePaths).toBeDefined();
      expect(updatedState.selectedFilePaths?.size).toBe(1);
      expect(updatedState.selectedFilePaths?.has('folder1|@|file1.ts')).toBe(false);
      expect(updatedState.selectedFilePaths?.has('folder1|@|file2.ts')).toBe(true);
    });

    it('should work normally with null currentFolderId', () => {
      // Arrange
      const mockState = createMockState({
        currentFolderId: null,
        selectedFilePaths: new Set(['folder1|@|file1.ts', 'folder1|@|file2.ts']),
      });
      const get = vi.fn().mockReturnValue(mockState);
      const fileSelectionActions = createFileSelectionActions(mockSet, get);

      // Act
      fileSelectionActions.removeSelectedFile('folder1', 'file1.ts');

      // Assert
      expect(mockSet).toHaveBeenCalledTimes(1);

      // Verify the file was removed
      // @ts-expect-error - TS struggles with mock call type narrowing
      const updateFn = mockSet.mock.calls[0][0];
      const updatedState = updateFn(mockState) as Partial<FileExplorerState>; // Assert return type
      expect(updatedState).toBeDefined();
      expect(updatedState.selectedFilePaths).toBeDefined();
      expect(updatedState.selectedFilePaths?.size).toBe(1);
      expect(updatedState.selectedFilePaths?.has('folder1|@|file1.ts')).toBe(false);
      expect(updatedState.selectedFilePaths?.has('folder1|@|file2.ts')).toBe(true);
    });
  });

  describe('toggleSelectedFile', () => {
    it('should add file to selected files when not present', () => {
      // Arrange
      const mockState = createMockState({
        currentFolderId: 'folder1',
        selectedFilePaths: new Set(['folder1|@|file1.ts']),
      });
      const get = vi.fn().mockReturnValue(mockState);
      const fileSelectionActions = createFileSelectionActions(mockSet, get);

      // Act
      fileSelectionActions.toggleSelectedFile('folder1', 'file2.ts');

      // Assert
      expect(mockSet).toHaveBeenCalledTimes(1);

      // Get the state update function
      // @ts-expect-error - TS struggles with mock call type narrowing
      const updateFn = mockSet.mock.calls[0][0];
      expect(typeof updateFn).toBe('function');

      // Call the update function with our mock state
      const updatedState = updateFn(mockState) as Partial<FileExplorerState>; // Assert return type

      expect(updatedState).toBeDefined();
      expect(updatedState.selectedFilePaths).toBeDefined();
      expect(updatedState.selectedFilePaths?.size).toBe(2);
      expect(updatedState.selectedFilePaths?.has('folder1|@|file1.ts')).toBe(true);
      expect(updatedState.selectedFilePaths?.has('folder1|@|file2.ts')).toBe(true);
    });

    it('should remove file from selected files when present', () => {
      // Arrange
      const mockState = createMockState({
        currentFolderId: 'folder1',
        selectedFilePaths: new Set(['folder1|@|file1.ts', 'folder1|@|file2.ts']),
      });
      const get = vi.fn().mockReturnValue(mockState);
      const fileSelectionActions = createFileSelectionActions(mockSet, get);

      // Act
      fileSelectionActions.toggleSelectedFile('folder1', 'file1.ts');

      // Assert
      expect(mockSet).toHaveBeenCalledTimes(1);

      // Get the state update function
      // @ts-expect-error - TS struggles with mock call type narrowing
      const updateFn = mockSet.mock.calls[0][0];
      expect(typeof updateFn).toBe('function');

      // Call the update function with our mock state
      const updatedState = updateFn(mockState) as Partial<FileExplorerState>; // Assert return type

      expect(updatedState).toBeDefined();
      expect(updatedState.selectedFilePaths).toBeDefined();
      expect(updatedState.selectedFilePaths?.size).toBe(1);
      expect(updatedState.selectedFilePaths?.has('folder1|@|file1.ts')).toBe(false);
      expect(updatedState.selectedFilePaths?.has('folder1|@|file2.ts')).toBe(true);
    });

    it('should not add file if max selection count is reached', () => {
      // Arrange
      const mockState = createMockState({
        currentFolderId: 'folder1',
        selectedFilePaths: new Set(['folder1|@|file1.ts']),
        maxSelectionCount: 1,
      });
      const get = vi.fn().mockReturnValue(mockState);
      const fileSelectionActions = createFileSelectionActions(mockSet, get);

      // Act
      fileSelectionActions.toggleSelectedFile('folder1', 'file2.ts');

      // Assert
      expect(mockSet).toHaveBeenCalledTimes(1);

      // Call the update function with our mock state
      // @ts-expect-error - TS struggles with mock call type narrowing
      const updateFn = mockSet.mock.calls[0][0];
      const updatedState = updateFn(mockState) as Partial<FileExplorerState>; // Assert return type

      // Verify the file wasn't added (same size as before)
      expect(updatedState).toBeDefined();
      expect(updatedState.selectedFilePaths).toBeDefined();
      expect(updatedState.selectedFilePaths?.size).toBe(1);
      expect(updatedState.selectedFilePaths?.has('folder1|@|file1.ts')).toBe(true);
      expect(updatedState.selectedFilePaths?.has('folder1|@|file2.ts')).toBe(false);
    });

    it('should work normally with null currentFolderId', () => {
      // Arrange
      const mockState = createMockState({
        currentFolderId: null,
        selectedFilePaths: new Set(['folder1|@|file1.ts']),
      });
      const get = vi.fn().mockReturnValue(mockState);
      const fileSelectionActions = createFileSelectionActions(mockSet, get);

      // Act
      fileSelectionActions.toggleSelectedFile('folder1', 'file2.ts');

      // Assert
      expect(mockSet).toHaveBeenCalledTimes(1);

      // Verify the file was added
      // @ts-expect-error - TS struggles with mock call type narrowing
      const updateFn = mockSet.mock.calls[0][0];
      const updatedState = updateFn(mockState) as Partial<FileExplorerState>; // Assert return type
      expect(updatedState).toBeDefined();
      expect(updatedState.selectedFilePaths).toBeDefined();
      expect(updatedState.selectedFilePaths?.size).toBe(2);
      expect(updatedState.selectedFilePaths?.has('folder1|@|file1.ts')).toBe(true);
      expect(updatedState.selectedFilePaths?.has('folder1|@|file2.ts')).toBe(true);
    });
  });

  describe('clearSelectedFiles', () => {
    it('should clear all selected files', () => {
      // Arrange
      const fileSelectionActions = createFileSelectionActions(mockSet, vi.fn());

      // Act
      fileSelectionActions.clearSelectedFiles();

      // Assert
      expect(mockSet).toHaveBeenCalledTimes(1);
      // Check that set was called with the correct object
      expect(mockSet).toHaveBeenCalledWith({ selectedFilePaths: new Set() });
    });
  });
});
