import type { FileExplorerState, SerializedState } from '@brainstrike/types';
import { DEFAULT_STATE } from '@brainstrike/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock console spies for all tests in this file
const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
let originalNodeEnv: string | undefined;

// Helper to dynamically import and get persist options
const getFreshPersistOptions = async () => {
  const mod = await import('../persistence/file-explorer-persistence');
  return mod.createPersistOptions();
};

describe('file-explorer-persistence', () => {
  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
    vi.clearAllMocks(); // Clear mocks for console spies
    vi.resetModules(); // Reset modules to ensure isDev is re-evaluated based on NODE_ENV
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  describe('createPersistOptions', () => {
    it('should create persist options with the correct configuration', async () => {
      process.env.NODE_ENV = 'production'; // Arbitrary for this test
      const persistOptions = await getFreshPersistOptions();
      expect(persistOptions.name).toBe('file-explorer-storage');
      expect(persistOptions.version).toBe(3);
      expect(typeof persistOptions.partialize).toBe('function');
      expect(typeof persistOptions.onRehydrateStorage).toBe('function');
    });
  });

  describe('partialize (isDev = true)', () => {
    let partializeFn: NonNullable<Awaited<ReturnType<typeof getFreshPersistOptions>>['partialize']>;

    beforeEach(async () => {
      process.env.NODE_ENV = 'development';
      vi.resetModules();
      const persistOptions = await getFreshPersistOptions();
      if (!persistOptions.partialize) throw new Error('Partialize function not found');
      partializeFn = persistOptions.partialize;
    });

    it('should correctly serialize state and log', () => {
      const mockState: Partial<FileExplorerState> = {
        currentFolderId: 'folder-123',
        folderStates: {
          'folder-123': {
            selectedFilePaths: new Set(['file1', 'file2']),
            expandedDirectoryPaths: new Set(['dir1', 'dir2']),
            lastAccessed: 1234567890,
            lastActiveTab: 'files',
            includeFilters: ['*.ts', '*.tsx'],
            excludeFilters: ['node_modules'],
            useRegex: true,
            includeProjectTree: true,
            folderSummaryThreshold: 5,
            maxSelectionCount: 100,
          },
        },
        selectedFilePaths: new Set(['file1', 'file2']),
        expandedDirectoryPaths: new Set(['dir1', 'dir2']),
        includeFilters: ['*.ts', '*.tsx'],
        excludeFilters: ['node_modules'],
        useRegex: true,
        includeProjectTree: true,
        folderSummaryThreshold: 5,
        maxSelectionCount: 100,
        lastActiveTab: 'files',
      };
      const result = partializeFn(mockState as FileExplorerState);
      expect(result.currentFolderId).toBe('folder-123');
      expect(result.lastActiveTab).toBe('files');
      expect(consoleLogSpy).toHaveBeenCalledWith('Serializing state:', expect.any(Object));
    });
  });

  describe('onRehydrateStorage (isDev = true)', () => {
    let onRehydrateStorageSetup: NonNullable<
      Awaited<ReturnType<typeof getFreshPersistOptions>>['onRehydrateStorage']
    >;

    beforeEach(async () => {
      process.env.NODE_ENV = 'development';
      vi.resetModules();
      const persistOptions = await getFreshPersistOptions();
      if (!persistOptions.onRehydrateStorage)
        throw new Error('onRehydrateStorage function not found');
      onRehydrateStorageSetup = persistOptions.onRehydrateStorage;
    });

    it('should return a function that itself returns the rehydration logic function', () => {
      if (!onRehydrateStorageSetup)
        throw new Error('onRehydrateStorage setup function is undefined');
      expect(typeof onRehydrateStorageSetup).toBe('function');
      const rehydrateLogicFn = onRehydrateStorageSetup(DEFAULT_STATE as FileExplorerState);
      expect(typeof rehydrateLogicFn).toBe('function');
    });

    it('No Persisted State: should return default state and log', () => {
      if (!onRehydrateStorageSetup) throw new Error('onRehydrateStorage setup is undefined');
      const rehydrate = onRehydrateStorageSetup(DEFAULT_STATE as FileExplorerState) as any;
      const result: FileExplorerState | null = rehydrate(null);
      expect(result).toEqual({
        currentFolderId: null,
        folderStates: {},
        ...DEFAULT_STATE,
        lastActiveTab: DEFAULT_STATE.lastActiveTab ?? 'files',
      });
      expect(consoleLogSpy).toHaveBeenCalledWith(
        'Rehydrating storage, full persisted state:',
        null
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        'No persisted state found, returning default state'
      );
    });

    it('Persisted State with No Current Folder ID: should return modified state and log', () => {
      if (!onRehydrateStorageSetup) throw new Error('onRehydrateStorage setup is undefined');
      const rehydrate = onRehydrateStorageSetup(DEFAULT_STATE as FileExplorerState) as any;
      const persistedStateWithNoFolder: Partial<SerializedState> = {
        currentFolderId: null,
        includeFilters: ['persisted.ts'],
        maxSelectionCount: 200,
        lastActiveTab: 'preview',
      };
      const result = rehydrate(persistedStateWithNoFolder as SerializedState);
      expect(result).toEqual({
        currentFolderId: null,
        folderStates: {},
        selectedFilePaths: new Set<string>(),
        expandedDirectoryPaths: new Set<string>(),
        includeFilters: ['persisted.ts'],
        excludeFilters: DEFAULT_STATE.excludeFilters,
        useRegex: DEFAULT_STATE.useRegex,
        includeProjectTree: DEFAULT_STATE.includeProjectTree,
        folderSummaryThreshold: DEFAULT_STATE.folderSummaryThreshold,
        maxSelectionCount: 200,
        lastActiveTab: 'preview',
      });
      expect(consoleLogSpy).toHaveBeenCalledWith(
        'Rehydrating storage, full persisted state:',
        persistedStateWithNoFolder
      );
      expect(consoleLogSpy).toHaveBeenCalledWith('No current folder ID, clearing selected files');
    });

    it('Error During Rehydration: should return default state and log error', () => {
      if (!onRehydrateStorageSetup) throw new Error('onRehydrateStorage setup is undefined');
      const rehydrate = onRehydrateStorageSetup(DEFAULT_STATE as FileExplorerState) as any;

      // Mock Object.fromEntries to throw an error for this specific test case
      const fromEntriesSpy = vi.spyOn(Object, 'fromEntries').mockImplementationOnce(() => {
        throw new TypeError('Forced error for testing catch block');
      });

      const malformedPersistedState = {
        currentFolderId: 'folder-123',
        // This structure is designed so that Object.entries(persistedState.folderStates ?? {}) is called,
        // which then calls our mocked Object.fromEntries.
        folderStates: { 'error-key': 'trigger-error-mock' },
      } as unknown as SerializedState;
      const result: FileExplorerState | null = rehydrate(malformedPersistedState);
      expect(result).toEqual({
        currentFolderId: null,
        folderStates: {},
        ...DEFAULT_STATE,
        lastActiveTab: DEFAULT_STATE.lastActiveTab ?? 'files',
      });
      expect(consoleLogSpy).toHaveBeenCalledWith(
        'Rehydrating storage, full persisted state:',
        malformedPersistedState
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Error rehydrating file explorer state:',
        expect.any(TypeError) // The error thrown by the mock
      );
      fromEntriesSpy.mockRestore(); // Restore original implementation
    });
  });

  describe('onRehydrateStorage (isDev = false)', () => {
    let onRehydrateStorageSetup: NonNullable<
      Awaited<ReturnType<typeof getFreshPersistOptions>>['onRehydrateStorage']
    >;

    beforeEach(async () => {
      process.env.NODE_ENV = 'production';
      vi.resetModules();
      const persistOptions = await getFreshPersistOptions();
      if (!persistOptions.onRehydrateStorage)
        throw new Error('onRehydrateStorage function not found');
      onRehydrateStorageSetup = persistOptions.onRehydrateStorage;
    });

    it('Successful Rehydration (Happy Path): should correctly rehydrate state and not log dev messages', () => {
      if (!onRehydrateStorageSetup) throw new Error('onRehydrateStorage setup is undefined');
      const rehydrate = onRehydrateStorageSetup(DEFAULT_STATE as FileExplorerState) as any;
      const persistedState: SerializedState = {
        currentFolderId: 'folder-abc',
        folderStates: {
          'folder-abc': {
            selectedFilePaths: ['fileA.ts', 'fileB.ts'],
            expandedDirectoryPaths: ['src/components'],
            lastAccessed: 123,
            lastActiveTab: 'files',
            includeFilters: ['*.js'],
            excludeFilters: ['dist'],
            useRegex: false,
            includeProjectTree: false,
            folderSummaryThreshold: 3,
            maxSelectionCount: 50,
          },
        },
        selectedFilePaths: ['fileGlobal.ts'],
        expandedDirectoryPaths: ['globalDir'],
        includeFilters: ['*.ts'],
        excludeFilters: ['node_modules'],
        useRegex: true,
        includeProjectTree: true,
        folderSummaryThreshold: 10,
        maxSelectionCount: 150,
        lastActiveTab: 'settings',
      };
      const result: FileExplorerState | null = rehydrate(persistedState);
      expect(result?.currentFolderId).toBe('folder-abc');
      expect(result?.selectedFilePaths).toEqual(new Set(['fileGlobal.ts']));
      expect(result?.expandedDirectoryPaths).toEqual(new Set(['globalDir']));
      expect(result?.folderStates['folder-abc']?.selectedFilePaths).toEqual(
        new Set(['fileA.ts', 'fileB.ts'])
      );
      expect(result?.lastActiveTab).toBe('settings');
      expect(consoleLogSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('Successful Rehydration with missing lastActiveTab: should default to "files" and not log', () => {
      if (!onRehydrateStorageSetup) throw new Error('onRehydrateStorage setup is undefined');
      const rehydrate = onRehydrateStorageSetup(DEFAULT_STATE as FileExplorerState) as any;
      const persistedState: Partial<SerializedState> = {
        currentFolderId: 'folder-xyz',
        selectedFilePaths: [],
        expandedDirectoryPaths: [],
        folderStates: {},
        includeFilters: [],
        excludeFilters: [],
        useRegex: false,
        includeProjectTree: true,
        folderSummaryThreshold: 5,
        maxSelectionCount: 100,
      };
      const result: FileExplorerState | null = rehydrate(persistedState as SerializedState);
      expect(result?.lastActiveTab).toBe('files');
      expect(consoleLogSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });
  });
});
