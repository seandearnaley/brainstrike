import { createLogger, proofPersistence } from '@brainstrike/logging';
import type { StorageAdapter } from '@brainstrike/storage';
import type { WorkerStorage } from './worker-storage';

const logger = createLogger('Persistence');

export type PersistedStateDiscardReason = 'malformed-value' | 'unavailable-read';

export interface StorageOperationResult {
  success: true;
}

const getErrorMetadata = (error: unknown, name: string): { errorName: string; name: string } => ({
  errorName: error instanceof Error ? error.name : typeof error,
  name,
});

async function getItemFromWorker(
  workerStorage: WorkerStorage,
  storageAdapter: StorageAdapter,
  name: string,
  shouldLog: boolean,
  onDiscard?: (reason?: PersistedStateDiscardReason) => void
): Promise<unknown> {
  const value = await workerStorage.getItem(name);
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      onDiscard?.('malformed-value');
      if (shouldLog) {
        logger.error('Invalid JSON from worker storage; clearing value', { name });
      }
      try {
        await storageAdapter.removeItem(name);
      } catch (removeError) {
        if (shouldLog) {
          logger.error('Failed to remove invalid storage entry', {
            errorName: removeError instanceof Error ? removeError.name : typeof removeError,
            name,
          });
        }
      }
      return null;
    }
  }
  return value;
}

async function getItemFromStorage(
  storageAdapter: StorageAdapter,
  name: string,
  shouldLog: boolean,
  onDiscard?: (reason?: PersistedStateDiscardReason) => void
): Promise<unknown> {
  const value = await storageAdapter.getItem(name);
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    onDiscard?.('malformed-value');
    if (shouldLog) {
      logger.error('Invalid JSON from storage adapter; clearing value', { name });
    }
    try {
      await storageAdapter.removeItem(name);
    } catch (removeError) {
      if (shouldLog) {
        logger.error('Failed to remove invalid storage entry', {
          errorName: removeError instanceof Error ? removeError.name : typeof removeError,
          name,
        });
      }
    }
    return null;
  }
}

async function getItemWithWorkerFallback(
  workerStorage: WorkerStorage,
  storageAdapter: StorageAdapter,
  name: string,
  shouldLog: boolean,
  onDiscard?: (reason?: PersistedStateDiscardReason) => void
): Promise<unknown> {
  try {
    return await getItemFromWorker(workerStorage, storageAdapter, name, shouldLog, onDiscard);
  } catch (error) {
    if (shouldLog) {
      logger.error(
        'Worker getItem failed, falling back to main thread',
        getErrorMetadata(error, name)
      );
    }
    return await getItemWithStorageOnly(storageAdapter, name, shouldLog, onDiscard);
  }
}

async function getItemWithStorageOnly(
  storageAdapter: StorageAdapter,
  name: string,
  shouldLog: boolean,
  onDiscard?: (reason?: PersistedStateDiscardReason) => void
): Promise<unknown> {
  try {
    return await getItemFromStorage(storageAdapter, name, shouldLog, onDiscard);
  } catch (firstError) {
    if (shouldLog) {
      logger.debug(
        'Retrying storage read after adapter failure',
        getErrorMetadata(firstError, name)
      );
    }
    try {
      return await getItemFromStorage(storageAdapter, name, shouldLog, onDiscard);
    } catch (finalError) {
      onDiscard?.('unavailable-read');
      if (shouldLog) {
        logger.error('Error getting item from storage', getErrorMetadata(finalError, name));
      }
      return null;
    }
  }
}

async function setItemWithWorker(
  workerStorage: WorkerStorage,
  name: string,
  value: unknown,
  shouldLog: boolean
): Promise<StorageOperationResult> {
  const operationId = proofPersistence('wrapper-save-start', {
    layer: 'storage-wrapper',
    object: workerStorage,
  });
  try {
    await workerStorage.setItem(name, value);
    proofPersistence('wrapper-save-ack', { layer: 'storage-wrapper', operationId });
    return { success: true };
  } catch (error) {
    proofPersistence('wrapper-save-rejected', {
      layer: 'storage-wrapper',
      operationId,
      reason: error,
    });
    if (shouldLog) {
      logger.error('Worker setItem failed:', getErrorMetadata(error, name));
    }
    throw error;
  }
}

async function setItemWithStorage(
  storageAdapter: StorageAdapter,
  name: string,
  value: unknown
): Promise<StorageOperationResult> {
  await storageAdapter.setItem(name, JSON.stringify(value));
  return { success: true };
}

export function createStorageWrapper(
  storageAdapter: StorageAdapter,
  useWorker: boolean,
  workerStorage: WorkerStorage | null,
  shouldLog: boolean,
  onDiscard?: (reason?: PersistedStateDiscardReason) => void
) {
  return {
    getItem: async (name: string) => {
      if (useWorker && workerStorage) {
        return await getItemWithWorkerFallback(
          workerStorage,
          storageAdapter,
          name,
          shouldLog,
          onDiscard
        );
      }
      return await getItemWithStorageOnly(storageAdapter, name, shouldLog, onDiscard);
    },
    removeItem: async (name: string) => {
      try {
        if (useWorker && workerStorage) {
          await workerStorage.removeItem(name);
        } else {
          await storageAdapter.removeItem(name);
        }
        return { success: true };
      } catch (error) {
        if (shouldLog) {
          logger.error('Error removing item from storage:', getErrorMetadata(error, name));
        }
        throw error;
      }
    },
    setItem: async (name: string, value: unknown) => {
      if (useWorker && workerStorage) {
        return await setItemWithWorker(workerStorage, name, value, shouldLog);
      }
      try {
        return await setItemWithStorage(storageAdapter, name, value);
      } catch (error) {
        if (shouldLog) {
          logger.error('Error setting item in storage:', getErrorMetadata(error, name));
        }
        throw error;
      }
    },
  };
}
