/**
 * File Explorer Persistence
 *
 * This module contains persistence configuration and utilities for the file explorer store.
 * It handles state serialization/deserialization and rehydration.
 */

import { createLogger } from '@brainstrike/logging';
import type {
  FileExplorerState,
  PersistenceRecoveryNotice,
  SerializedState,
} from '@brainstrike/types';
import type { PersistOptions } from 'zustand/middleware';
import { FILE_EXPLORER_STORAGE_KEY, FILE_EXPLORER_STORAGE_VERSION } from './persistence-constants';
import { migrateState, validateAndRecoverSerializedState } from './state-migration';
import { mergeState, serializeState } from './state-serialization';
import { detectTestEnvironment } from './test-environment';

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

/**
 * The Explorer's view state is renderer-only, so it persists through zustand's default
 * storage, this renderer's `localStorage` (Main's Factory Reset clears it). Writes are
 * synchronous: a change is saved when `set` returns. The store hydrates once it exists
 * (`skipHydration`, then {@link hydrateFileExplorerStore}), so a discard found while reading
 * can still land its recovery notice in the store.
 */
export const createPersistOptions = (): PersistOptions<FileExplorerState, SerializedState> => {
  let pendingRecoveryNotice: PersistenceRecoveryNotice | null = null;
  const recordPersistedStateDiscard = (): void => {
    pendingRecoveryNotice = 'persisted-state-discarded';
  };

  return {
    merge: (persisted, current) => {
      // `undefined` is "nothing saved"; a saved envelope whose state is `null` is a discard.
      if (persisted === null) {
        recordPersistedStateDiscard();
      }
      if (persisted === null || persisted === undefined) {
        return mergeState(null, current, shouldLog);
      }
      const validatedState = validateAndRecoverSerializedState(
        persisted,
        shouldLog,
        recordPersistedStateDiscard
      );
      return mergeState(validatedState, current, shouldLog);
    },

    migrate: (rawPersistedState, version) =>
      migrateState(rawPersistedState, version, shouldLog, recordPersistedStateDiscard),
    name: FILE_EXPLORER_STORAGE_KEY,

    onRehydrateStorage: (preHydrationState) => (state, error) => {
      // A saved value that is not JSON fails the read: the Explorer opens on defaults and
      // says so, and the next change overwrites the unreadable value.
      if (error) {
        recordPersistedStateDiscard();
      }
      if (pendingRecoveryNotice !== null) {
        const notice = pendingRecoveryNotice;
        pendingRecoveryNotice = null;
        preHydrationState.reportPersistedStateDiscard(notice);
      }
      if (!shouldLog) {
        return;
      }
      if (error) {
        logger.warn('onRehydrateStorage - Storage rehydration failed', {
          errorName: error instanceof Error ? error.name : typeof error,
        });
        return;
      }
      if (!isRehydratedFileExplorerState(state)) {
        logger.warn('onRehydrateStorage - Rehydrated state shape was invalid');
        return;
      }
      logger.debug(
        'onRehydrateStorage - Storage rehydrated. Folder count:',
        Object.keys(state.folderStates).length,
        'Has current folder:',
        state.currentFolderId !== null
      );
    },

    partialize: (state) => createPersistedFileExplorerSnapshot(state).state,
    skipHydration: true,
    version: FILE_EXPLORER_STORAGE_VERSION,
  };
};

/** Reads the saved state into a store made with {@link createPersistOptions}; synchronous. */
export function hydrateFileExplorerStore<Store extends { persist: { rehydrate: () => unknown } }>(
  store: Store
): Store {
  void store.persist.rehydrate();
  return store;
}
