import type { FileExplorerState } from '@brainstrike/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileSelectionActions } from '../file-selection-actions';
import { consoleSpy, createMockState, mockSet } from './file-selection-actions-test-support';

describe('file-selection-actions', () => {
  beforeEach(() => {
    mockSet.mockClear();
    consoleSpy.mockClear();
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
      const selectedFiles = new Set([
        'folder1|@|file1.ts',
        'invalid-key',
        '|@|missing-folder.ts',
        'folder1|@|',
        'folder1|@||@|nested',
      ]);
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

  describe('query-backed selection mutations', () => {
    it('returns an empty patch when query mutation targets a different folder id', () => {
      const mockState = createMockState({
        selectionModel: {
          mode: 'query',
          explicitPaths: new Set<string>(),
          ruleSetJson: null,
          materializedPaths: new Set(['/src/index.ts']),
          materializedAt: new Date().toISOString(),
          queryDescriptor: {
            kind: 'recursive-select-all',
            folderId: 'folder-2',
            rootPath: null,
            coveredDirectoryPaths: ['/src'],
            includeFilters: ['**/*.ts'],
            excludeFilters: [],
            includedPaths: [],
            excludedPaths: [],
            manifestFingerprint: 'fp-1',
            manifestSnapshotId: 'snapshot-1',
            totalSelectedCount: 2,
            useRegex: false,
          },
        },
        querySelectionManifest: {
          filePaths: ['/src/index.ts', '/src/utils.ts'],
          pathSet: new Set(['/src/index.ts', '/src/utils.ts']),
          directoryCounts: new Map([['/src', 2]]),
          fingerprint: 'fp-1',
          snapshotId: 'snapshot-1',
          status: 'ready',
          errorMessage: null,
        },
      });
      const get = vi.fn().mockReturnValue(mockState);
      const fileSelectionActions = createFileSelectionActions(mockSet, get);

      fileSelectionActions.addSelectedFile('folder1', '/src/extra.ts');

      // @ts-expect-error mock narrowing
      const updateFn = mockSet.mock.calls[0][0];
      const updatedState = updateFn(mockState) as Partial<FileExplorerState>;

      expect(updatedState).toEqual({});
    });

    it('keeps query mode and records an excluded path when removing a selected query file', () => {
      const mockState = createMockState({
        selectionModel: {
          mode: 'query',
          explicitPaths: new Set<string>(),
          ruleSetJson: null,
          materializedPaths: new Set(['/src/index.ts']),
          materializedAt: new Date().toISOString(),
          queryDescriptor: {
            kind: 'recursive-select-all',
            folderId: 'folder1',
            rootPath: null,
            coveredDirectoryPaths: ['/src'],
            includeFilters: ['**/*.ts'],
            excludeFilters: [],
            includedPaths: [],
            excludedPaths: [],
            manifestFingerprint: 'fp-1',
            manifestSnapshotId: 'snapshot-1',
            totalSelectedCount: 2,
            useRegex: false,
          },
        },
        querySelectionManifest: {
          filePaths: ['/src/index.ts', '/src/utils.ts'],
          pathSet: new Set(['/src/index.ts', '/src/utils.ts']),
          directoryCounts: new Map([['/src', 2]]),
          fingerprint: 'fp-1',
          snapshotId: 'snapshot-1',
          status: 'ready',
          errorMessage: null,
        },
      });
      const get = vi.fn().mockReturnValue(mockState);
      const fileSelectionActions = createFileSelectionActions(mockSet, get);

      fileSelectionActions.removeSelectedFile('folder1', '/src/index.ts');

      // @ts-expect-error mock narrowing
      const updateFn = mockSet.mock.calls[0][0];
      const updatedState = updateFn(mockState) as Partial<FileExplorerState>;

      expect(updatedState.selectionModel?.mode).toBe('query');
      expect(updatedState.selectionModel?.queryDescriptor?.excludedPaths).toEqual([
        '/src/index.ts',
      ]);
      expect(updatedState.selectionModel?.queryDescriptor?.totalSelectedCount).toBe(1);
      expect(updatedState.selectedFilePaths).toEqual(new Set<string>());
    });

    it('keeps query mode and records an included path when re-adding an excluded query file', () => {
      const mockState = createMockState({
        selectionModel: {
          mode: 'query',
          explicitPaths: new Set<string>(),
          ruleSetJson: null,
          materializedPaths: new Set(['/src/utils.ts']),
          materializedAt: new Date().toISOString(),
          queryDescriptor: {
            kind: 'recursive-select-all',
            folderId: 'folder1',
            rootPath: null,
            coveredDirectoryPaths: ['/src'],
            includeFilters: ['**/*.ts'],
            excludeFilters: [],
            includedPaths: [],
            excludedPaths: ['/src/index.ts'],
            manifestFingerprint: 'fp-1',
            manifestSnapshotId: 'snapshot-1',
            totalSelectedCount: 1,
            useRegex: false,
          },
        },
        querySelectionManifest: {
          filePaths: ['/src/index.ts', '/src/utils.ts'],
          pathSet: new Set(['/src/index.ts', '/src/utils.ts']),
          directoryCounts: new Map([['/src', 2]]),
          fingerprint: 'fp-1',
          snapshotId: 'snapshot-1',
          status: 'ready',
          errorMessage: null,
        },
      });
      const get = vi.fn().mockReturnValue(mockState);
      const fileSelectionActions = createFileSelectionActions(mockSet, get);

      fileSelectionActions.addSelectedFile('folder1', '/src/index.ts');

      // @ts-expect-error mock narrowing
      const updateFn = mockSet.mock.calls[0][0];
      const updatedState = updateFn(mockState) as Partial<FileExplorerState>;

      expect(updatedState.selectionModel?.mode).toBe('query');
      expect(updatedState.selectionModel?.queryDescriptor?.excludedPaths).toEqual([]);
      expect(updatedState.selectionModel?.queryDescriptor?.totalSelectedCount).toBe(2);
    });

    it('does not re-include an excluded manifest path when query selection is already at the max limit', () => {
      const mockState = createMockState({
        maxSelectionCount: 1,
        selectionModel: {
          mode: 'query',
          explicitPaths: new Set<string>(),
          ruleSetJson: null,
          materializedPaths: new Set(['/src/utils.ts']),
          materializedAt: new Date().toISOString(),
          queryDescriptor: {
            kind: 'recursive-select-all',
            folderId: 'folder1',
            rootPath: null,
            coveredDirectoryPaths: ['/src'],
            includeFilters: ['**/*.ts'],
            excludeFilters: [],
            includedPaths: [],
            excludedPaths: ['/src/index.ts'],
            manifestFingerprint: 'fp-1',
            manifestSnapshotId: 'snapshot-1',
            totalSelectedCount: 1,
            useRegex: false,
          },
        },
        querySelectionManifest: {
          filePaths: ['/src/index.ts', '/src/utils.ts'],
          pathSet: new Set(['/src/index.ts', '/src/utils.ts']),
          directoryCounts: new Map([['/src', 2]]),
          fingerprint: 'fp-1',
          snapshotId: 'snapshot-1',
          status: 'ready',
          errorMessage: null,
        },
      });
      const get = vi.fn().mockReturnValue(mockState);
      const fileSelectionActions = createFileSelectionActions(mockSet, get);

      fileSelectionActions.addSelectedFile('folder1', '/src/index.ts');

      // @ts-expect-error mock narrowing
      const updateFn = mockSet.mock.calls[0][0];
      const updatedState = updateFn(mockState) as Partial<FileExplorerState>;

      expect(updatedState).toEqual({});
    });

    it('adds a non-manifest query path as an included override and syncs compatibility keys', () => {
      const mockState = createMockState({
        selectionModel: {
          mode: 'query',
          explicitPaths: new Set<string>(),
          ruleSetJson: null,
          materializedPaths: new Set(['/src/utils.ts']),
          materializedAt: new Date().toISOString(),
          queryDescriptor: {
            kind: 'recursive-select-all',
            folderId: 'folder1',
            rootPath: null,
            coveredDirectoryPaths: ['/src'],
            includeFilters: ['**/*.ts'],
            excludeFilters: [],
            includedPaths: [],
            excludedPaths: [],
            manifestFingerprint: 'fp-1',
            manifestSnapshotId: 'snapshot-1',
            totalSelectedCount: 2,
            useRegex: false,
          },
        },
        querySelectionManifest: {
          filePaths: ['/src/index.ts', '/src/utils.ts'],
          pathSet: new Set(['/src/index.ts', '/src/utils.ts']),
          directoryCounts: new Map([['/src', 2]]),
          fingerprint: 'fp-1',
          snapshotId: 'snapshot-1',
          status: 'ready',
          errorMessage: null,
        },
      });
      const get = vi.fn().mockReturnValue(mockState);
      const fileSelectionActions = createFileSelectionActions(mockSet, get);

      fileSelectionActions.addSelectedFile('folder1', '/src/extra.ts');

      // @ts-expect-error mock narrowing
      const updateFn = mockSet.mock.calls[0][0];
      const updatedState = updateFn(mockState) as Partial<FileExplorerState>;

      expect(updatedState.selectionModel?.queryDescriptor?.includedPaths).toEqual([
        '/src/extra.ts',
      ]);
      expect(updatedState.selectionModel?.queryDescriptor?.totalSelectedCount).toBe(3);
      expect(updatedState.selectedFilePaths).toEqual(new Set(['folder1|@|/src/extra.ts']));
    });

    it('toggles a query-backed selected path off using the canonical manifest membership', () => {
      const mockState = createMockState({
        selectionModel: {
          mode: 'query',
          explicitPaths: new Set<string>(),
          ruleSetJson: null,
          materializedPaths: new Set(['/src/index.ts']),
          materializedAt: new Date().toISOString(),
          queryDescriptor: {
            kind: 'recursive-select-all',
            folderId: 'folder1',
            rootPath: null,
            coveredDirectoryPaths: ['/src'],
            includeFilters: ['**/*.ts'],
            excludeFilters: [],
            includedPaths: [],
            excludedPaths: [],
            manifestFingerprint: 'fp-1',
            manifestSnapshotId: 'snapshot-1',
            totalSelectedCount: 2,
            useRegex: false,
          },
        },
        querySelectionManifest: {
          filePaths: ['/src/index.ts', '/src/utils.ts'],
          pathSet: new Set(['/src/index.ts', '/src/utils.ts']),
          directoryCounts: new Map([['/src', 2]]),
          fingerprint: 'fp-1',
          snapshotId: 'snapshot-1',
          status: 'ready',
          errorMessage: null,
        },
      });
      const get = vi.fn().mockReturnValue(mockState);
      const fileSelectionActions = createFileSelectionActions(mockSet, get);

      fileSelectionActions.toggleSelectedFile('folder1', '/src/index.ts');

      // @ts-expect-error mock narrowing
      const updateFn = mockSet.mock.calls[0][0];
      const updatedState = updateFn(mockState) as Partial<FileExplorerState>;

      expect(updatedState.selectionModel?.queryDescriptor?.excludedPaths).toEqual([
        '/src/index.ts',
      ]);
      expect(updatedState.selectionModel?.queryDescriptor?.totalSelectedCount).toBe(1);
    });

    it('adds and removes multiple paths in query mode without leaving query mode', () => {
      const baseState = createMockState({
        selectionModel: {
          mode: 'query',
          explicitPaths: new Set<string>(),
          ruleSetJson: null,
          materializedPaths: new Set(['/src/index.ts']),
          materializedAt: new Date().toISOString(),
          queryDescriptor: {
            kind: 'recursive-select-all',
            folderId: 'folder1',
            rootPath: null,
            coveredDirectoryPaths: ['/src'],
            includeFilters: ['**/*.ts'],
            excludeFilters: [],
            includedPaths: [],
            excludedPaths: [],
            manifestFingerprint: 'fp-1',
            manifestSnapshotId: 'snapshot-1',
            totalSelectedCount: 2,
            useRegex: false,
          },
        },
        querySelectionManifest: {
          filePaths: ['/src/index.ts', '/src/utils.ts'],
          pathSet: new Set(['/src/index.ts', '/src/utils.ts']),
          directoryCounts: new Map([['/src', 2]]),
          fingerprint: 'fp-1',
          snapshotId: 'snapshot-1',
          status: 'ready',
          errorMessage: null,
        },
      });
      const get = vi.fn().mockReturnValue(baseState);
      const fileSelectionActions = createFileSelectionActions(mockSet, get);

      fileSelectionActions.addMultipleSelectedFiles('folder1', ['/src/extra.ts']);
      // @ts-expect-error mock narrowing
      const addUpdateFn = mockSet.mock.calls[0][0];
      const addedState = addUpdateFn(baseState) as Partial<FileExplorerState>;
      expect(addedState.selectionModel?.mode).toBe('query');
      expect(addedState.selectionModel?.queryDescriptor?.includedPaths).toEqual(['/src/extra.ts']);

      mockSet.mockClear();
      fileSelectionActions.removeMultipleSelectedFiles('folder1', ['/src/index.ts']);
      // @ts-expect-error mock narrowing
      const removeUpdateFn = mockSet.mock.calls[0][0];
      const removedState = removeUpdateFn(baseState) as Partial<FileExplorerState>;
      expect(removedState.selectionModel?.mode).toBe('query');
      expect(removedState.selectionModel?.queryDescriptor?.excludedPaths).toEqual([
        '/src/index.ts',
      ]);
    });

    it('returns an empty patch while the query manifest is still loading', () => {
      const mockState = createMockState({
        selectionModel: {
          mode: 'query',
          explicitPaths: new Set<string>(),
          ruleSetJson: null,
          materializedPaths: new Set(['/src/index.ts']),
          materializedAt: new Date().toISOString(),
          queryDescriptor: {
            kind: 'recursive-select-all',
            folderId: 'folder1',
            rootPath: null,
            coveredDirectoryPaths: ['/src'],
            includeFilters: ['**/*.ts'],
            excludeFilters: [],
            includedPaths: [],
            excludedPaths: [],
            manifestFingerprint: 'fp-1',
            manifestSnapshotId: 'snapshot-1',
            totalSelectedCount: 2,
            useRegex: false,
          },
        },
        querySelectionManifest: {
          filePaths: [],
          pathSet: new Set<string>(),
          directoryCounts: new Map<string, number>(),
          fingerprint: 'fp-1',
          snapshotId: 'snapshot-1',
          status: 'loading',
          errorMessage: null,
        },
      });
      const get = vi.fn().mockReturnValue(mockState);
      const fileSelectionActions = createFileSelectionActions(mockSet, get);

      fileSelectionActions.addSelectedFile('folder1', '/src/extra.ts');

      // @ts-expect-error mock narrowing
      const updateFn = mockSet.mock.calls[0][0];
      const updatedState = updateFn(mockState) as Partial<FileExplorerState>;

      expect(updatedState).toEqual({});
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
      const mockState = createMockState({
        selectedFilePaths: new Set(['folder1|@|file.ts']),
        selectionModel: {
          mode: 'explicit',
          explicitPaths: new Set(['folder1|@|file.ts']),
          ruleSetJson: null,
          materializedPaths: null,
          materializedAt: null,
          queryDescriptor: null,
        },
        selectionVersion: 5,
      });
      const fileSelectionActions = createFileSelectionActions(mockSet, vi.fn());

      // Act
      fileSelectionActions.clearSelectedFiles();

      // Assert
      expect(mockSet).toHaveBeenCalledTimes(1);
      // Check that set was called with a function that clears files and increments version
      const setCallback = mockSet.mock.calls[0][0] as (state: typeof mockState) => {
        selectedFilePaths: Set<string>;
        selectionVersion: number;
      };
      const result = setCallback(mockState);
      expect(result.selectedFilePaths).toEqual(new Set());
      expect(result.selectionModel.explicitPaths).toEqual(new Set());
      expect(result.selectionVersion).toBe(6);
    });
  });

  describe('addMultipleSelectedFiles', () => {
    it('should add multiple files to selected files', () => {
      // Arrange
      const mockState = createMockState({
        selectedFilePaths: new Set(['folder1|@|existing.ts']),
        maxSelectionCount: 10,
      });
      const get = vi.fn().mockReturnValue(mockState);
      const fileSelectionActions = createFileSelectionActions(mockSet, get);
      const pathsToAdd = ['file1.ts', 'file2.ts', 'file3.ts'];

      // Act
      fileSelectionActions.addMultipleSelectedFiles('folder1', pathsToAdd);

      // Assert
      expect(mockSet).toHaveBeenCalledTimes(1);

      // Get the state update function
      // @ts-expect-error - TS struggles with mock call type narrowing
      const updateFn = mockSet.mock.calls[0][0];
      expect(typeof updateFn).toBe('function');

      // Call the update function with our mock state
      const updatedState = updateFn(mockState) as Partial<FileExplorerState>;

      expect(updatedState).toBeDefined();
      expect(updatedState.selectedFilePaths).toBeDefined();
      expect(updatedState.selectedFilePaths?.size).toBe(4); // 1 existing + 3 new
      expect(updatedState.selectedFilePaths?.has('folder1|@|existing.ts')).toBe(true);
      expect(updatedState.selectedFilePaths?.has('folder1|@|file1.ts')).toBe(true);
      expect(updatedState.selectedFilePaths?.has('folder1|@|file2.ts')).toBe(true);
      expect(updatedState.selectedFilePaths?.has('folder1|@|file3.ts')).toBe(true);
    });

    it('should respect max selection count limit', () => {
      // Arrange
      const mockState = createMockState({
        selectedFilePaths: new Set(['folder1|@|existing1.ts', 'folder1|@|existing2.ts']),
        maxSelectionCount: 4, // Only 2 more slots available
      });
      const get = vi.fn().mockReturnValue(mockState);
      const fileSelectionActions = createFileSelectionActions(mockSet, get);
      const pathsToAdd = ['file1.ts', 'file2.ts', 'file3.ts', 'file4.ts']; // Trying to add 4, but only 2 slots

      // Act
      fileSelectionActions.addMultipleSelectedFiles('folder1', pathsToAdd);

      // Assert
      expect(mockSet).toHaveBeenCalledTimes(1);

      // @ts-expect-error - TS struggles with mock call type narrowing
      const updateFn = mockSet.mock.calls[0][0];
      const updatedState = updateFn(mockState) as Partial<FileExplorerState>;

      expect(updatedState).toBeDefined();
      expect(updatedState.selectedFilePaths).toBeDefined();
      expect(updatedState.selectedFilePaths?.size).toBe(4); // Should stop at max limit
      expect(updatedState.selectedFilePaths?.has('folder1|@|existing1.ts')).toBe(true);
      expect(updatedState.selectedFilePaths?.has('folder1|@|existing2.ts')).toBe(true);
      expect(updatedState.selectedFilePaths?.has('folder1|@|file1.ts')).toBe(true);
      expect(updatedState.selectedFilePaths?.has('folder1|@|file2.ts')).toBe(true);
      // These should not be added due to limit
      expect(updatedState.selectedFilePaths?.has('folder1|@|file3.ts')).toBe(false);
      expect(updatedState.selectedFilePaths?.has('folder1|@|file4.ts')).toBe(false);
    });

    it('should not add files that are already selected', () => {
      // Arrange
      const mockState = createMockState({
        selectedFilePaths: new Set(['folder1|@|file1.ts', 'folder1|@|file2.ts']),
        maxSelectionCount: 10,
      });
      const get = vi.fn().mockReturnValue(mockState);
      const fileSelectionActions = createFileSelectionActions(mockSet, get);
      const pathsToAdd = ['file1.ts', 'file3.ts', 'file2.ts']; // file1.ts and file2.ts already selected

      // Act
      fileSelectionActions.addMultipleSelectedFiles('folder1', pathsToAdd);

      // Assert
      expect(mockSet).toHaveBeenCalledTimes(1);

      // @ts-expect-error - TS struggles with mock call type narrowing
      const updateFn = mockSet.mock.calls[0][0];
      const updatedState = updateFn(mockState) as Partial<FileExplorerState>;

      expect(updatedState).toBeDefined();
      expect(updatedState.selectedFilePaths).toBeDefined();
      expect(updatedState.selectedFilePaths?.size).toBe(3); // Only file3.ts should be added
      expect(updatedState.selectedFilePaths?.has('folder1|@|file1.ts')).toBe(true);
      expect(updatedState.selectedFilePaths?.has('folder1|@|file2.ts')).toBe(true);
      expect(updatedState.selectedFilePaths?.has('folder1|@|file3.ts')).toBe(true);
    });

    it('should handle empty paths array', () => {
      // Arrange
      const mockState = createMockState({
        selectedFilePaths: new Set(['folder1|@|existing.ts']),
        maxSelectionCount: 10,
      });
      const get = vi.fn().mockReturnValue(mockState);
      const fileSelectionActions = createFileSelectionActions(mockSet, get);

      // Act
      fileSelectionActions.addMultipleSelectedFiles('folder1', []);

      // Assert
      expect(mockSet).toHaveBeenCalledTimes(1);

      // @ts-expect-error - TS struggles with mock call type narrowing
      const updateFn = mockSet.mock.calls[0][0];
      const updatedState = updateFn(mockState) as Partial<FileExplorerState>;

      expect(updatedState).toBeDefined();
      expect(updatedState.selectedFilePaths).toBeDefined();
      expect(updatedState.selectedFilePaths?.size).toBe(1); // Should remain unchanged
      expect(updatedState.selectedFilePaths?.has('folder1|@|existing.ts')).toBe(true);
    });

    it('should handle case where max selection count is already reached', () => {
      // Arrange
      const mockState = createMockState({
        selectedFilePaths: new Set(['folder1|@|file1.ts', 'folder1|@|file2.ts']),
        maxSelectionCount: 2, // Already at max
      });
      const get = vi.fn().mockReturnValue(mockState);
      const fileSelectionActions = createFileSelectionActions(mockSet, get);
      const pathsToAdd = ['file3.ts', 'file4.ts'];

      // Act
      fileSelectionActions.addMultipleSelectedFiles('folder1', pathsToAdd);

      // Assert
      expect(mockSet).toHaveBeenCalledTimes(1);

      // @ts-expect-error - TS struggles with mock call type narrowing
      const updateFn = mockSet.mock.calls[0][0];
      const updatedState = updateFn(mockState) as Partial<FileExplorerState>;

      expect(updatedState).toBeDefined();
      expect(updatedState.selectedFilePaths).toBeDefined();
      expect(updatedState.selectedFilePaths?.size).toBe(2); // Should remain unchanged
      expect(updatedState.selectedFilePaths?.has('folder1|@|file1.ts')).toBe(true);
      expect(updatedState.selectedFilePaths?.has('folder1|@|file2.ts')).toBe(true);
      expect(updatedState.selectedFilePaths?.has('folder1|@|file3.ts')).toBe(false);
      expect(updatedState.selectedFilePaths?.has('folder1|@|file4.ts')).toBe(false);
    });

    it('should handle large batch operations efficiently', () => {
      // Arrange
      const mockState = createMockState({
        selectedFilePaths: new Set(),
        maxSelectionCount: 1000,
      });
      const get = vi.fn().mockReturnValue(mockState);
      const fileSelectionActions = createFileSelectionActions(mockSet, get);
      const pathsToAdd = Array.from({ length: 500 }, (_, i) => `file${i}.ts`);

      // Act
      fileSelectionActions.addMultipleSelectedFiles('folder1', pathsToAdd);

      // Assert
      expect(mockSet).toHaveBeenCalledTimes(1);

      // @ts-expect-error - TS struggles with mock call type narrowing
      const updateFn = mockSet.mock.calls[0][0];
      const updatedState = updateFn(mockState) as Partial<FileExplorerState>;

      expect(updatedState).toBeDefined();
      expect(updatedState.selectedFilePaths).toBeDefined();
      expect(updatedState.selectedFilePaths?.size).toBe(500);

      // Verify a few random files were added
      expect(updatedState.selectedFilePaths?.has('folder1|@|file0.ts')).toBe(true);
      expect(updatedState.selectedFilePaths?.has('folder1|@|file250.ts')).toBe(true);
      expect(updatedState.selectedFilePaths?.has('folder1|@|file499.ts')).toBe(true);
    });
  });

  describe('removeMultipleSelectedFiles', () => {
    it('should remove multiple files from selected files', () => {
      // Arrange
      const mockState = createMockState({
        selectedFilePaths: new Set([
          'folder1|@|file1.ts',
          'folder1|@|file2.ts',
          'folder1|@|file3.ts',
          'folder1|@|file4.ts',
          'folder1|@|file5.ts',
        ]),
        maxSelectionCount: 10,
      });
      const get = vi.fn().mockReturnValue(mockState);
      const fileSelectionActions = createFileSelectionActions(mockSet, get);
      const pathsToRemove = ['file2.ts', 'file4.ts'];

      // Act
      fileSelectionActions.removeMultipleSelectedFiles('folder1', pathsToRemove);

      // Assert
      expect(mockSet).toHaveBeenCalledTimes(1);

      // Get the state update function
      // @ts-expect-error - TS struggles with mock call type narrowing
      const updateFn = mockSet.mock.calls[0][0];
      expect(typeof updateFn).toBe('function');

      // Call the update function with our mock state
      const updatedState = updateFn(mockState) as Partial<FileExplorerState>;

      expect(updatedState).toBeDefined();
      expect(updatedState.selectedFilePaths).toBeDefined();
      expect(updatedState.selectedFilePaths?.size).toBe(3); // 5 - 2 = 3
      expect(updatedState.selectedFilePaths?.has('folder1|@|file1.ts')).toBe(true);
      expect(updatedState.selectedFilePaths?.has('folder1|@|file2.ts')).toBe(false);
      expect(updatedState.selectedFilePaths?.has('folder1|@|file3.ts')).toBe(true);
      expect(updatedState.selectedFilePaths?.has('folder1|@|file4.ts')).toBe(false);
      expect(updatedState.selectedFilePaths?.has('folder1|@|file5.ts')).toBe(true);
    });

    it('should handle removing files that are not selected', () => {
      // Arrange
      const mockState = createMockState({
        selectedFilePaths: new Set(['folder1|@|file1.ts', 'folder1|@|file3.ts']),
        maxSelectionCount: 10,
      });
      const get = vi.fn().mockReturnValue(mockState);
      const fileSelectionActions = createFileSelectionActions(mockSet, get);
      const pathsToRemove = ['file1.ts', 'file2.ts', 'file4.ts']; // file2.ts and file4.ts not selected

      // Act
      fileSelectionActions.removeMultipleSelectedFiles('folder1', pathsToRemove);

      // Assert
      expect(mockSet).toHaveBeenCalledTimes(1);

      // @ts-expect-error - TS struggles with mock call type narrowing
      const updateFn = mockSet.mock.calls[0][0];
      const updatedState = updateFn(mockState) as Partial<FileExplorerState>;

      expect(updatedState).toBeDefined();
      expect(updatedState.selectedFilePaths).toBeDefined();
      expect(updatedState.selectedFilePaths?.size).toBe(1); // Only file1.ts should be removed
      expect(updatedState.selectedFilePaths?.has('folder1|@|file1.ts')).toBe(false);
      expect(updatedState.selectedFilePaths?.has('folder1|@|file3.ts')).toBe(true);
    });

    it('should handle empty paths array', () => {
      // Arrange
      const mockState = createMockState({
        selectedFilePaths: new Set(['folder1|@|file1.ts', 'folder1|@|file2.ts']),
        maxSelectionCount: 10,
      });
      const get = vi.fn().mockReturnValue(mockState);
      const fileSelectionActions = createFileSelectionActions(mockSet, get);

      // Act
      fileSelectionActions.removeMultipleSelectedFiles('folder1', []);

      // Assert
      expect(mockSet).toHaveBeenCalledTimes(1);

      // @ts-expect-error - TS struggles with mock call type narrowing
      const updateFn = mockSet.mock.calls[0][0];
      const updatedState = updateFn(mockState) as Partial<FileExplorerState>;

      expect(updatedState).toBeDefined();
      expect(updatedState.selectedFilePaths).toBeDefined();
      expect(updatedState.selectedFilePaths?.size).toBe(2); // Should remain unchanged
      expect(updatedState.selectedFilePaths?.has('folder1|@|file1.ts')).toBe(true);
      expect(updatedState.selectedFilePaths?.has('folder1|@|file2.ts')).toBe(true);
    });

    it('should remove all files when all selected files are in the removal list', () => {
      // Arrange
      const mockState = createMockState({
        selectedFilePaths: new Set([
          'folder1|@|file1.ts',
          'folder1|@|file2.ts',
          'folder1|@|file3.ts',
        ]),
        maxSelectionCount: 10,
      });
      const get = vi.fn().mockReturnValue(mockState);
      const fileSelectionActions = createFileSelectionActions(mockSet, get);
      const pathsToRemove = ['file1.ts', 'file2.ts', 'file3.ts'];

      // Act
      fileSelectionActions.removeMultipleSelectedFiles('folder1', pathsToRemove);

      // Assert
      expect(mockSet).toHaveBeenCalledTimes(1);

      // @ts-expect-error - TS struggles with mock call type narrowing
      const updateFn = mockSet.mock.calls[0][0];
      const updatedState = updateFn(mockState) as Partial<FileExplorerState>;

      expect(updatedState).toBeDefined();
      expect(updatedState.selectedFilePaths).toBeDefined();
      expect(updatedState.selectedFilePaths?.size).toBe(0);
    });

    it('should handle large batch removal operations efficiently', () => {
      // Arrange
      const initialFiles = Array.from({ length: 1000 }, (_, i) => `folder1|@|file${i}.ts`);
      const mockState = createMockState({
        selectedFilePaths: new Set(initialFiles),
        maxSelectionCount: 1000,
      });
      const get = vi.fn().mockReturnValue(mockState);
      const fileSelectionActions = createFileSelectionActions(mockSet, get);
      const pathsToRemove = Array.from({ length: 500 }, (_, i) => `file${i * 2}.ts`); // Remove every other file

      // Act
      fileSelectionActions.removeMultipleSelectedFiles('folder1', pathsToRemove);

      // Assert
      expect(mockSet).toHaveBeenCalledTimes(1);

      // @ts-expect-error - TS struggles with mock call type narrowing
      const updateFn = mockSet.mock.calls[0][0];
      const updatedState = updateFn(mockState) as Partial<FileExplorerState>;

      expect(updatedState).toBeDefined();
      expect(updatedState.selectedFilePaths).toBeDefined();
      expect(updatedState.selectedFilePaths?.size).toBe(500); // 1000 - 500 = 500

      // Verify some files were removed and others remain
      expect(updatedState.selectedFilePaths?.has('folder1|@|file0.ts')).toBe(false); // Should be removed
      expect(updatedState.selectedFilePaths?.has('folder1|@|file1.ts')).toBe(true); // Should remain
      expect(updatedState.selectedFilePaths?.has('folder1|@|file2.ts')).toBe(false); // Should be removed
      expect(updatedState.selectedFilePaths?.has('folder1|@|file3.ts')).toBe(true); // Should remain
    });

    it('should handle mixed folder IDs correctly', () => {
      // Arrange
      const mockState = createMockState({
        selectedFilePaths: new Set([
          'folder1|@|file1.ts',
          'folder1|@|file2.ts',
          'folder2|@|file1.ts',
          'folder2|@|file2.ts',
        ]),
        maxSelectionCount: 10,
      });
      const get = vi.fn().mockReturnValue(mockState);
      const fileSelectionActions = createFileSelectionActions(mockSet, get);
      const pathsToRemove = ['file1.ts', 'file2.ts']; // Should only remove from folder1

      // Act
      fileSelectionActions.removeMultipleSelectedFiles('folder1', pathsToRemove);

      // Assert
      expect(mockSet).toHaveBeenCalledTimes(1);

      // @ts-expect-error - TS struggles with mock call type narrowing
      const updateFn = mockSet.mock.calls[0][0];
      const updatedState = updateFn(mockState) as Partial<FileExplorerState>;

      expect(updatedState).toBeDefined();
      expect(updatedState.selectedFilePaths).toBeDefined();
      expect(updatedState.selectedFilePaths?.size).toBe(2); // Only folder1 files should be removed
      expect(updatedState.selectedFilePaths?.has('folder1|@|file1.ts')).toBe(false);
      expect(updatedState.selectedFilePaths?.has('folder1|@|file2.ts')).toBe(false);
      expect(updatedState.selectedFilePaths?.has('folder2|@|file1.ts')).toBe(true);
      expect(updatedState.selectedFilePaths?.has('folder2|@|file2.ts')).toBe(true);
    });
  });

  describe('addMultipleSelectedFilesChunked', () => {
    it('uses query mutation in the small selection path when the store is already in query mode', async () => {
      let currentState = createMockState({
        maxSelectionCount: 10,
        selectionModel: {
          mode: 'query',
          explicitPaths: new Set<string>(),
          ruleSetJson: null,
          materializedPaths: new Set(['/src/index.ts']),
          materializedAt: new Date().toISOString(),
          queryDescriptor: {
            kind: 'recursive-select-all',
            folderId: 'folder1',
            rootPath: null,
            coveredDirectoryPaths: ['/src'],
            includeFilters: ['**/*.ts'],
            excludeFilters: [],
            includedPaths: [],
            excludedPaths: [],
            manifestFingerprint: 'fp-1',
            manifestSnapshotId: 'snapshot-1',
            totalSelectedCount: 1,
            useRegex: false,
          },
        },
        querySelectionManifest: {
          filePaths: ['/src/index.ts'],
          pathSet: new Set(['/src/index.ts']),
          directoryCounts: new Map([['/src', 1]]),
          fingerprint: 'fp-1',
          snapshotId: 'snapshot-1',
          status: 'ready',
          errorMessage: null,
        },
      });
      const get = vi.fn(() => currentState);
      const fileSelectionActions = createFileSelectionActions(mockSet, get);

      mockSet.mockImplementation((updater) => {
        if (typeof updater === 'function') {
          const result = updater(currentState) as Partial<FileExplorerState>;
          currentState = {
            ...currentState,
            ...result,
            selectionModel: result.selectionModel ?? currentState.selectionModel,
            selectedFilePaths: result.selectedFilePaths ?? currentState.selectedFilePaths,
          };
        }
      });

      const result = await fileSelectionActions.addMultipleSelectedFilesChunked('folder1', [
        '/src/extra.ts',
      ]);

      expect(result).toEqual({
        addedCount: 1,
        cancelled: false,
        limitReached: false,
      });
      expect(currentState.selectionModel.queryDescriptor?.includedPaths).toEqual(['/src/extra.ts']);
      expect(currentState.selectionModel.queryDescriptor?.totalSelectedCount).toBe(2);
    });

    it('uses query mutation in the large selection path when the store is already in query mode', async () => {
      let currentState = createMockState({
        maxSelectionCount: 10,
        selectionModel: {
          mode: 'query',
          explicitPaths: new Set<string>(),
          ruleSetJson: null,
          materializedPaths: new Set(['/src/index.ts']),
          materializedAt: new Date().toISOString(),
          queryDescriptor: {
            kind: 'recursive-select-all',
            folderId: 'folder1',
            rootPath: null,
            coveredDirectoryPaths: ['/src'],
            includeFilters: ['**/*.ts'],
            excludeFilters: [],
            includedPaths: [],
            excludedPaths: [],
            manifestFingerprint: 'fp-1',
            manifestSnapshotId: 'snapshot-1',
            totalSelectedCount: 1,
            useRegex: false,
          },
        },
        querySelectionManifest: {
          filePaths: ['/src/index.ts'],
          pathSet: new Set(['/src/index.ts']),
          directoryCounts: new Map([['/src', 1]]),
          fingerprint: 'fp-1',
          snapshotId: 'snapshot-1',
          status: 'ready',
          errorMessage: null,
        },
      });
      const get = vi.fn(() => currentState);
      const fileSelectionActions = createFileSelectionActions(mockSet, get);
      const progress = vi.fn();

      mockSet.mockImplementation((updater) => {
        if (typeof updater === 'function') {
          const result = updater(currentState) as Partial<FileExplorerState>;
          currentState = {
            ...currentState,
            ...result,
            selectionModel: result.selectionModel ?? currentState.selectionModel,
            selectedFilePaths: result.selectedFilePaths ?? currentState.selectedFilePaths,
          };
        }
      });

      const result = await fileSelectionActions.addMultipleSelectedFilesChunked(
        'folder1',
        ['/src/extra-1.ts', '/src/extra-2.ts'],
        { chunkSize: 1, onProgress: progress }
      );

      expect(result).toEqual({
        addedCount: 2,
        cancelled: false,
        limitReached: false,
      });
      expect(progress).toHaveBeenCalledWith(2, 2);
      expect(currentState.selectionModel.queryDescriptor?.includedPaths).toEqual([
        '/src/extra-1.ts',
        '/src/extra-2.ts',
      ]);
      expect(currentState.selectionModel.queryDescriptor?.totalSelectedCount).toBe(3);
    });

    it('uses the updater state for query-path result deltas even if get() changes after set()', async () => {
      let currentState = createMockState({
        maxSelectionCount: 10,
        selectionModel: {
          mode: 'query',
          explicitPaths: new Set<string>(),
          ruleSetJson: null,
          materializedPaths: new Set(['/src/index.ts']),
          materializedAt: new Date().toISOString(),
          queryDescriptor: {
            kind: 'recursive-select-all',
            folderId: 'folder1',
            rootPath: null,
            coveredDirectoryPaths: ['/src'],
            includeFilters: ['**/*.ts'],
            excludeFilters: [],
            includedPaths: [],
            excludedPaths: [],
            manifestFingerprint: 'fp-1',
            manifestSnapshotId: 'snapshot-1',
            totalSelectedCount: 1,
            useRegex: false,
          },
        },
        querySelectionManifest: {
          filePaths: ['/src/index.ts'],
          pathSet: new Set(['/src/index.ts']),
          directoryCounts: new Map([['/src', 1]]),
          fingerprint: 'fp-1',
          snapshotId: 'snapshot-1',
          status: 'ready',
          errorMessage: null,
        },
      });
      const get = vi.fn(() => currentState);
      const fileSelectionActions = createFileSelectionActions(mockSet, get);
      let authoritativeSelectedCount = 0;

      mockSet.mockImplementation((updater) => {
        if (typeof updater === 'function') {
          const result = updater(currentState) as Partial<FileExplorerState>;
          currentState = {
            ...currentState,
            ...result,
            selectionModel: result.selectionModel ?? currentState.selectionModel,
            selectedFilePaths: result.selectedFilePaths ?? currentState.selectedFilePaths,
          };
          authoritativeSelectedCount =
            currentState.selectionModel.queryDescriptor?.totalSelectedCount ?? 0;
          currentState = {
            ...currentState,
            selectionModel: {
              ...currentState.selectionModel,
              queryDescriptor: {
                ...currentState.selectionModel.queryDescriptor!,
                totalSelectedCount: 999,
              },
            },
          };
        }
      });

      const result = await fileSelectionActions.addMultipleSelectedFilesChunked('folder1', [
        '/src/extra.ts',
      ]);

      expect(result).toEqual({
        addedCount: 1,
        cancelled: false,
        limitReached: false,
      });
      expect(authoritativeSelectedCount).toBe(2);
    });

    it('should add files for small selections (under chunk size)', async () => {
      // Arrange
      const mockState = createMockState({
        selectedFilePaths: new Set<string>(),
        maxSelectionCount: 1000,
      });
      const get = vi.fn().mockReturnValue(mockState);
      const fileSelectionActions = createFileSelectionActions(mockSet, get);
      const pathsToAdd = ['file1.ts', 'file2.ts', 'file3.ts'];

      // Simulate state updates
      mockSet.mockImplementation((updater) => {
        if (typeof updater === 'function') {
          const result = updater(mockState);
          mockState.selectedFilePaths = result.selectedFilePaths;
          mockState.selectionVersion = result.selectionVersion;
        }
      });

      // Act
      const result = await fileSelectionActions.addMultipleSelectedFilesChunked(
        'folder1',
        pathsToAdd
      );

      // Assert
      expect(result.addedCount).toBe(3);
      expect(result.cancelled).toBe(false);
      expect(result.limitReached).toBe(false);
      expect(mockSet).toHaveBeenCalled();
    });

    it('should process large selections in chunks', async () => {
      // Arrange
      let currentState = createMockState({
        selectedFilePaths: new Set<string>(),
        maxSelectionCount: 1000,
      });
      const get = vi.fn(() => currentState);
      const fileSelectionActions = createFileSelectionActions(mockSet, get);
      const pathsToAdd = Array.from({ length: 250 }, (_, i) => `file${i}.ts`);

      // Track progress callbacks (fired per chunk during key computation phase)
      const progressUpdates: Array<{ processed: number; total: number }> = [];
      mockSet.mockImplementation((updater) => {
        if (typeof updater === 'function') {
          const result = updater(currentState);
          currentState = {
            ...currentState,
            selectedFilePaths: result.selectedFilePaths,
            selectionVersion: result.selectionVersion,
          };
        }
      });

      // Act
      const result = await fileSelectionActions.addMultipleSelectedFilesChunked(
        'folder1',
        pathsToAdd,
        {
          chunkSize: 100,
          onProgress: (processed, total) => {
            progressUpdates.push({ processed, total });
          },
        }
      );

      // Assert
      expect(result.addedCount).toBe(250);
      expect(result.cancelled).toBe(false);
      expect(result.limitReached).toBe(false);
      // Two-phase approach: keys are computed in chunks (verified via progress),
      // then applied in a single atomic set() call
      expect(progressUpdates.length).toBeGreaterThanOrEqual(3);
      // Single atomic state update (the optimization)
      expect(mockSet).toHaveBeenCalledTimes(1);
    });

    it('should respect max selection count limit', async () => {
      // Arrange
      let currentState = createMockState({
        selectedFilePaths: new Set<string>(),
        maxSelectionCount: 50,
      });
      const get = vi.fn(() => currentState);
      const fileSelectionActions = createFileSelectionActions(mockSet, get);
      const pathsToAdd = Array.from({ length: 100 }, (_, i) => `file${i}.ts`);

      mockSet.mockImplementation((updater) => {
        if (typeof updater === 'function') {
          const result = updater(currentState);
          currentState = {
            ...currentState,
            selectedFilePaths: result.selectedFilePaths,
            selectionVersion: result.selectionVersion,
          };
        }
      });

      // Act
      const result = await fileSelectionActions.addMultipleSelectedFilesChunked(
        'folder1',
        pathsToAdd,
        {
          chunkSize: 25,
        }
      );

      // Assert
      expect(result.addedCount).toBe(50);
      expect(result.limitReached).toBe(true);
      expect(currentState.selectedFilePaths.size).toBe(50);
    });

    it('does not report limitReached when chunked additions exactly fill the remaining budget', async () => {
      let currentState = createMockState({
        selectedFilePaths: new Set<string>(),
        maxSelectionCount: 160,
      });
      const get = vi.fn(() => currentState);
      const fileSelectionActions = createFileSelectionActions(mockSet, get);
      const pathsToAdd = Array.from({ length: 160 }, (_, i) => `file${i}.ts`);

      mockSet.mockImplementation((updater) => {
        if (typeof updater === 'function') {
          const result = updater(currentState);
          currentState = {
            ...currentState,
            selectedFilePaths: result.selectedFilePaths,
            selectionVersion: result.selectionVersion,
          };
        }
      });

      const result = await fileSelectionActions.addMultipleSelectedFilesChunked(
        'folder1',
        pathsToAdd,
        {
          chunkSize: 50,
        }
      );

      expect(result.addedCount).toBe(160);
      expect(result.limitReached).toBe(false);
      expect(currentState.selectedFilePaths.size).toBe(160);
    });

    it('should support cancellation via AbortSignal', async () => {
      // Arrange
      let currentState = createMockState({
        selectedFilePaths: new Set<string>(),
        maxSelectionCount: 1000,
      });
      const get = vi.fn(() => currentState);
      const fileSelectionActions = createFileSelectionActions(mockSet, get);
      const pathsToAdd = Array.from({ length: 500 }, (_, i) => `file${i}.ts`);

      const abortController = new AbortController();

      mockSet.mockImplementation((updater) => {
        if (typeof updater === 'function') {
          const result = updater(currentState);
          currentState = {
            ...currentState,
            selectedFilePaths: result.selectedFilePaths,
            selectionVersion: result.selectionVersion,
          };
        }
      });

      // Act — cancel during key computation phase (after first chunk's progress)
      const result = await fileSelectionActions.addMultipleSelectedFilesChunked(
        'folder1',
        pathsToAdd,
        {
          chunkSize: 50,
          signal: abortController.signal,
          onProgress: (processed) => {
            // Cancel after first chunk is computed
            if (processed >= 50) {
              abortController.abort();
            }
          },
        }
      );

      // Assert
      expect(result.cancelled).toBe(true);
      // Should have stopped early — only the first chunk's keys get applied
      expect(result.addedCount).toBeLessThan(500);
      // Partial results are still applied from computed keys before cancellation
      expect(result.addedCount).toBeGreaterThan(0);
    });

    it('should call onProgress callback with progress updates', async () => {
      // Arrange
      let currentState = createMockState({
        selectedFilePaths: new Set<string>(),
        maxSelectionCount: 1000,
      });
      const get = vi.fn(() => currentState);
      const fileSelectionActions = createFileSelectionActions(mockSet, get);
      const pathsToAdd = Array.from({ length: 150 }, (_, i) => `file${i}.ts`);
      const progressUpdates: Array<{ processed: number; total: number }> = [];

      mockSet.mockImplementation((updater) => {
        if (typeof updater === 'function') {
          const result = updater(currentState);
          currentState = {
            ...currentState,
            selectedFilePaths: result.selectedFilePaths,
            selectionVersion: result.selectionVersion,
          };
        }
      });

      // Act
      await fileSelectionActions.addMultipleSelectedFilesChunked('folder1', pathsToAdd, {
        chunkSize: 50,
        onProgress: (processed, total) => {
          progressUpdates.push({ processed, total });
        },
      });

      // Assert
      expect(progressUpdates.length).toBeGreaterThan(0);
      // Last progress update should show all files processed
      const lastUpdate = progressUpdates.at(-1);
      expect(lastUpdate?.processed).toBe(150);
      expect(lastUpdate?.total).toBe(150);
    });

    it('should not add duplicate files', async () => {
      // Arrange
      let currentState = createMockState({
        selectedFilePaths: new Set(['folder1|@|file0.ts', 'folder1|@|file1.ts']),
        maxSelectionCount: 1000,
      });
      const get = vi.fn(() => currentState);
      const fileSelectionActions = createFileSelectionActions(mockSet, get);
      // Try to add files that already exist plus some new ones
      const pathsToAdd = ['file0.ts', 'file1.ts', 'file2.ts', 'file3.ts'];

      mockSet.mockImplementation((updater) => {
        if (typeof updater === 'function') {
          const result = updater(currentState);
          currentState = {
            ...currentState,
            selectedFilePaths: result.selectedFilePaths,
            selectionVersion: result.selectionVersion,
          };
        }
      });

      // Act
      const result = await fileSelectionActions.addMultipleSelectedFilesChunked(
        'folder1',
        pathsToAdd
      );

      // Assert
      expect(result.addedCount).toBe(2); // Only file2.ts and file3.ts should be added
      expect(currentState.selectedFilePaths.size).toBe(4);
    });

    it('should handle empty paths array', async () => {
      // Arrange
      const mockState = createMockState({
        selectedFilePaths: new Set(['folder1|@|existing.ts']),
        maxSelectionCount: 1000,
      });
      const get = vi.fn(() => mockState);
      const fileSelectionActions = createFileSelectionActions(mockSet, get);

      // Act
      const result = await fileSelectionActions.addMultipleSelectedFilesChunked('folder1', []);

      // Assert
      expect(result.addedCount).toBe(0);
      expect(result.cancelled).toBe(false);
      expect(result.limitReached).toBe(false);
    });

    it('should handle cancellation before any chunks are processed (already aborted)', async () => {
      // Arrange
      let currentState = createMockState({
        selectedFilePaths: new Set<string>(),
        maxSelectionCount: 1000,
      });
      const get = vi.fn(() => currentState);
      const fileSelectionActions = createFileSelectionActions(mockSet, get);
      const pathsToAdd = Array.from({ length: 200 }, (_, i) => `file${i}.ts`);

      const abortController = new AbortController();
      // Abort immediately before starting
      abortController.abort();

      mockSet.mockImplementation((updater) => {
        if (typeof updater === 'function') {
          const result = updater(currentState);
          currentState = {
            ...currentState,
            selectedFilePaths: result.selectedFilePaths,
            selectionVersion: result.selectionVersion,
          };
        }
      });

      // Act
      const result = await fileSelectionActions.addMultipleSelectedFilesChunked(
        'folder1',
        pathsToAdd,
        {
          chunkSize: 50,
          signal: abortController.signal,
        }
      );

      // Assert
      expect(result.cancelled).toBe(true);
      expect(result.addedCount).toBe(0);
    });

    it('should respect max selection count in small (synchronous) path', async () => {
      // Arrange - use small paths array (under chunk size) with limit already near max
      let currentState = createMockState({
        selectedFilePaths: new Set(['folder1|@|existing1.ts', 'folder1|@|existing2.ts']),
        maxSelectionCount: 3, // Only 1 more slot
      });
      const get = vi.fn(() => currentState);
      const fileSelectionActions = createFileSelectionActions(mockSet, get);
      const pathsToAdd = ['file1.ts', 'file2.ts', 'file3.ts']; // 3 files but only 1 slot

      mockSet.mockImplementation((updater) => {
        if (typeof updater === 'function') {
          const result = updater(currentState);
          currentState = {
            ...currentState,
            selectedFilePaths: result.selectedFilePaths,
            selectionVersion: result.selectionVersion,
          };
        }
      });

      // Act
      const result = await fileSelectionActions.addMultipleSelectedFilesChunked(
        'folder1',
        pathsToAdd
      );

      // Assert
      expect(result.addedCount).toBe(1); // Only 1 slot available
      expect(result.limitReached).toBe(true);
      expect(currentState.selectedFilePaths.size).toBe(3);
    });

    it('should not let duplicate input paths consume the optimistic large-selection budget', async () => {
      let currentState = createMockState({
        selectedFilePaths: new Set(['folder1|@|existing.ts']),
        maxSelectionCount: 2, // one remaining slot
      });
      const get = vi.fn(() => currentState);
      const fileSelectionActions = createFileSelectionActions(mockSet, get);

      mockSet.mockImplementation((updater) => {
        if (typeof updater === 'function') {
          const result = updater(currentState);
          currentState = {
            ...currentState,
            selectedFilePaths: result.selectedFilePaths,
            selectionVersion: result.selectionVersion,
          };
        }
      });

      const result = await fileSelectionActions.addMultipleSelectedFilesChunked(
        'folder1',
        ['existing.ts', 'new.ts', 'new.ts', 'ignored.ts'],
        { chunkSize: 2 }
      );

      expect(result.addedCount).toBe(1);
      expect(result.limitReached).toBe(true);
      expect(currentState.selectedFilePaths).toEqual(
        new Set(['folder1|@|existing.ts', 'folder1|@|new.ts'])
      );
    });

    it('should handle max limit reached during Phase 2 atomic update', async () => {
      // Arrange - large selection that hits limit during Phase 2 state update
      let currentState = createMockState({
        selectedFilePaths: new Set<string>(),
        maxSelectionCount: 10, // Tight budget
      });
      const get = vi.fn(() => currentState);
      const fileSelectionActions = createFileSelectionActions(mockSet, get);
      const pathsToAdd = Array.from({ length: 200 }, (_, i) => `file${i}.ts`);

      mockSet.mockImplementation((updater) => {
        if (typeof updater === 'function') {
          const result = updater(currentState);
          currentState = {
            ...currentState,
            selectedFilePaths: result.selectedFilePaths,
            selectionVersion: result.selectionVersion,
          };
        }
      });

      // Act
      const result = await fileSelectionActions.addMultipleSelectedFilesChunked(
        'folder1',
        pathsToAdd,
        { chunkSize: 50 }
      );

      // Assert
      expect(result.limitReached).toBe(true);
      expect(result.addedCount).toBe(10);
      expect(currentState.selectedFilePaths.size).toBe(10);
    });

    it('uses the updater state for explicit-path result deltas even if get() changes after set()', async () => {
      let currentState = createMockState({
        selectedFilePaths: new Set<string>(),
        maxSelectionCount: 5,
      });
      const get = vi.fn(() => currentState);
      const fileSelectionActions = createFileSelectionActions(mockSet, get);
      let authoritativeSelectedCount = 0;

      mockSet.mockImplementation((updater) => {
        if (typeof updater === 'function') {
          const result = updater(currentState);
          currentState = {
            ...currentState,
            selectedFilePaths: result.selectedFilePaths,
            selectionVersion: result.selectionVersion,
          };
          authoritativeSelectedCount = currentState.selectedFilePaths.size;
          currentState = {
            ...currentState,
            selectedFilePaths: new Set([
              ...currentState.selectedFilePaths,
              'folder1|@|concurrent.ts',
            ]),
          };
        }
      });

      const result = await fileSelectionActions.addMultipleSelectedFilesChunked('folder1', [
        'file1.ts',
        'file2.ts',
      ]);

      expect(result).toEqual({
        addedCount: 2,
        cancelled: false,
        limitReached: false,
      });
      expect(authoritativeSelectedCount).toBe(2);
    });

    it('should call onProgress for small (synchronous) selections', async () => {
      // Arrange
      const mockState = createMockState({
        selectedFilePaths: new Set<string>(),
        maxSelectionCount: 1000,
      });
      const get = vi.fn().mockReturnValue(mockState);
      const fileSelectionActions = createFileSelectionActions(mockSet, get);
      const pathsToAdd = ['file1.ts', 'file2.ts'];
      const onProgress = vi.fn();

      mockSet.mockImplementation((updater) => {
        if (typeof updater === 'function') {
          const result = updater(mockState);
          mockState.selectedFilePaths = result.selectedFilePaths;
          mockState.selectionVersion = result.selectionVersion;
        }
      });

      // Act
      await fileSelectionActions.addMultipleSelectedFilesChunked('folder1', pathsToAdd, {
        onProgress,
      });

      // Assert - onProgress should be called with (paths.length, paths.length) for small selections
      expect(onProgress).toHaveBeenCalledWith(2, 2);
    });

    it('should handle cancellation after scheduleChunk yield (post-yield abort)', async () => {
      // This tests the abort check at line 122 (after await scheduleChunk())
      let currentState = createMockState({
        selectedFilePaths: new Set<string>(),
        maxSelectionCount: 1000,
      });
      const get = vi.fn(() => currentState);
      const fileSelectionActions = createFileSelectionActions(mockSet, get);
      const pathsToAdd = Array.from({ length: 200 }, (_, i) => `file${i}.ts`);

      const abortController = new AbortController();
      let chunkCount = 0;

      mockSet.mockImplementation((updater) => {
        if (typeof updater === 'function') {
          const result = updater(currentState);
          currentState = {
            ...currentState,
            selectedFilePaths: result.selectedFilePaths,
            selectionVersion: result.selectionVersion,
          };
        }
      });

      // Act — abort after the first chunk completes and yields (between scheduleChunk and processing)
      const result = await fileSelectionActions.addMultipleSelectedFilesChunked(
        'folder1',
        pathsToAdd,
        {
          chunkSize: 50,
          signal: abortController.signal,
          onProgress: () => {
            chunkCount++;
            // Abort after the first chunk's onProgress fires
            // The abort will be detected AFTER the next scheduleChunk() call
            if (chunkCount === 1) {
              abortController.abort();
            }
          },
        }
      );

      // Assert
      expect(result.cancelled).toBe(true);
      // Should have partial results from the first chunk
      expect(result.addedCount).toBeGreaterThan(0);
      expect(result.addedCount).toBeLessThan(200);
    });

    it('should handle Phase 2 limit reached when state mutated concurrently', async () => {
      // This tests lines 359-361: limit reached during Phase 2 atomic update
      // We simulate a concurrent mutation by changing maxSelectionCount between phases
      let currentState = createMockState({
        selectedFilePaths: new Set<string>(),
        maxSelectionCount: 1000, // Phase 1 sees plenty of budget
      });
      const get = vi.fn(() => currentState);
      const fileSelectionActions = createFileSelectionActions(mockSet, get);
      const pathsToAdd = Array.from({ length: 200 }, (_, i) => `file${i}.ts`);

      let setCallCount = 0;
      mockSet.mockImplementation((updater) => {
        if (typeof updater === 'function') {
          setCallCount++;
          // Before Phase 2 set() call, simulate concurrent state mutation
          // that fills up the selection to near the limit
          if (setCallCount === 1) {
            // Inject existing files AND reduce the maxSelectionCount
            // so the limit is hit during Phase 2
            currentState = {
              ...currentState,
              selectedFilePaths: new Set(
                Array.from({ length: 195 }, (_, i) => `folder1|@|existing${i}.ts`)
              ),
              maxSelectionCount: 200, // Only 5 slots remain
            };
          }
          const result = updater(currentState);
          currentState = {
            ...currentState,
            selectedFilePaths: result.selectedFilePaths,
            selectionVersion: result.selectionVersion,
          };
        }
      });

      // Act
      const result = await fileSelectionActions.addMultipleSelectedFilesChunked(
        'folder1',
        pathsToAdd,
        { chunkSize: 50 }
      );

      // Assert - limit should be reached during Phase 2
      expect(result.limitReached).toBe(true);
      // Only 5 new files should have been added (200 - 195 existing)
      expect(result.addedCount).toBe(5);
    });

    it('should handle duplicate keys in chunked Phase 2 (already selected)', async () => {
      // Arrange - some files already selected, large enough for chunked path
      let currentState = createMockState({
        selectedFilePaths: new Set(Array.from({ length: 50 }, (_, i) => `folder1|@|file${i}.ts`)),
        maxSelectionCount: 1000,
      });
      const get = vi.fn(() => currentState);
      const fileSelectionActions = createFileSelectionActions(mockSet, get);
      // Include both already-selected and new files
      const pathsToAdd = Array.from({ length: 200 }, (_, i) => `file${i}.ts`);

      mockSet.mockImplementation((updater) => {
        if (typeof updater === 'function') {
          const result = updater(currentState);
          currentState = {
            ...currentState,
            selectedFilePaths: result.selectedFilePaths,
            selectionVersion: result.selectionVersion,
          };
        }
      });

      // Act
      const result = await fileSelectionActions.addMultipleSelectedFilesChunked(
        'folder1',
        pathsToAdd,
        { chunkSize: 50 }
      );

      // Assert
      expect(result.cancelled).toBe(false);
      // Only 150 new files should be added (200 total - 50 already selected)
      expect(result.addedCount).toBe(150);
      expect(currentState.selectedFilePaths.size).toBe(200);
    });
  });
});
