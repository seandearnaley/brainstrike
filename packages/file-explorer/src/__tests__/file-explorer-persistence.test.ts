import type { FileExplorerState, FolderState, SerializedState } from '@brainstrike/types';
import {
  createEmptySelectionModel,
  DEFAULT_MAX_SELECTION_COUNT,
  DEFAULT_STATE,
} from '@brainstrike/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FILE_EXPLORER_STORAGE_VERSION } from '../persistence/persistence-constants';
import { encodeFileSelection } from '../selection.js';

// Mock console spies for all tests in this file
const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
// const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); // Removed unused spy

// Mock storage adapter for tests
const mockStorageAdapter = {
  async clear() {
    // no-op
  },
  async getAllKeys() {
    return [];
  },
  async getItem(_key: string) {
    return null;
  },
  async removeItem(_key: string) {
    // no-op
  },
  async setItem(_key: string, _value: string) {
    // no-op
  },
};

// Helper to dynamically import and get persist options
const getFreshPersistOptions = async () => {
  const mod = await import('../persistence/file-explorer-persistence');
  return mod.createPersistOptions(mockStorageAdapter);
};

const testDefaultFolderState: FolderState = {
  excludeFilters: [...DEFAULT_STATE.excludeFilters], // Copy from global defaults
  expandedDirectoryPaths: new Set<string>(),
  folderSummaryThreshold: DEFAULT_STATE.folderSummaryThreshold,
  includeFilters: [...DEFAULT_STATE.includeFilters], // Copy from global defaults
  includeProjectTree: DEFAULT_STATE.includeProjectTree,
  lastAccessed: 0, // Default lastAccessed
  lastActiveTab: DEFAULT_STATE.lastActiveTab,
  maxSelectionCount: DEFAULT_STATE.maxSelectionCount,
  selectedFilePaths: new Set<string>(),
  selectionModel: createEmptySelectionModel(),
  useRegex: DEFAULT_STATE.useRegex,
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

      expect(persistOptions.name).toBe('file-explorer-storage-v5');
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
        devInlineFixtureEnabled: false,
        excludeFilters: [],
        expandedDirectoryPaths: [],
        folderAccessOrder: [],
        folderStates: {},
        folderSummaryThreshold: 0,
        includeFilters: [],
        includeProjectTree: false,
        lastActiveTab: 'files',
        maxSelectionCount: 0,
        quickFilter: '',
        selectedFilePaths: [],
        useRegex: false,
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
      const fileGlobalKey = encodeFileSelection('folder-123', 'file-global');
      const fileAnotherKey = encodeFileSelection('folder-123', 'file-another');
      const mockState: FileExplorerState = {
        ...(DEFAULT_STATE as FileExplorerState),
        currentFolderId: 'folder-123',
        expandedDirectoryPaths: new Set(['dir-global', 'dir-another']),
        folderStates: {
          'folder-123': {
            ...testDefaultFolderState, // Use defined default folder state
            expandedDirectoryPaths: new Set(['dir1', 'dir2']),
            lastAccessed: 1_234_567_890, // Override specific test values
            lastActiveTab: 'files',
            // Note: These will be overwritten by top-level state during serialization
            // because folder-123 is the current folder
            selectedFilePaths: new Set([
              encodeFileSelection('folder-123', 'file1'),
              encodeFileSelection('folder-123', 'file2'),
            ]),
          },
        },
        lastActiveTab: 'settings',
        selectedFilePaths: new Set([fileGlobalKey, fileAnotherKey]),
      };
      const result = partializeFn(mockState);
      expect(result.currentFolderId).toBe('folder-123');
      expect(result.lastActiveTab).toBe('settings');
      expect(Array.isArray(result.selectedFilePaths)).toBe(true);
      expect(result.selectedFilePaths).toEqual(
        expect.arrayContaining([fileGlobalKey, fileAnotherKey])
      );
      expect(Array.isArray(result.expandedDirectoryPaths)).toBe(true);
      expect(result.expandedDirectoryPaths).toEqual(
        expect.arrayContaining(['dir-global', 'dir-another'])
      );
      // During serialization, current folder's state is synced from top-level state
      // to ensure selections are preserved when app closes without switching folders
      expect(Array.isArray(result.folderStates['folder-123']?.selectedFilePaths)).toBe(true);
      expect(result.folderStates['folder-123']?.selectedFilePaths).toEqual(
        expect.arrayContaining([fileGlobalKey, fileAnotherKey])
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
        expandedDirectoryPaths: [],
        folderStates: {},
        quickFilter: '',
        selectedFilePaths: [],
      });
      expect(migrateFn(undefined, 1)).toMatchObject({
        currentFolderId: null,
        expandedDirectoryPaths: [],
        folderStates: {},
        quickFilter: '',
        selectedFilePaths: [],
      });
    });

    it('should unwrap state from { state, version } wrapper', () => {
      const selectionKey = encodeFileSelection('folder-abc', 'file.ts');
      const actualState: SerializedState = {
        currentFolderId: 'folder-abc',
        devInlineFixtureEnabled: false,
        excludeFilters: [],
        expandedDirectoryPaths: [],
        folderAccessOrder: ['folder-abc'],
        folderStates: {
          'folder-abc': {
            excludeFilters: [],
            expandedDirectoryPaths: [],
            folderSummaryThreshold: 0,
            includeFilters: [],
            includeProjectTree: false,
            lastAccessed: 1,
            lastActiveTab: 'files',
            maxSelectionCount: 0,
            selectedFilePaths: [selectionKey],
            useRegex: false,
            viewFilterPresetId: null,
          },
        },
        folderSummaryThreshold: 0,
        includeFilters: [],
        includeProjectTree: false,
        lastActiveTab: 'files',
        maxSelectionCount: 0,
        quickFilter: '',
        selectedFilePaths: [selectionKey],
        selectionModel: {
          explicitPaths: [selectionKey],
          materializedAt: null,
          materializedPaths: null,
          mode: 'explicit',
          queryDescriptor: null,
        },
        useRegex: false,
      };
      const wrappedState = { state: actualState, version: FILE_EXPLORER_STORAGE_VERSION };
      const result = migrateFn(wrappedState, FILE_EXPLORER_STORAGE_VERSION);
      expect(result).toEqual(actualState);
    });

    it('should discard persisted snapshots from older storage versions', () => {
      const oldSnapshot: SerializedState = {
        currentFolderId: 'stale-folder',
        devInlineFixtureEnabled: false,
        excludeFilters: [],
        expandedDirectoryPaths: ['src'],
        folderAccessOrder: ['stale-folder'],
        folderStates: {},
        folderSummaryThreshold: 0,
        includeFilters: [],
        includeProjectTree: false,
        lastActiveTab: 'files',
        maxSelectionCount: 2000,
        quickFilter: '',
        selectedFilePaths: ['stale-folder|@|file.ts'],
        useRegex: false,
      };

      const result = migrateFn({ state: oldSnapshot, version: 2 }, 2);

      expect(result).toMatchObject({
        currentFolderId: null,
        expandedDirectoryPaths: [],
        folderStates: {},
        quickFilter: '',
        selectedFilePaths: [],
      });
    });

    it('should return state as is if not wrapped', () => {
      const selectionKey = encodeFileSelection('folder-xyz', 'file.js');
      const actualState: SerializedState = {
        currentFolderId: 'folder-xyz',
        devInlineFixtureEnabled: false,
        excludeFilters: [],
        expandedDirectoryPaths: [],
        folderAccessOrder: ['folder-xyz'],
        folderStates: {
          'folder-xyz': {
            excludeFilters: [],
            expandedDirectoryPaths: [],
            folderSummaryThreshold: 0,
            includeFilters: [],
            includeProjectTree: false,
            lastAccessed: 1,
            lastActiveTab: 'files',
            maxSelectionCount: 0,
            selectedFilePaths: [selectionKey],
            useRegex: false,
            viewFilterPresetId: null,
          },
        },
        folderSummaryThreshold: 0,
        includeFilters: [],
        includeProjectTree: false,
        lastActiveTab: 'files',
        maxSelectionCount: 0,
        quickFilter: '',
        selectedFilePaths: [selectionKey],
        selectionModel: {
          explicitPaths: [selectionKey],
          materializedAt: null,
          materializedPaths: null,
          mode: 'explicit',
          queryDescriptor: null,
        },
        useRegex: false,
      };
      const result = migrateFn(actualState, FILE_EXPLORER_STORAGE_VERSION);
      expect(result).toEqual(actualState);
    });

    it('should discard legacy persisted state versions instead of backfilling them', () => {
      const legacyState = {
        currentFolderId: 'folder-abc',
        excludeFilters: [],
        expandedDirectoryPaths: [],
        folderAccessOrder: ['folder-abc'],
        folderStates: {
          'folder-abc': {
            excludeFilters: [],
            expandedDirectoryPaths: [],
            folderSummaryThreshold: 10,
            includeFilters: [],
            includeProjectTree: false,
            lastAccessed: 1,
            lastActiveTab: 'files',
            maxSelectionCount: 50,
            selectedFilePaths: ['folder-abc|@|file.ts'],
            useRegex: false,
            viewFilterPresetId: null,
          },
        },
        folderSummaryThreshold: 10,
        includeFilters: [],
        includeProjectTree: false,
        lastActiveTab: 'files',
        maxSelectionCount: 50,
        selectedFilePaths: ['folder-abc|@|file.ts'],
        useRegex: false,
      } as unknown as SerializedState;

      const result = migrateFn(legacyState, 1);

      expect(result).toMatchObject({
        currentFolderId: null,
        expandedDirectoryPaths: [],
        folderStates: {},
        quickFilter: '',
        selectedFilePaths: [],
      });
    });

    it('should discard wrappers when state is undefined', () => {
      const wrapper = { state: undefined, version: 1 } as unknown as SerializedState;
      const result = migrateFn(wrapper, 1);
      expect(result).toMatchObject({
        currentFolderId: null,
        expandedDirectoryPaths: [],
        folderStates: {},
        quickFilter: '',
        selectedFilePaths: [],
      });
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('should replace malformed objects with a safe empty serialized state', () => {
      const malformed = { version: 1 } as unknown as SerializedState;
      const result = migrateFn(malformed as unknown as SerializedState, 1);
      expect(result).toMatchObject({
        currentFolderId: null,
        expandedDirectoryPaths: [],
        folderStates: {},
        quickFilter: '',
        selectedFilePaths: [],
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
      expandedDirectoryPaths: new Set(),
      folderStates: {
        'initial-folder': {
          ...testDefaultFolderState, // Use defined default folder state
          expandedDirectoryPaths: new Set(['initial-exp-dir']),
          lastActiveTab: 'preview',
          selectedFilePaths: new Set([encodeFileSelection('initial-folder', 'initial-sel.txt')]),
        },
      },
      selectedFilePaths: new Set(),
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

    it('heals a degraded global maxSelectionCount from folder snapshots and writes it through', () => {
      // Per-folder-cap-era profiles: the top-level value could be a stale 10
      // (hydrated from whichever root was focused at save time) while another
      // folder snapshot holds the user's real setting.
      const serializedFolder = {
        excludeFilters: [] as string[],
        expandedDirectoryPaths: [] as string[],
        folderSummaryThreshold: 10,
        includeFilters: [] as string[],
        includeProjectTree: true,
        lastAccessed: Date.now(),
        lastActiveTab: 'files',
        selectedFilePaths: [] as string[],
        useRegex: false,
      };
      const persisted: SerializedState = {
        currentFolderId: 'stale-root',
        devInlineFixtureEnabled: false,
        excludeFilters: [],
        expandedDirectoryPaths: [],
        folderAccessOrder: ['stale-root', 'configured-root'],
        folderStates: {
          'configured-root': { ...serializedFolder, maxSelectionCount: 100 },
          'stale-root': { ...serializedFolder, maxSelectionCount: 10 },
        },
        folderSummaryThreshold: 20,
        includeFilters: [],
        includeProjectTree: true,
        lastActiveTab: 'files',
        maxSelectionCount: 10,
        quickFilter: '',
        selectedFilePaths: [],
        useRegex: false,
      };

      const result = mergeFn(persisted, initialCurrentState);

      expect(result.maxSelectionCount).toBe(100);
      expect(result.folderStates['stale-root']?.maxSelectionCount).toBe(100);
      expect(result.folderStates['configured-root']?.maxSelectionCount).toBe(100);
    });

    it('heals the legacy default cap (10) up to the current default on load', () => {
      // The pre-2026-07 default was 10 — an always-persisted value, so a
      // profile carrying 10 everywhere is indistinguishable from an opt-in.
      // 10 was hostile enough (constant silent truncation) that we adopt the
      // new default for those profiles; a deliberate 10 can be re-lowered in
      // settings once. Any OTHER persisted value is a real user choice and is
      // preserved verbatim (below).
      const serializedFolder = {
        excludeFilters: [] as string[],
        expandedDirectoryPaths: [] as string[],
        folderSummaryThreshold: 10,
        includeFilters: [] as string[],
        includeProjectTree: true,
        lastAccessed: Date.now(),
        lastActiveTab: 'files',
        selectedFilePaths: [] as string[],
        useRegex: false,
      };
      const basePersisted: SerializedState = {
        currentFolderId: 'root-a',
        devInlineFixtureEnabled: false,
        excludeFilters: [],
        expandedDirectoryPaths: [],
        folderAccessOrder: ['root-a'],
        folderStates: {
          'root-a': { ...serializedFolder, maxSelectionCount: 10 },
        },
        folderSummaryThreshold: 20,
        includeFilters: [],
        includeProjectTree: true,
        lastActiveTab: 'files',
        maxSelectionCount: 10,
        quickFilter: '',
        selectedFilePaths: [],
        useRegex: false,
      };

      const healed = mergeFn(basePersisted, initialCurrentState);
      expect(healed.maxSelectionCount).toBe(DEFAULT_MAX_SELECTION_COUNT);
      expect(healed.folderStates['root-a']?.maxSelectionCount).toBe(DEFAULT_MAX_SELECTION_COUNT);

      const lowered = mergeFn(
        {
          ...basePersisted,
          folderStates: { 'root-a': { ...serializedFolder, maxSelectionCount: 5 } },
          maxSelectionCount: 5,
        },
        initialCurrentState
      );
      expect(lowered.maxSelectionCount).toBe(5);

      const raised = mergeFn(
        {
          ...basePersisted,
          folderStates: { 'root-a': { ...serializedFolder, maxSelectionCount: 200 } },
          maxSelectionCount: 200,
        },
        initialCurrentState
      );
      expect(raised.maxSelectionCount).toBe(200);
    });

    it('should merge persisted SerializedState into current FileExplorerState, converting arrays to Sets', () => {
      const anotherSelection = encodeFileSelection('another-persisted', 'another.txt');
      const persistedSelection = encodeFileSelection('persisted-folder', 'persisted-sel.txt');
      const persistedGlobalSelection = encodeFileSelection(
        'persisted-folder',
        'persisted-global.txt'
      );
      const persisted: SerializedState = {
        currentFolderId: 'persisted-folder',
        devInlineFixtureEnabled: false,
        excludeFilters: ['backups'],
        expandedDirectoryPaths: ['persisted-global-dir'],
        folderAccessOrder: ['persisted-folder', 'another-persisted'],
        folderStates: {
          'another-persisted': {
            excludeFilters: [],
            expandedDirectoryPaths: [],
            folderSummaryThreshold: 0,
            includeFilters: [],
            includeProjectTree: false,
            lastAccessed: Date.now(),
            lastActiveTab: 'files',
            maxSelectionCount: 0,
            selectedFilePaths: [anotherSelection],
            useRegex: false,
          },
          'persisted-folder': {
            excludeFilters: [],
            expandedDirectoryPaths: ['persisted-exp-dir'],
            folderSummaryThreshold: 10,
            includeFilters: ['*.json'],
            includeProjectTree: true,
            lastAccessed: Date.now(),
            lastActiveTab: 'files',
            maxSelectionCount: 10,
            selectedFilePaths: [persistedSelection],
            useRegex: false,
          },
        },
        folderSummaryThreshold: 20,
        includeFilters: ['*.md'],
        includeProjectTree: true,
        lastActiveTab: 'preview',
        maxSelectionCount: 20,
        quickFilter: '',
        selectedFilePaths: [persistedGlobalSelection],
        useRegex: true,
      };

      const result = mergeFn(persisted, initialCurrentState);

      expect(result.currentFolderId).toBe('persisted-folder');
      expect(result.lastActiveTab).toBe('preview');
      expect(result.includeFilters).toEqual(['*.md']);
      expect(result.selectedFilePaths).toBeInstanceOf(Set);
      expect(result.selectedFilePaths.has(persistedGlobalSelection)).toBe(true);
      expect(result.expandedDirectoryPaths).toBeInstanceOf(Set);
      expect(result.expandedDirectoryPaths.has('persisted-global-dir')).toBe(true);

      expect(result.folderStates['persisted-folder']).toBeDefined();
      expect(result.folderStates['persisted-folder']?.selectedFilePaths).toBeInstanceOf(Set);
      expect(
        result.folderStates['persisted-folder']?.selectedFilePaths.has(persistedSelection)
      ).toBe(true);
      expect(result.folderStates['persisted-folder']?.includeFilters).toEqual(['*.json']);

      expect(result.folderStates['another-persisted']).toBeDefined();
      expect(
        result.folderStates['another-persisted']?.selectedFilePaths.has(anotherSelection)
      ).toBe(true);

      expect(result.folderStates['initial-folder']).toBeDefined();
      expect(
        result.folderStates['initial-folder']?.selectedFilePaths.has(
          encodeFileSelection('initial-folder', 'initial-sel.txt')
        )
      ).toBe(true);
      expect(result.folderStates['initial-folder']?.lastActiveTab).toBe('preview');
    });

    it('should round-trip state via partialize and merge', () => {
      // Note: During serialization, the current folder's state is synced from top-level state.
      // This ensures that when the app closes without switching folders, the current folder's
      // selections are preserved. The top-level state is always the "working copy".
      const state: FileExplorerState = {
        ...(DEFAULT_STATE as FileExplorerState),
        currentFolderId: 'rt-folder',
        expandedDirectoryPaths: new Set(['d1']),
        folderStates: {
          'rt-folder': {
            ...testDefaultFolderState,
            expandedDirectoryPaths: new Set(['fd1']),
            lastAccessed: 123,
            lastActiveTab: 'files',
            // These will be overwritten by top-level state during serialization
            selectedFilePaths: new Set([encodeFileSelection('rt-folder', 'fs1')]),
          },
        },
        selectedFilePaths: new Set([
          encodeFileSelection('rt-folder', 's1'),
          encodeFileSelection('rt-folder', 's2'),
        ]),
      };

      const serialized = partializeFn(state);
      const merged = mergeFn(serialized, initialCurrentState);

      expect(merged.currentFolderId).toBe('rt-folder');
      expect(Array.from(merged.selectedFilePaths)).toEqual([
        encodeFileSelection('rt-folder', 's1'),
        encodeFileSelection('rt-folder', 's2'),
      ]);
      expect(Array.from(merged.expandedDirectoryPaths)).toEqual(['d1']);
      expect(merged.folderStates['rt-folder']).toBeDefined();
      // After serialization, the current folder's state is synced from top-level
      expect(Array.from(merged.folderStates['rt-folder']?.selectedFilePaths ?? new Set())).toEqual([
        encodeFileSelection('rt-folder', 's1'),
        encodeFileSelection('rt-folder', 's2'),
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
            expandedDirectoryPaths: new Set(['extra-dir']),
            lastActiveTab: 'files',
            selectedFilePaths: new Set([encodeFileSelection('extra-folder', 'extra.txt')]),
          },
        },
      };

      const persisted: SerializedState = {
        currentFolderId: null,
        devInlineFixtureEnabled: false,
        excludeFilters: [],
        expandedDirectoryPaths: [],
        folderAccessOrder: [],
        folderStates: {},
        folderSummaryThreshold: 0,
        includeFilters: [],
        includeProjectTree: false,
        lastActiveTab: 'files',
        maxSelectionCount: 0,
        quickFilter: '',
        selectedFilePaths: [],
        useRegex: false,
      };

      const result = mergeFn(persisted, currentWithExtra);
      expect(result.folderStates['extra-folder']).toBeDefined();
      expect(
        Array.from(result.folderStates['extra-folder']?.selectedFilePaths ?? new Set())
      ).toEqual([encodeFileSelection('extra-folder', 'extra.txt')]);
      expect(result.folderStates['initial-folder']).toBeDefined();
    });

    it('should round-trip state via partialize and merge with multiple folders and empty sets', () => {
      const state: FileExplorerState = {
        ...(DEFAULT_STATE as FileExplorerState),
        currentFolderId: 'one',
        expandedDirectoryPaths: new Set(),
        folderStates: {
          one: {
            ...testDefaultFolderState,
            expandedDirectoryPaths: new Set(),
            lastAccessed: 1,
            lastActiveTab: 'files',
            selectedFilePaths: new Set(),
          },
          two: {
            ...testDefaultFolderState,
            expandedDirectoryPaths: new Set(),
            lastAccessed: 2,
            lastActiveTab: 'preview',
            selectedFilePaths: new Set(),
          },
        },
        selectedFilePaths: new Set(),
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
      const unknownSelection = encodeFileSelection('unknown', 'u.txt');
      const persisted: SerializedState = {
        currentFolderId: null,
        excludeFilters: [],
        expandedDirectoryPaths: [],
        folderAccessOrder: [],
        folderStates: {
          unknown: {
            excludeFilters: [],
            expandedDirectoryPaths: [],
            // extra property not in FolderState
            extra: 'val' as unknown as never,
            folderSummaryThreshold: 0,
            includeFilters: [],
            includeProjectTree: false,
            lastAccessed: 1,
            lastActiveTab: 'files',
            maxSelectionCount: 0,
            selectedFilePaths: [unknownSelection],
            useRegex: false,
          },
        },
        folderSummaryThreshold: 0,
        includeFilters: [],
        includeProjectTree: false,
        lastActiveTab: 'files',
        maxSelectionCount: 0,
        selectedFilePaths: [],
        useRegex: false,
        // Deliberately missing devInlineFixtureEnabled/quickFilter — this
        // fixture intentionally models a pre-migration/incomplete persisted
        // snapshot to exercise merge-with-unknown-shape handling, hence the
        // `unknown` escape hatch below.
      } as unknown as SerializedState;

      const merged = mergeFn(persisted, initialCurrentState);

      expect(merged.folderStates['unknown']).toBeDefined();
      expect(Array.from((merged.folderStates['unknown'] as FolderState).selectedFilePaths)).toEqual(
        [unknownSelection]
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
