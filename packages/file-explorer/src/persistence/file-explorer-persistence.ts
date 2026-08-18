/**
 * File Explorer Persistence
 *
 * This module contains persistence configuration and utilities for the file explorer store.
 * It handles state serialization/deserialization and rehydration.
 */

import { createLogger } from '@brainstrike/logging';
import type { StorageAdapter } from '@brainstrike/storage';
import type {
  FileExplorerState,
  PersistenceRecoveryNotice,
  SerializedState,
} from '@brainstrike/types';
import type { PersistOptions, PersistStorage } from 'zustand/middleware';
import { FILE_EXPLORER_STORAGE_KEY, FILE_EXPLORER_STORAGE_VERSION } from './persistence-constants';
import {
  isSerializedStateCandidate,
  migrateState,
  validateAndRecoverSerializedState,
} from './state-migration';
import { mergeState, serializeState } from './state-serialization';
import { createStorageWrapper, type PersistedStateDiscardReason } from './storage-wrapper';
import { detectTestEnvironment } from './test-environment';
import { initWorker } from './worker-init';

const logger = createLogger('Persistence');

const NODE_ENV_KEY = 'NODE_ENV';
const nodeEnv = globalThis.process?.env?.[NODE_ENV_KEY];
const isDev = nodeEnv !== 'production';

const isTest = detectTestEnvironment();
const shouldLog = isDev && !isTest;

function isPersistEnvelope(value: unknown): value is { state: unknown; version?: number } {
  if (!(value && typeof value === 'object' && !Array.isArray(value))) {
    return false;
  }
  const envelope = value as Record<string, unknown>;
  const version = envelope['version'];
  return (
    'state' in envelope &&
    envelope['state'] !== null &&
    typeof envelope['state'] === 'object' &&
    !Array.isArray(envelope['state']) &&
    (version === undefined ||
      (typeof version === 'number' && Number.isInteger(version) && Number.isFinite(version)))
  );
}

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
  let pendingRecoveryNotice: PersistenceRecoveryNotice | null = null;
  let currentReadWasUnavailable = false;
  let recoveryProbeValueJson: string | null = null;
  let shouldPreserveUnreadSnapshot = false;
  let storageReadDidDiscard = false;
  let unreadHydratedValueJson: string | null = null;
  const recordPersistedStateDiscard = (reason?: PersistedStateDiscardReason): void => {
    pendingRecoveryNotice =
      reason === 'unavailable-read' ? 'persisted-state-unavailable' : 'persisted-state-discarded';
    if (reason !== undefined) {
      storageReadDidDiscard = true;
    }
    if (reason === 'unavailable-read') {
      currentReadWasUnavailable = true;
      shouldPreserveUnreadSnapshot = true;
    }
  };

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
        logger.warn('Could not perform legacy settings migration', {
          errorName: error instanceof Error ? error.name : typeof error,
        });
      }
    }
  }

  const persistedStorage = createStorageWrapper(
    storageAdapter,
    useWorker,
    workerStorage,
    shouldLog,
    recordPersistedStateDiscard
  ) as PersistStorage<SerializedState>;
  const shouldSkipUnreadSnapshotWrite = async (
    name: string,
    valueJson: string
  ): Promise<boolean> => {
    if (!shouldPreserveUnreadSnapshot) {
      return false;
    }
    unreadHydratedValueJson ??= valueJson;
    currentReadWasUnavailable = false;
    await persistedStorage.getItem(name);
    if (currentReadWasUnavailable) {
      if (shouldLog) {
        logger.debug('Skipping persistence write while prior snapshot remains unread', {
          name,
        });
      }
      return true;
    }
    shouldPreserveUnreadSnapshot = false;
    recoveryProbeValueJson = unreadHydratedValueJson;
    unreadHydratedValueJson = null;
    return false;
  };
  const validatedPersistedStorage: PersistStorage<SerializedState> = {
    ...persistedStorage,
    getItem: async (name) => {
      currentReadWasUnavailable = false;
      const envelope = (await persistedStorage.getItem(name)) as unknown;
      if (!currentReadWasUnavailable) {
        shouldPreserveUnreadSnapshot = false;
      }
      if (name !== FILE_EXPLORER_STORAGE_KEY || envelope === null || isPersistEnvelope(envelope)) {
        return envelope as Awaited<ReturnType<PersistStorage<SerializedState>['getItem']>>;
      }
      if (isSerializedStateCandidate(envelope)) {
        return {
          state: validateAndRecoverSerializedState(
            envelope,
            shouldLog,
            recordPersistedStateDiscard
          ),
          version: FILE_EXPLORER_STORAGE_VERSION,
        };
      }

      recordPersistedStateDiscard('malformed-value');
      if (shouldLog) {
        logger.error('Persisted storage envelope missing state; clearing value', { name });
      }
      await persistedStorage.removeItem(name);
      return null;
    },
    setItem: async (name, value) => {
      if (name === FILE_EXPLORER_STORAGE_KEY) {
        const valueJson = JSON.stringify(value);
        if (await shouldSkipUnreadSnapshotWrite(name, valueJson)) {
          return;
        }
        if (recoveryProbeValueJson !== null) {
          const isRepeatedRecoveryWrite = valueJson === recoveryProbeValueJson;
          recoveryProbeValueJson = null;
          if (isRepeatedRecoveryWrite) {
            return;
          }
        }
      }
      await persistedStorage.setItem(name, value);
    },
  };

  return {
    merge: (persisted, current) => {
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
      const failureStage = storageReadDidDiscard ? 'storage-read' : 'merge-or-set';
      if (pendingRecoveryNotice !== null) {
        const notice = pendingRecoveryNotice;
        pendingRecoveryNotice = null;
        preHydrationState.reportPersistedStateDiscard(notice);
      }
      storageReadDidDiscard = false;
      if (!shouldLog) {
        return;
      }
      if (error) {
        logger.warn('onRehydrateStorage - Storage rehydration failed', {
          errorName: error instanceof Error ? error.name : typeof error,
          stage: failureStage,
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

    storage: validatedPersistedStorage,
    version: FILE_EXPLORER_STORAGE_VERSION,
  };
};
