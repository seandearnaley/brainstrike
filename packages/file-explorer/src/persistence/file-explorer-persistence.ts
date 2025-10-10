/**
 * File Explorer Persistence
 *
 * This module contains persistence configuration and utilities for the file explorer store.
 * It handles state serialization/deserialization and rehydration.
 */

import type { StorageAdapter } from '@brainstrike/storage';
import type { FileExplorerState, SerializedState } from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils';
import type { PersistOptions, PersistStorage } from 'zustand/middleware';
import { migrateState } from './state-migration';
import { mergeState, serializeState } from './state-serialization';
import { createStorageWrapper } from './storage-wrapper';
import { initWorker } from './worker-init';

const logger = createLogger('Persistence');

const NODE_ENV_KEY = 'NODE_ENV';
const nodeEnv = globalThis.process?.env?.[NODE_ENV_KEY];
const isDev = nodeEnv !== 'production';

const isTest =
  nodeEnv === 'test' ||
  (typeof globalThis !== 'undefined' &&
    ('vitest' in globalThis || 'jest' in globalThis || '__vitest_worker__' in globalThis));
const shouldLog = isDev && !isTest;

export const createPersistOptions = (
  storageAdapter: StorageAdapter
): PersistOptions<FileExplorerState, SerializedState> => {
  const { workerStorage, useWorker } = initWorker(isTest, shouldLog);

  // Add legacy-key migration from v3 to v4 (only if localStorage exists)
  if (typeof localStorage !== 'undefined') {
    try {
      const legacyKey = 'fileExplorerSettings';
      const newKey = 'file-explorer-storage-v4';
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
    name: 'file-explorer-storage-v4',
    version: 1,

    storage: createStorageWrapper(
      storageAdapter,
      useWorker,
      workerStorage,
      shouldLog
    ) as PersistStorage<SerializedState>,

    partialize: (state) => serializeState(state),

    migrate: (rawPersistedState, version) => migrateState(rawPersistedState, version, shouldLog),

    merge: (persisted, current) =>
      mergeState(persisted as SerializedState | null, current, shouldLog),

    onRehydrateStorage: (state) => {
      if (shouldLog) {
        // Log summary only to avoid DevTools serialization issues
        logger.debug(
          'onRehydrateStorage - Storage rehydrated. Folder count:',
          Object.keys(state.folderStates).length,
          'Current folder:',
          state.currentFolderId
        );
      }
    },
  };
};
