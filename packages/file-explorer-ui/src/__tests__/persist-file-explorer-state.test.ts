// @vitest-environment node
import type { StorageAdapter } from '@brainstrike/storage';
import type { SerializedState } from '@brainstrike/types';
import { describe, expect, it, vi } from 'vitest';
import {
  type PersistableFileExplorerStore,
  type PersistOptions,
  persistFileExplorerStateImmediately,
} from '../utils/persist-file-explorer-state';

const createStorageAdapter = (): StorageAdapter => ({
  clear: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  getAllKeys: vi.fn<() => Promise<string[]>>(() => Promise.resolve([])),
  getItem: vi.fn<(_: string) => Promise<string | null>>(() => Promise.resolve(null)),
  removeItem: vi.fn<(_: string) => Promise<void>>(() => Promise.resolve()),
  setItem: vi.fn<(_: string, value: string) => Promise<void>>(() => Promise.resolve()),
});

const createSerializedState = (overrides: Partial<SerializedState> = {}): SerializedState => ({
  currentFolderId: null,
  devInlineFixtureEnabled: false,
  excludeFilters: [],
  expandedDirectoryPaths: [],
  folderAccessOrder: [],
  folderStates: {},
  folderSummaryThreshold: 100,
  includeFilters: [],
  includeProjectTree: true,
  lastActiveTab: 'preview',
  maxSelectionCount: 500,
  quickFilter: '',
  selectedFilePaths: [],
  useRegex: false,
  ...overrides,
});

const createStore = (state: unknown, options?: PersistOptions): PersistableFileExplorerStore =>
  ({
    getState: () => state,
    persist: options
      ? {
          getOptions: () => options,
        }
      : undefined,
  }) as unknown as PersistableFileExplorerStore;

describe('persistFileExplorerStateImmediately', () => {
  it('writes a partialized snapshot with the configured storage key and version', async () => {
    const storageAdapter = createStorageAdapter();
    const store = createStore(
      { selectedFilePaths: new Set(['/root/a.ts']), volatile: true },
      {
        name: 'file-explorer',
        partialize: (state) => {
          const narrowedState = state as unknown as { selectedFilePaths: Set<string> };
          return createSerializedState({
            selectedFilePaths: [...narrowedState.selectedFilePaths],
          });
        },
        version: 7,
      }
    );

    await persistFileExplorerStateImmediately(store, storageAdapter);

    expect(storageAdapter.setItem).toHaveBeenCalledWith(
      'file-explorer',
      JSON.stringify({
        state: createSerializedState({ selectedFilePaths: ['/root/a.ts'] }),
        version: 7,
      })
    );
  });

  it('throws when the store does not expose the persist API', async () => {
    const storageAdapter = createStorageAdapter();
    const store = createStore({});

    await expect(persistFileExplorerStateImmediately(store, storageAdapter)).rejects.toThrow(
      'File explorer persist API is unavailable'
    );
    expect(storageAdapter.setItem).not.toHaveBeenCalled();
  });

  it('throws when the persistence key is missing', async () => {
    const storageAdapter = createStorageAdapter();
    const store = createStore({}, { version: 2 });

    await expect(persistFileExplorerStateImmediately(store, storageAdapter)).rejects.toThrow(
      'File explorer persistence key is missing'
    );
    expect(storageAdapter.setItem).not.toHaveBeenCalled();
  });

  it('persists the full store state with version zero when no partializer is configured', async () => {
    const storageAdapter = createStorageAdapter();
    const store = createStore({ includeProjectTree: true }, { name: 'file-explorer' });

    await persistFileExplorerStateImmediately(store, storageAdapter);

    expect(storageAdapter.setItem).toHaveBeenCalledWith(
      'file-explorer',
      JSON.stringify({
        state: { includeProjectTree: true },
        version: 0,
      })
    );
  });
});
