/**
 * File Explorer Persistence
 *
 * This module contains persistence configuration and utilities for the file explorer store.
 * It handles state serialization/deserialization and rehydration.
 */

import type { StorageAdapter } from '@brainstrike/storage';
import type { FileExplorerState, SerializedState } from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils/logger';
import type { PersistOptions, PersistStorage } from 'zustand/middleware';
import { FILE_EXPLORER_STORAGE_KEY, FILE_EXPLORER_STORAGE_VERSION } from './persistence-constants';
import { migrateState } from './state-migration';
import { mergeState, serializeState } from './state-serialization';
import { createStorageWrapper } from './storage-wrapper';
import { detectTestEnvironment } from './test-environment';
import { initWorker } from './worker-init';

const logger = createLogger('Persistence');

const NODE_ENV_KEY = 'NODE_ENV';
const nodeEnv = globalThis.process?.env?.[NODE_ENV_KEY];
const isDev = nodeEnv !== 'production';

const isTest = detectTestEnvironment();
const shouldLog = isDev && !isTest;

function isRehydratedFileExplorerState(
  state: FileExplorerState | undefined
): state is FileExplorerState {
  return Boolean(
    state &&
      typeof state === 'object' &&
      state.folderStates &&
      typeof state.folderStates === 'object' &&
      Array.isArray(state.folderAccessOrder)
  );
}

export function createPersistedFileExplorerSnapshot(state: FileExplorerState): {
  state: SerializedState;
  version: typeof FILE_EXPLORER_STORAGE_VERSION;
} {
  return {
    state: serializeState(state),
    version: FILE_EXPLORER_STORAGE_VERSION,
  };
}

export const createPersistOptions = (
  storageAdapter: StorageAdapter
): PersistOptions<FileExplorerState, SerializedState> => {
  const { workerStorage, useWorker } = initWorker(storageAdapter, isTest, shouldLog);

  // Add legacy-key migration from v3 to v4 (only if localStorage exists)
  if (typeof localStorage !== 'undefined') {
    try {
      const legacyKey = 'fileExplorerSettings';
      const newKey = FILE_EXPLORER_STORAGE_KEY;
      const legacy = localStorage.getItem(legacyKey);

      if (legacy && !localStorage.getItem(newKey)) {
        if (shouldLog) {
          logger.debug(`Migrating settings from legacy key "${legacyKey}" to "${newKey}"`);
        }
        localStorage.setItem(newKey, legacy);
        localStorage.removeItem(legacyKey);
      }
    } catch (error) {
      // Ignore potential localStorage access errors in restricted environments
      if (shouldLog) {
        logger.warn('Could not perform legacy settings migration:', error);
      }
    }
  }

  return {
    merge: (persisted, current) =>
      mergeState(persisted as SerializedState | null, current, shouldLog),

    migrate: (rawPersistedState, version) => migrateState(rawPersistedState, version, shouldLog),
    name: FILE_EXPLORER_STORAGE_KEY,

    onRehydrateStorage: () => (state, error) => {
      if (!shouldLog) {
        return;
      }
      if (error) {
        logger.warn('onRehydrateStorage - Storage rehydration failed:', error);
        return;
      }
      if (!isRehydratedFileExplorerState(state)) {
        logger.warn('onRehydrateStorage - Rehydrated state shape was invalid');
        return;
      }
      logger.debug(
        'onRehydrateStorage - Storage rehydrated. Folder count:',
        Object.keys(state.folderStates).length,
        'Current folder:',
        state.currentFolderId
      );
    },

    partialize: (state) => createPersistedFileExplorerSnapshot(state).state,

    storage: createStorageWrapper(
      storageAdapter,
      useWorker,
      workerStorage,
      shouldLog
    ) as PersistStorage<SerializedState>,
    version: FILE_EXPLORER_STORAGE_VERSION,
  };
};
