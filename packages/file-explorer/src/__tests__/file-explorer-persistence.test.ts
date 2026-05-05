import type { FileExplorerState, FolderState, SerializedState } from '@brainstrike/types';
import { createEmptySelectionModel, DEFAULT_STATE } from '@brainstrike/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FILE_EXPLORER_STORAGE_VERSION } from '../persistence/persistence-constants';

// Mock console spies for all tests in this file
const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
// const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); // Removed unused spy

// Mock storage adapter for tests
const mockStorageAdapter = {
  async getItem(_key: string) {
    return null;
  },
  async setItem(_key: string, _value: string) {
    // no-op
  },
  async removeItem(_key: string) {
    // no-op
  },
  async clear() {
    // no-op
  },
  async getAllKeys() {
    return [];
  },
};

// Helper to dynamically import and get persist options
const getFreshPersistOptions = async () => {
  const mod = await import('../persistence/file-explorer-persistence');
  return mod.createPersistOptions(mockStorageAdapter);
};

const testDefaultFolderState: FolderState = {
  selectedFilePaths: new Set<string>(),
  expandedDirectoryPaths: new Set<string>(),
  includeFilters: [...DEFAULT_STATE.includeFilters], // Copy from global defaults
  excludeFilters: [...DEFAULT_STATE.excludeFilters], // Copy from global defaults
  useRegex: DEFAULT_STATE.useRegex,
  includeProjectTree: DEFAULT_STATE.includeProjectTree,
  tokenBudget: DEFAULT_STATE.tokenBudget,
  folderSummaryThreshold: DEFAULT_STATE.folderSummaryThreshold,
  maxSelectionCount: DEFAULT_STATE.maxSelectionCount,
  lastActiveTab: DEFAULT_STATE.lastActiveTab,
  lastAccessed: 0, // Default lastAccessed
  selectionModel: createEmptySelectionModel(),
  viewFilterPresetId: DEFAULT_STATE.viewFilterPresetId,
};

