/**
 * File Explorer Store
 *
 * This store manages the state of the file explorer, including selected files, expanded directories,
 * and folder-specific states. It uses Zustand with persistence to maintain state across page reloads.
 *
 * Action logic is delegated to separate action creator functions imported from ./actions/*.
 */

import type { StorageAdapter } from '@brainstrike/storage';
import { MemoryStorageAdapter } from '@brainstrike/storage'; // Import MemoryStorageAdapter
import type { FileExplorerState } from '@brainstrike/types';
import { DEFAULT_STATE } from '@brainstrike/types';
import { setupHMR } from '@brainstrike/utils/hmr-utils';
import type { StateCreator } from 'zustand';
import { persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';
import { createDirectoryExpansionActions } from './actions/directory-expansion-actions';
import { createFileContentActions } from './actions/file-content-actions';
import { createFileSelectionActions } from './actions/file-selection-actions';
import { createFolderStateActions } from './actions/folder-state-actions';
import { createSelectionModelActions } from './actions/selection-model-actions';
import { createSettingsActions } from './actions/settings-actions';
import { createPersistOptions } from './persistence/file-explorer-persistence';

// Explicitly type the state creator function
const stateCreator: StateCreator<FileExplorerState, [['zustand/persist', unknown]], []> = (
  set,
  get
) => {
  const initialData = {
    // Initial state properties from DEFAULT_STATE
    ...DEFAULT_STATE,
    // Ensure lastActiveTab is explicitly set from DEFAULT_STATE or provide default
    lastActiveTab: DEFAULT_STATE.lastActiveTab ?? 'files',
    // Initialize/Override specific state parts as needed
    currentFolderId: null,
    folderStates: {},
    folderAccessOrder: [],
    selectedFilePaths: new Set<string>(),
    expandedDirectoryPaths: new Set<string>(),
    quickFilter: '',
    rootDirectoryHandle: null,
    // Ephemeral access loading state (not persisted)
    isAccessLoading: false,
  };

  const actions = {
    ...createFolderStateActions(set, get),
    ...createFileSelectionActions(set, get),
    ...createDirectoryExpansionActions(set, get),
    ...createSettingsActions(set, get),
    ...createFileContentActions(set, get),
    ...createSelectionModelActions(set, get),
    setQuickFilter: (value: string) => {
      set({ quickFilter: value });
    },
    clearQuickFilter: () => {
      set({ quickFilter: '' });
    },
    setRootDirectoryHandle: (handle: FileExplorerState['rootDirectoryHandle']) => {
      set({ rootDirectoryHandle: handle });
    },
    setDevInlineFixtureEnabled: (value: boolean) => {
      set({ devInlineFixtureEnabled: value });
    },
    setIsAccessLoading: (loading: boolean) => {
      set({ isAccessLoading: loading });
    },
    setFiltersExpanded: (expanded: boolean) => {
      set({ isFiltersExpanded: expanded });
    },
  };

  // Combine data and actions. Type assertion might be needed if inference fails.
  return {
    ...initialData,
    ...actions,
  } as FileExplorerState;
};

// Factory function to create store with custom storage adapter
export function createFileExplorerStore(storageAdapter: StorageAdapter) {
  return create<FileExplorerState>()(persist(stateCreator, createPersistOptions(storageAdapter)));
}

// Default store instance for backward compatibility (HMR-safe singleton)

let defaultPersistStorageAdapter: StorageAdapter;

if (typeof localStorage === 'undefined') {
  // Fallback for Node.js environments (like tests) where localStorage is not available
  // Using MemoryStorageAdapter ensures it behaves like a storage but doesn't persist anywhere problematic
  defaultPersistStorageAdapter = new MemoryStorageAdapter();
} else {
  defaultPersistStorageAdapter = {
    async getItem(key: string) {
      return localStorage.getItem(key);
    },
    async setItem(key: string, value: string) {
      localStorage.setItem(key, value);
    },
    async removeItem(key: string) {
      localStorage.removeItem(key);
    },
    /* v8 ignore start -- Zustand persist storage only calls getItem/setItem/removeItem */
    async clear() {
      localStorage.clear();
    },
    async getAllKeys() {
      return Object.keys(localStorage);
    },
    /* v8 ignore stop */
  };
}

const STORE_KEY = '__brainstrike_file_explorer_store__' as const;
const STORE_BRAND = '__brainstrike_store_brand__';
const STORE_VERSION = 1 as const;
const g = globalThis as unknown as Record<string, unknown>;
type BoundStore = ReturnType<ReturnType<typeof create<FileExplorerState>>>;
function isValidStore(candidate: unknown): candidate is BoundStore & { [k: string]: unknown } {
  if (!candidate || typeof candidate !== 'function') {
    return false;
  }
  const cand = candidate as unknown as {
    getState?: unknown;
    setState?: unknown;
    [k: string]: unknown;
  };
  const hasAPI = typeof cand.getState === 'function' && typeof cand.setState === 'function';
  const version = cand[STORE_BRAND];
  return hasAPI && version === STORE_VERSION;
}

let storeSingleton = g[STORE_KEY] as unknown;
if (!isValidStore(storeSingleton)) {
  storeSingleton = create<FileExplorerState>()(
    persist(stateCreator, createPersistOptions(defaultPersistStorageAdapter))
  );
  (storeSingleton as Record<string, unknown>)[STORE_BRAND] = STORE_VERSION as unknown as number;
  g[STORE_KEY] = storeSingleton as unknown;
}
export const useFileExplorerStore = storeSingleton as BoundStore;

// Set up HMR if available (safe in both ESM and CJS environments)
/* c8 ignore start - Dev-only HMR wiring; excluded from coverage */
setupHMR(undefined, () => {
  // keep store on global between swaps
});

/* c8 ignore end */

export { stateCreator };
