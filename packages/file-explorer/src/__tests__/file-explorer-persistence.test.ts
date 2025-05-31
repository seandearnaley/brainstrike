import type { FileExplorerState, FolderState, SerializedState } from '@brainstrike/types';
import { DEFAULT_STATE } from '@brainstrike/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock console spies for all tests in this file
const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
// const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); // Removed unused spy
let originalNodeEnv: string | undefined;

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
  folderSummaryThreshold: DEFAULT_STATE.folderSummaryThreshold,
  maxSelectionCount: DEFAULT_STATE.maxSelectionCount,
  lastActiveTab: DEFAULT_STATE.lastActiveTab,
  lastAccessed: 0, // Default lastAccessed
};

describe('file-explorer-persistence', () => {
  beforeEach(() => {
    const NODE_ENV_KEY = 'NODE_ENV';
    originalNodeEnv = process.env[NODE_ENV_KEY];
    vi.clearAllMocks(); // Clear mocks for console spies
    vi.resetModules(); // Reset modules to ensure isDev is re-evaluated based on NODE_ENV
  });

  afterEach(() => {
    const NODE_ENV_KEY = 'NODE_ENV';
    process.env[NODE_ENV_KEY] = originalNodeEnv;
  });

  describe('createPersistOptions', () => {
    it('should create persist options with the correct configuration', async () => {
      const NODE_ENV_KEY = 'NODE_ENV';
      process.env[NODE_ENV_KEY] = 'production'; // Arbitrary for this test
      const persistOptions = await getFreshPersistOptions();
      expect(persistOptions.name).toBe('file-explorer-storage-v4');
      expect(persistOptions.version).toBe(1);
      expect(typeof persistOptions.partialize).toBe('function');
      expect(typeof persistOptions.migrate).toBe('function');
      expect(typeof persistOptions.merge).toBe('function');
      expect(typeof persistOptions.onRehydrateStorage).toBe('function');
    });
  });

  describe('partialize', () => {
    let partializeFn: NonNullable<Awaited<ReturnType<typeof getFreshPersistOptions>>['partialize']>;

    beforeEach(async () => {
      const persistOptions = await getFreshPersistOptions();
      if (!persistOptions.partialize) throw new Error('Partialize function not found');
      partializeFn = persistOptions.partialize;
    });

    it('should correctly serialize state, converting Sets to Arrays', () => {
      const mockState: FileExplorerState = {
        ...(DEFAULT_STATE as FileExplorerState),
        currentFolderId: 'folder-123',
        folderStates: {
          'folder-123': {
            ...testDefaultFolderState, // Use defined default folder state
            selectedFilePaths: new Set(['file1', 'file2']),
            expandedDirectoryPaths: new Set(['dir1', 'dir2']),
            lastAccessed: 1234567890, // Override specific test values
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
      expect(Array.isArray(result.folderStates['folder-123']?.selectedFilePaths)).toBe(true);
      expect(result.folderStates['folder-123']?.selectedFilePaths).toEqual(
        expect.arrayContaining(['file1', 'file2'])
      );
    });
  });

  describe('migrate', () => {
    let migrateFn: NonNullable<Awaited<ReturnType<typeof getFreshPersistOptions>>['migrate']>;

    beforeEach(async () => {
      const persistOptions = await getFreshPersistOptions();
      if (!persistOptions.migrate) throw new Error('Migrate function not found');
      migrateFn = persistOptions.migrate;
    });

    it('should return undefined if raw persisted state is null or undefined', () => {
      expect(migrateFn(null, 1)).toBeNull();
      expect(migrateFn(undefined, 1)).toBeUndefined();
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
      };
      const wrappedState = { state: actualState, version: 1 };
      const result = migrateFn(wrappedState, 1);
      expect(result).toEqual(actualState);
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
      };
      const result = migrateFn(actualState, 1);
      expect(result).toEqual(actualState);
    });

    it('should return wrapper unchanged when state is undefined', () => {
      const wrapper = { state: undefined, version: 1 } as unknown as SerializedState;
      const result = migrateFn(wrapper, 1);
      expect(result).toEqual(wrapper);
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('should handle object missing state property gracefully', () => {
      const malformed = { version: 1 } as unknown as SerializedState;
      const result = migrateFn(malformed as unknown as SerializedState, 1);
      expect(result).toEqual(malformed as unknown as SerializedState);
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
      if (!persistOptions.merge || !persistOptions.partialize)
        throw new Error('Merge or partialize function not found');
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
      const state: FileExplorerState = {
        ...(DEFAULT_STATE as FileExplorerState),
        currentFolderId: 'rt-folder',
        selectedFilePaths: new Set(['s1', 's2']),
        expandedDirectoryPaths: new Set(['d1']),
        folderStates: {
          'rt-folder': {
            ...testDefaultFolderState,
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
      expect(Array.from(merged.folderStates['rt-folder']?.selectedFilePaths ?? new Set())).toEqual([
        'fs1',
      ]);
      expect(
        Array.from(merged.folderStates['rt-folder']?.expandedDirectoryPaths ?? new Set())
      ).toEqual(['fd1']);
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
  });

  describe('onRehydrateStorage (Hook)', () => {
    let onRehydrateStorageFn: NonNullable<
      Awaited<ReturnType<typeof getFreshPersistOptions>>['onRehydrateStorage']
    >;

    beforeEach(async () => {
      const NODE_ENV_KEY = 'NODE_ENV';
      process.env[NODE_ENV_KEY] = 'development'; // Ensure logging
      vi.resetModules();
      const persistOptions = await getFreshPersistOptions();
      if (!persistOptions.onRehydrateStorage)
        throw new Error('onRehydrateStorage function not found');
      onRehydrateStorageFn = persistOptions.onRehydrateStorage;
    });

    it('should be called with the rehydrated state but not log in test environment', () => {
      const mockHydratedState = { currentFolderId: 'hydrated' } as unknown as FileExplorerState;
      onRehydrateStorageFn(mockHydratedState);
      // In test environment, logs should be silenced even when NODE_ENV is development
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('should not log when isDev is false (production)', async () => {
      const NODE_ENV_KEY = 'NODE_ENV';
      process.env[NODE_ENV_KEY] = 'production';
      vi.resetModules(); // Re-import to get new isDev value
      const prodPersistOptions = await getFreshPersistOptions();
      const prodOnRehydrate = prodPersistOptions.onRehydrateStorage;
      if (!prodOnRehydrate) throw new Error('Prod onRehydrateStorage not found');

      const mockHydratedState = { currentFolderId: 'hydrated' } as unknown as FileExplorerState;
      prodOnRehydrate(mockHydratedState);
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });
  });
});