describe('file-explorer-persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks(); // Clear mocks for console spies
    vi.resetModules(); // Reset modules to ensure isDev is re-evaluated based on NODE_ENV
  });

  afterEach(() => {
    vi.unstubAllEnvs(); // Clean up environment variable stubs
  });

  describe('createPersistOptions', () => {
    it('should create persist options with the correct configuration', async () => {
      const persistOptions = await getFreshPersistOptions();

      expect(persistOptions.name).toBe('file-explorer-storage-v4');
      expect(persistOptions.version).toBe(FILE_EXPLORER_STORAGE_VERSION);
      expect(persistOptions.storage).toBeDefined();
      expect(persistOptions.partialize).toBeDefined();
      expect(persistOptions.migrate).toBeDefined();
      expect(persistOptions.merge).toBeDefined();
    });

    it('persists setItem calls immediately to prevent race conditions with page reloads', async () => {
      const setItemSpy = vi.fn();
      const adapter = { ...mockStorageAdapter, setItem: setItemSpy };
      const mod = await import('../persistence/file-explorer-persistence');
      const persistOptions = mod.createPersistOptions(adapter);
      vi.useFakeTimers();

      const storage = persistOptions.storage as NonNullable<(typeof persistOptions)['storage']>;
      const base: SerializedState = {
        currentFolderId: null,
        folderStates: {},
        folderAccessOrder: [],
        selectedFilePaths: [],
        expandedDirectoryPaths: [],
        includeFilters: [],
        excludeFilters: [],
        useRegex: false,
        includeProjectTree: false,
        folderSummaryThreshold: 0,
        maxSelectionCount: 0,
        lastActiveTab: 'files',
      };

      // First setItem call - should persist immediately
      await storage.setItem('foo', { state: base, version: 1 });
      expect(setItemSpy).toHaveBeenCalledTimes(1);

      // Second setItem call - should also persist immediately
      await storage.setItem('foo', {
        state: { ...base, lastActiveTab: 'preview' },
        version: 1,
      });
      expect(setItemSpy).toHaveBeenCalledTimes(2);

      // Verify the calls were made with correct arguments
      expect(setItemSpy.mock.calls[0]?.[0]).toBe('foo');
      expect(setItemSpy.mock.calls[1]?.[0]).toBe('foo');

      const firstCall = JSON.parse(setItemSpy.mock.calls[0]?.[1] as string);
      const secondCall = JSON.parse(setItemSpy.mock.calls[1]?.[1] as string);

      expect(firstCall).toEqual({ state: base, version: 1 });
      expect(secondCall).toEqual({ state: { ...base, lastActiveTab: 'preview' }, version: 1 });

      vi.useRealTimers();
    });
  });

  describe('partialize', () => {
    let partializeFn: NonNullable<Awaited<ReturnType<typeof getFreshPersistOptions>>['partialize']>;

    beforeEach(async () => {
      const persistOptions = await getFreshPersistOptions();
      if (!persistOptions.partialize) {
        throw new Error('Partialize function not found');
      }
      partializeFn = persistOptions.partialize;
    });

    it('should correctly serialize state, converting Sets to Arrays', () => {
      const mockState: FileExplorerState = {
        ...(DEFAULT_STATE as FileExplorerState),
        currentFolderId: 'folder-123',
        folderStates: {
          'folder-123': {
            ...testDefaultFolderState, // Use defined default folder state
            // Note: These will be overwritten by top-level state during serialization
            // because folder-123 is the current folder
            selectedFilePaths: new Set(['file1', 'file2']),
            expandedDirectoryPaths: new Set(['dir1', 'dir2']),
            lastAccessed: 1_234_567_890, // Override specific test values
            lastActiveTab: 'files',
          },
        },
        selectedFilePaths: new Set(['file-global', 'file-another']),
        expandedDirectoryPaths: new Set(['dir-global', 'dir-another']),
        lastActiveTab: 'settings',
      };
      const result = partializeFn(mockState);
      expect(result.currentFolderId).toBe('folder-123');
      expect(result.lastActiveTab).toBe('settings');
      expect(Array.isArray(result.selectedFilePaths)).toBe(true);
      expect(result.selectedFilePaths).toEqual(
        expect.arrayContaining(['file-global', 'file-another'])
      );
      expect(Array.isArray(result.expandedDirectoryPaths)).toBe(true);
      expect(result.expandedDirectoryPaths).toEqual(
        expect.arrayContaining(['dir-global', 'dir-another'])
      );
      // During serialization, current folder's state is synced from top-level state
      // to ensure selections are preserved when app closes without switching folders
      expect(Array.isArray(result.folderStates['folder-123']?.selectedFilePaths)).toBe(true);
      expect(result.folderStates['folder-123']?.selectedFilePaths).toEqual(
        expect.arrayContaining(['file-global', 'file-another'])
      );
    });

    it('should omit volatile fields like fileContents from the serialized output', () => {
      const mockState: FileExplorerState = {
        ...(DEFAULT_STATE as FileExplorerState),
        currentFolderId: 'folder-volatile',
        fileContents: { 'some.ts': 'content' },
        folderStates: {},
      };

      const result = partializeFn(mockState);

      expect('fileContents' in (result as unknown as Record<string, unknown>)).toBe(false);
    });
  });

  describe('migrate', () => {
    let migrateFn: NonNullable<Awaited<ReturnType<typeof getFreshPersistOptions>>['migrate']>;

    beforeEach(async () => {
      const persistOptions = await getFreshPersistOptions();
      if (!persistOptions.migrate) {
        throw new Error('Migrate function not found');
      }
      migrateFn = persistOptions.migrate;
    });

    it('should replace nullish raw persisted state with a safe empty serialized state', () => {
      expect(migrateFn(null, 1)).toMatchObject({
        currentFolderId: null,
        folderStates: {},
        selectedFilePaths: [],
        expandedDirectoryPaths: [],
        quickFilter: '',
      });
      expect(migrateFn(undefined, 1)).toMatchObject({
        currentFolderId: null,
        folderStates: {},
        selectedFilePaths: [],
        expandedDirectoryPaths: [],
        quickFilter: '',
      });
    });

    it('should unwrap state from { state, version } wrapper', () => {
      const actualState: SerializedState = {
        currentFolderId: 'folder-abc',
        selectedFilePaths: ['file.ts'],
        folderStates: {},
        folderAccessOrder: [],
        expandedDirectoryPaths: [],
        includeFilters: [],
        excludeFilters: [],
        useRegex: false,
        includeProjectTree: false,
        folderSummaryThreshold: 0,
        maxSelectionCount: 0,
        lastActiveTab: 'files',
        selectionModel: {
          mode: 'explicit',
          explicitPaths: ['file.ts'],
          ruleSetJson: null,
          materializedPaths: null,
          materializedAt: null,
          queryDescriptor: null,
        },
      };
      const wrappedState = { state: actualState, version: FILE_EXPLORER_STORAGE_VERSION };
      const result = migrateFn(wrappedState, FILE_EXPLORER_STORAGE_VERSION);
      expect(result).toEqual(actualState);
    });

    it('should discard persisted snapshots from older storage versions', () => {
      const oldSnapshot: SerializedState = {
        currentFolderId: 'stale-folder',
        selectedFilePaths: ['stale-folder|@|file.ts'],
        folderStates: {},
        folderAccessOrder: ['stale-folder'],
        expandedDirectoryPaths: ['src'],
        includeFilters: [],
        excludeFilters: [],
        useRegex: false,
        includeProjectTree: false,
        folderSummaryThreshold: 0,
        maxSelectionCount: 2000,
        lastActiveTab: 'files',
      };

      const result = migrateFn({ state: oldSnapshot, version: 2 }, 2);

      expect(result).toMatchObject({
        currentFolderId: null,
        folderStates: {},
        selectedFilePaths: [],
        expandedDirectoryPaths: [],
        quickFilter: '',
      });
    });

    it('should return state as is if not wrapped', () => {
      const actualState: SerializedState = {
        currentFolderId: 'folder-xyz',
        selectedFilePaths: ['file.js'],
        folderStates: {},
        folderAccessOrder: [],
        expandedDirectoryPaths: [],
        includeFilters: [],
        excludeFilters: [],
        useRegex: false,
        includeProjectTree: false,
        folderSummaryThreshold: 0,
        maxSelectionCount: 0,
        lastActiveTab: 'files',
        selectionModel: {
          mode: 'explicit',
          explicitPaths: ['file.js'],
          ruleSetJson: null,
          materializedPaths: null,
          materializedAt: null,
          queryDescriptor: null,
        },
      };
      const result = migrateFn(actualState, FILE_EXPLORER_STORAGE_VERSION);
      expect(result).toEqual(actualState);
    });

    it('should discard legacy persisted state versions instead of backfilling them', () => {
      const legacyState = {
        currentFolderId: 'folder-abc',
        selectedFilePaths: ['folder-abc|@|file.ts'],
        folderStates: {
          'folder-abc': {
            selectedFilePaths: ['folder-abc|@|file.ts'],
            expandedDirectoryPaths: [],
            includeFilters: [],
            excludeFilters: [],
            useRegex: false,
            includeProjectTree: false,
            tokenBudget: 100,
            folderSummaryThreshold: 10,
            maxSelectionCount: 50,
            lastActiveTab: 'files',
            lastAccessed: 1,
            viewFilterPresetId: null,
          },
        },
        folderAccessOrder: ['folder-abc'],
        expandedDirectoryPaths: [],
        includeFilters: [],
        excludeFilters: [],
        useRegex: false,
        includeProjectTree: false,
        folderSummaryThreshold: 10,
        maxSelectionCount: 50,
        lastActiveTab: 'files',
      } as unknown as SerializedState;

      const result = migrateFn(legacyState, 1);

      expect(result).toMatchObject({
        currentFolderId: null,
        folderStates: {},
        selectedFilePaths: [],
        expandedDirectoryPaths: [],
        quickFilter: '',
      });
    });

    it('should discard wrappers when state is undefined', () => {
      const wrapper = { state: undefined, version: 1 } as unknown as SerializedState;
      const result = migrateFn(wrapper, 1);
      expect(result).toMatchObject({
        currentFolderId: null,
        folderStates: {},
        selectedFilePaths: [],
        expandedDirectoryPaths: [],
        quickFilter: '',
      });
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('should replace malformed objects with a safe empty serialized state', () => {
      const malformed = { version: 1 } as unknown as SerializedState;
      const result = migrateFn(malformed as unknown as SerializedState, 1);
      expect(result).toMatchObject({
        currentFolderId: null,
        folderStates: {},
        selectedFilePaths: [],
        expandedDirectoryPaths: [],
        quickFilter: '',
      });
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });
  });

  describe('merge', () => {
    let mergeFn: NonNullable<Awaited<ReturnType<typeof getFreshPersistOptions>>['merge']>;
    let partializeFn: NonNullable<Awaited<ReturnType<typeof getFreshPersistOptions>>['partialize']>;
    const initialCurrentState: FileExplorerState = {
      ...(DEFAULT_STATE as FileExplorerState),
      currentFolderId: null,
      selectedFilePaths: new Set(),
      expandedDirectoryPaths: new Set(),
      folderStates: {
        'initial-folder': {
          ...testDefaultFolderState, // Use defined default folder state
          selectedFilePaths: new Set(['initial-sel.txt']),
          expandedDirectoryPaths: new Set(['initial-exp-dir']),
          lastActiveTab: 'preview',
        },
      },
    };

    beforeEach(async () => {
      const persistOptions = await getFreshPersistOptions();
      if (!(persistOptions.merge && persistOptions.partialize)) {
        throw new Error('Merge or partialize function not found');
      }
      mergeFn = persistOptions.merge;
      partializeFn = persistOptions.partialize;
    });

    it('should return current initial state if persisted state is undefined', () => {
      const result = mergeFn(undefined, initialCurrentState);
      expect(result).toEqual(initialCurrentState);
    });

    it('should merge persisted SerializedState into current FileExplorerState, converting arrays to Sets', () => {
      const persisted: SerializedState = {
        currentFolderId: 'persisted-folder',
        selectedFilePaths: ['persisted-global.txt'],
        expandedDirectoryPaths: ['persisted-global-dir'],
        folderAccessOrder: ['persisted-folder', 'another-persisted'],
        folderStates: {
          'persisted-folder': {
            selectedFilePaths: ['persisted-sel.txt'],
            expandedDirectoryPaths: ['persisted-exp-dir'],
            lastAccessed: Date.now(),
            lastActiveTab: 'files',
            includeFilters: ['*.json'],
            excludeFilters: [],
            useRegex: false,
            includeProjectTree: true,
            folderSummaryThreshold: 10,
            maxSelectionCount: 10,
          },
          'another-persisted': {
            selectedFilePaths: ['another.txt'],
            expandedDirectoryPaths: [],
            lastAccessed: Date.now(),
            lastActiveTab: 'files',
            includeFilters: [],
            excludeFilters: [],
            useRegex: false,
            includeProjectTree: false,
            folderSummaryThreshold: 0,
            maxSelectionCount: 0,
          },
        },
        lastActiveTab: 'preview',
        includeFilters: ['*.md'],
        excludeFilters: ['backups'],
        useRegex: true,
        includeProjectTree: true,
        folderSummaryThreshold: 20,
        maxSelectionCount: 20,
      };

      const result = mergeFn(persisted, initialCurrentState);

      expect(result.currentFolderId).toBe('persisted-folder');
      expect(result.lastActiveTab).toBe('preview');
      expect(result.includeFilters).toEqual(['*.md']);
      expect(result.selectedFilePaths).toBeInstanceOf(Set);
      expect(result.selectedFilePaths.has('persisted-global.txt')).toBe(true);
      expect(result.expandedDirectoryPaths).toBeInstanceOf(Set);
      expect(result.expandedDirectoryPaths.has('persisted-global-dir')).toBe(true);

      expect(result.folderStates['persisted-folder']).toBeDefined();
      expect(result.folderStates['persisted-folder']?.selectedFilePaths).toBeInstanceOf(Set);
      expect(
        result.folderStates['persisted-folder']?.selectedFilePaths.has('persisted-sel.txt')
      ).toBe(true);
      expect(result.folderStates['persisted-folder']?.includeFilters).toEqual(['*.json']);

      expect(result.folderStates['another-persisted']).toBeDefined();
      expect(result.folderStates['another-persisted']?.selectedFilePaths.has('another.txt')).toBe(
        true
      );

      expect(result.folderStates['initial-folder']).toBeDefined();
      expect(result.folderStates['initial-folder']?.selectedFilePaths.has('initial-sel.txt')).toBe(
        true
      );
      expect(result.folderStates['initial-folder']?.lastActiveTab).toBe('preview');
    });

    it('should round-trip state via partialize and merge', () => {
      // Note: During serialization, the current folder's state is synced from top-level state.
      // This ensures that when the app closes without switching folders, the current folder's
      // selections are preserved. The top-level state is always the "working copy".
      const state: FileExplorerState = {
        ...(DEFAULT_STATE as FileExplorerState),
        currentFolderId: 'rt-folder',
        selectedFilePaths: new Set(['s1', 's2']),
        expandedDirectoryPaths: new Set(['d1']),
        folderStates: {
          'rt-folder': {
            ...testDefaultFolderState,
            // These will be overwritten by top-level state during serialization
            selectedFilePaths: new Set(['fs1']),
            expandedDirectoryPaths: new Set(['fd1']),
            lastActiveTab: 'files',
            lastAccessed: 123,
          },
        },
      };

      const serialized = partializeFn(state);
      const merged = mergeFn(serialized, initialCurrentState);

      expect(merged.currentFolderId).toBe('rt-folder');
      expect(Array.from(merged.selectedFilePaths)).toEqual(['s1', 's2']);
      expect(Array.from(merged.expandedDirectoryPaths)).toEqual(['d1']);
      expect(merged.folderStates['rt-folder']).toBeDefined();
      // After serialization, the current folder's state is synced from top-level
      expect(Array.from(merged.folderStates['rt-folder']?.selectedFilePaths ?? new Set())).toEqual([
        's1',
        's2',
      ]);
      expect(
        Array.from(merged.folderStates['rt-folder']?.expandedDirectoryPaths ?? new Set())
      ).toEqual(['d1']);
    });

    it('should retain folder states present only in the current state', () => {
      const currentWithExtra: FileExplorerState = {
        ...initialCurrentState,
        folderStates: {
          ...initialCurrentState.folderStates,
          'extra-folder': {
            ...testDefaultFolderState,
            selectedFilePaths: new Set(['extra.txt']),
            expandedDirectoryPaths: new Set(['extra-dir']),
            lastActiveTab: 'files',
          },
        },
      };

      const persisted: SerializedState = {
        currentFolderId: null,
        folderStates: {},
        folderAccessOrder: [],
        selectedFilePaths: [],
        expandedDirectoryPaths: [],
        includeFilters: [],
        excludeFilters: [],
        useRegex: false,
        includeProjectTree: false,
        folderSummaryThreshold: 0,
        maxSelectionCount: 0,
        lastActiveTab: 'files',
      };

      const result = mergeFn(persisted, currentWithExtra);
      expect(result.folderStates['extra-folder']).toBeDefined();
      expect(
        Array.from(result.folderStates['extra-folder']?.selectedFilePaths ?? new Set())
      ).toEqual(['extra.txt']);
      expect(result.folderStates['initial-folder']).toBeDefined();
    });

    it('should round-trip state via partialize and merge with multiple folders and empty sets', () => {
      const state: FileExplorerState = {
        ...(DEFAULT_STATE as FileExplorerState),
        currentFolderId: 'one',
        selectedFilePaths: new Set(),
        expandedDirectoryPaths: new Set(),
        folderStates: {
          one: {
            ...testDefaultFolderState,
            selectedFilePaths: new Set(),
            expandedDirectoryPaths: new Set(),
            lastActiveTab: 'files',
            lastAccessed: 1,
          },
          two: {
            ...testDefaultFolderState,
            selectedFilePaths: new Set(),
            expandedDirectoryPaths: new Set(),
            lastActiveTab: 'preview',
            lastAccessed: 2,
          },
        },
      };

      const serialized = partializeFn(state);
      const merged = mergeFn(serialized, initialCurrentState);

      expect(Object.keys(merged.folderStates)).toEqual(expect.arrayContaining(['one', 'two']));
      const folderOneKey = 'one';
      const folderTwoKey = 'two';
      expect(Array.from(merged.folderStates[folderOneKey]?.selectedFilePaths ?? new Set())).toEqual(
        []
      );
      expect(
        Array.from(merged.folderStates[folderTwoKey]?.expandedDirectoryPaths ?? new Set())
      ).toEqual([]);
    });

    it('should handle unknown folder states from persisted data', () => {
      const persisted: SerializedState = {
        currentFolderId: null,
        folderStates: {
          unknown: {
            selectedFilePaths: ['u.txt'],
            expandedDirectoryPaths: [],
            includeFilters: [],
            excludeFilters: [],
            useRegex: false,
            includeProjectTree: false,
            folderSummaryThreshold: 0,
            maxSelectionCount: 0,
            lastActiveTab: 'files',
            lastAccessed: 1,
            // extra property not in FolderState
            extra: 'val' as unknown as never,
          },
        },
        folderAccessOrder: [],
        selectedFilePaths: [],
        expandedDirectoryPaths: [],
        includeFilters: [],
        excludeFilters: [],
        useRegex: false,
        includeProjectTree: false,
        folderSummaryThreshold: 0,
        maxSelectionCount: 0,
        lastActiveTab: 'files',
      } as SerializedState;

      const merged = mergeFn(persisted, initialCurrentState);

      expect(merged.folderStates['unknown']).toBeDefined();
      expect(Array.from((merged.folderStates['unknown'] as FolderState).selectedFilePaths)).toEqual(
        ['u.txt']
      );
      expect((merged.folderStates['unknown'] as unknown as Record<string, unknown>)['extra']).toBe(
        'val'
      );
    });
  });

  describe('onRehydrateStorage (Hook)', () => {
    let onRehydrateStorageFn: NonNullable<
      Awaited<ReturnType<typeof getFreshPersistOptions>>['onRehydrateStorage']
    >;

    beforeEach(async () => {
      vi.resetModules();
      const persistOptions = await getFreshPersistOptions();
      if (!persistOptions.onRehydrateStorage) {
        throw new Error('onRehydrateStorage function not found');
      }
      onRehydrateStorageFn = persistOptions.onRehydrateStorage;
    });

    it('returns a completion callback and stays silent in test environment', () => {
      const mockHydratedState = { currentFolderId: 'hydrated' } as unknown as FileExplorerState;
      const afterRehydrate = onRehydrateStorageFn(mockHydratedState);
      expect(typeof afterRehydrate).toBe('function');
      afterRehydrate?.(mockHydratedState, undefined);
      // In test environment, logs should be silenced even when NODE_ENV is development
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('should not log when isDev is false (production)', async () => {
      vi.resetModules(); // Re-import to get new isDev value
      const prodPersistOptions = await getFreshPersistOptions();
      const prodOnRehydrate = prodPersistOptions.onRehydrateStorage;
      if (!prodOnRehydrate) {
        throw new Error('Prod onRehydrateStorage not found');
      }

      const mockHydratedState = { currentFolderId: 'hydrated' } as unknown as FileExplorerState;
      const afterRehydrate = prodOnRehydrate(mockHydratedState);
      afterRehydrate?.(mockHydratedState, undefined);
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('should not throw when rehydration completes with an error', async () => {
      const mockHydratedState = { currentFolderId: 'hydrated' } as unknown as FileExplorerState;
      const afterRehydrate = onRehydrateStorageFn(mockHydratedState);
      expect(() => afterRehydrate?.(undefined, new Error('rehydration failed'))).not.toThrow();
    });
  });
});
