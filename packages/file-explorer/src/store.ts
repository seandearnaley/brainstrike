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
import type { StateCreator } from 'zustand';
import { persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';
import { createDirectoryExpansionActions } from './actions/directory-expansion-actions';
import { createFileContentActions } from './actions/file-content-actions';
import { createFileSelectionActions } from './actions/file-selection-actions';
import { createFolderStateActions } from './actions/folder-state-actions';
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
  };

  const actions = {
    ...createFolderStateActions(set, get),
    ...createFileSelectionActions(set, get),
    ...createDirectoryExpansionActions(set, get),
    ...createSettingsActions(set, get),
    ...createFileContentActions(set, get),
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

// Default store instance for backward compatibility
// This will be deprecated once all consumers use the factory

let defaultPersistStorageAdapter: StorageAdapter;

if (typeof localStorage !== 'undefined') {
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
    async clear() {
      localStorage.clear();
    },
    async getAllKeys() {
      return Object.keys(localStorage);
    },
  };
} else {
  // Fallback for Node.js environments (like tests) where localStorage is not available
  // Using MemoryStorageAdapter ensures it behaves like a storage but doesn't persist anywhere problematic
  defaultPersistStorageAdapter = new MemoryStorageAdapter();
}

export const useFileExplorerStore = create<FileExplorerState>()(
  persist(stateCreator, createPersistOptions(defaultPersistStorageAdapter))
);

export { stateCreator };
