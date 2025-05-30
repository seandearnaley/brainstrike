/**
 * File Explorer Persistence
 *
 * This module contains persistence configuration and utilities for the file explorer store.
 * It handles state serialization/deserialization and rehydration.
 */

import type { StorageAdapter } from '@brainstrike/storage';
import type { FileExplorerState, FolderState, SerializedState } from '@brainstrike/types';
import type { PersistOptions } from 'zustand/middleware';
// eslint-disable-next-line no-undef -- process.env is available in Vite/Node environments

// biome-ignore lint/complexity/useLiteralKeys: Required for TS 5.4+ compatibility (TS4111)
const isDev = typeof process !== 'undefined' && process.env['NODE_ENV'] !== 'production';

const isTest =
  typeof process !== 'undefined' &&
  // biome-ignore lint/complexity/useLiteralKeys: Required for TS 5.4+ compatibility (TS4111)
  (process.env['NODE_ENV'] === 'test' ||
    (typeof globalThis !== 'undefined' &&
      ('vitest' in globalThis || 'jest' in globalThis || '__vitest_worker__' in globalThis)));
const shouldLog = isDev && !isTest;

type ZustandPersistWrapper<T> = { state?: T; version?: number };

export const createPersistOptions = (
  storageAdapter: StorageAdapter
): PersistOptions<FileExplorerState, SerializedState> => ({
  name: 'file-explorer-storage-v4',
  version: 1,

  // Use the provided storage adapter instead of default localStorage
  storage: {
    getItem: async (name: string) => {
      try {
        const value = await storageAdapter.getItem(name);
        // console.log('[Persist] getItem value:', value ? JSON.parse(value) : null);
        return value ? JSON.parse(value) : null;
      } catch (error) {
        if (shouldLog) {
          console.error('Error getting item from storage:', error);
        }
        return null;
      }
    },
    setItem: async (name: string, value: unknown) => {
      try {
        // console.log('[Persist] setItem value:', value);
        await storageAdapter.setItem(name, JSON.stringify(value));
      } catch (error) {
        if (shouldLog) {
          console.error('Error setting item in storage:', error);
        }
      }
    },
    removeItem: async (name: string) => {
      try {
        await storageAdapter.removeItem(name);
      } catch (error) {
        if (shouldLog) {
          console.error('Error removing item from storage:', error);
        }
      }
    },
  },

  partialize: (state) => {
    if (shouldLog) {
      // console.log('[Partialize] Input FileExplorerState (with Sets):', state);
    }
    const serialized: SerializedState = {
      currentFolderId: state.currentFolderId,
      folderStates: Object.fromEntries(
        Object.entries(state.folderStates || {}).map(([id, folderState]) => [
          id,
          {
            ...folderState,
            selectedFilePaths: Array.from(folderState?.selectedFilePaths || new Set<string>()),
            expandedDirectoryPaths: Array.from(
              folderState?.expandedDirectoryPaths || new Set<string>()
            ),
            lastAccessed: folderState?.lastAccessed || Date.now(),
          },
        ])
      ),
      folderAccessOrder: state.folderAccessOrder,
      selectedFilePaths: Array.from(state.selectedFilePaths || new Set<string>()),
      expandedDirectoryPaths: Array.from(state.expandedDirectoryPaths || new Set<string>()),
      includeFilters: state.includeFilters,
      excludeFilters: state.excludeFilters,
      useRegex: state.useRegex,
      includeProjectTree: state.includeProjectTree,
      folderSummaryThreshold: state.folderSummaryThreshold,
      maxSelectionCount: state.maxSelectionCount,
      lastActiveTab: state.lastActiveTab ?? 'files',
    };
    if (shouldLog) {
      // console.log('[Partialize] Output SerializedState (with Arrays):', serialized);
    }
    return serialized;
  },

  migrate: (rawPersistedState, version) => {
    if (shouldLog)
      console.log('[Migrate] Received raw state:', rawPersistedState, 'Version:', version);

    if (rawPersistedState == null) {
      if (shouldLog) console.log('[Migrate] No state (null or undefined), returning it as is.');
      return rawPersistedState as unknown as SerializedState;
    }

    const wrapper = rawPersistedState as Partial<ZustandPersistWrapper<SerializedState>>;
    const stateToProcess =
      wrapper.state !== undefined ? wrapper.state : (rawPersistedState as SerializedState);

    if (stateToProcess == null) {
      if (shouldLog)
        console.log('[Migrate] No actual state after unwrap (null/undefined), returning as is.');
      return stateToProcess as unknown as SerializedState;
    }

    const serialized = stateToProcess as SerializedState;
    if (shouldLog) console.log('[Migrate] Returning valid SerializedState:', serialized);
    return serialized;
  },

  merge: (persisted, current) => {
    if (shouldLog)
      console.log(
        '[Merge] Persisted (SerializedState from migrate):',
        persisted,
        'Current (FileExplorerState from initial):',
        current
      );
    if (!persisted) {
      if (shouldLog) console.log('[Merge] No persisted state, returning current initial state.');
      return current;
    }

    const persistedSerialized = persisted as SerializedState;

    const mergedState: FileExplorerState = {
      ...current,
      ...persistedSerialized,
      selectedFilePaths: new Set(
        Array.isArray(persistedSerialized.selectedFilePaths)
          ? persistedSerialized.selectedFilePaths
          : []
      ),
      expandedDirectoryPaths: new Set(
        Array.isArray(persistedSerialized.expandedDirectoryPaths)
          ? persistedSerialized.expandedDirectoryPaths
          : []
      ),
      folderAccessOrder: Array.isArray(persistedSerialized.folderAccessOrder)
        ? persistedSerialized.folderAccessOrder
        : [],
      folderStates: Object.fromEntries(
        Object.entries(persistedSerialized.folderStates ?? {}).map(([key, psFolderState]) => {
          const currentFolderState = current.folderStates[key];
          return [
            key,
            {
              ...(currentFolderState ?? ({} as FolderState)),
              ...psFolderState,
              selectedFilePaths: new Set(
                Array.isArray(psFolderState.selectedFilePaths)
                  ? psFolderState.selectedFilePaths
                  : []
              ),
              expandedDirectoryPaths: new Set(
                Array.isArray(psFolderState.expandedDirectoryPaths)
                  ? psFolderState.expandedDirectoryPaths
                  : []
              ),
            },
          ];
        })
      ),
    };

    // Ensure all folder states from `current` (initial) that were not in `persisted` are carried over.
    // This ensures that if a folder existed only in initial state, it remains.
    for (const key in current.folderStates) {
      if (!mergedState.folderStates[key]) {
        mergedState.folderStates[key] = current.folderStates[key] as FolderState;
      }
    }

    if (shouldLog)
      console.log('[Merge] Resulting merged FileExplorerState (with Sets):', mergedState);
    return mergedState;
  },

  onRehydrateStorage: (state) => {
    if (shouldLog) {
      console.log('[onRehydrateStorage] Storage rehydrated. Final state in store:', state);
    }
  },
});
