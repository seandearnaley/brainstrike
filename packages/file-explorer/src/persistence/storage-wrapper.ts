import type { StorageAdapter } from '@brainstrike/storage';
import { createLogger } from '@brainstrike/utils';
import type { WorkerStorage } from './worker-storage';

const logger = createLogger('Persistence');

export type StorageOperationResult =
  | { success: true }
  | { success: false; message: string; error: unknown };

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

async function getItemFromWorker(
  workerStorage: WorkerStorage,
  name: string,
  shouldLog: boolean
): Promise<unknown> {
  const value = await workerStorage.getItem(name);
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (error) {
      if (shouldLog) {
        logger.error('Invalid JSON from worker storage; ignoring value', { name, error });
      }
      return null;
    }
  }
  return value;
}

async function getItemFromStorage(
  storageAdapter: StorageAdapter,
  name: string,
  shouldLog: boolean
): Promise<unknown> {
  const value = await storageAdapter.getItem(name);
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    if (shouldLog) {
      logger.error('Invalid JSON from storage adapter; clearing value', { name, error });
    }
    try {
      await storageAdapter.removeItem(name);
    } catch (removeError) {
      if (shouldLog) {
        logger.error('Failed to remove invalid storage entry', { name, error: removeError });
      }
    }
    return null;
  }
}

async function getItemWithWorkerFallback(
  workerStorage: WorkerStorage,
  storageAdapter: StorageAdapter,
  name: string,
  shouldLog: boolean
): Promise<unknown> {
  try {
    return await getItemFromWorker(workerStorage, name, shouldLog);
  } catch (error) {
    if (shouldLog) {
      logger.error('Worker getItem failed, falling back to main thread:', error);
    }
    return await getItemFromStorage(storageAdapter, name, shouldLog);
  }
}

async function getItemWithStorageOnly(
  storageAdapter: StorageAdapter,
  name: string,
  shouldLog: boolean
): Promise<unknown> {
  try {
    return await getItemFromStorage(storageAdapter, name, shouldLog);
  } catch (error) {
    if (shouldLog) {
      logger.error('Error getting item from storage:', error);
    }
    return null;
  }
}

async function setItemWithWorker(
  workerStorage: WorkerStorage,
  storageAdapter: StorageAdapter,
  name: string,
  value: unknown,
  shouldLog: boolean
): Promise<StorageOperationResult> {
  try {
    await workerStorage.setItem(name, value);
    return { success: true };
  } catch (error) {
    if (shouldLog) {
      logger.error('Worker setItem failed, falling back to immediate approach:', error);
    }
    try {
      await storageAdapter.setItem(name, JSON.stringify(value));
      return { success: true };
    } catch (fallbackError) {
      if (shouldLog) {
        logger.error('Error setting item in storage:', fallbackError);
      }
      return { success: false, message: getErrorMessage(fallbackError), error: fallbackError };
    }
  }
}

async function setItemWithStorage(
  storageAdapter: StorageAdapter,
  name: string,
  value: unknown
): Promise<StorageOperationResult> {
  try {
    await storageAdapter.setItem(name, JSON.stringify(value));
    return { success: true };
  } catch (error) {
    return { success: false, message: getErrorMessage(error), error };
  }
}

export function createStorageWrapper(
  storageAdapter: StorageAdapter,
  useWorker: boolean,
  workerStorage: WorkerStorage | null,
  shouldLog: boolean
) {
  return {
    getItem: async (name: string) => {
      if (useWorker && workerStorage) {
        return await getItemWithWorkerFallback(workerStorage, storageAdapter, name, shouldLog);
      }
      return await getItemWithStorageOnly(storageAdapter, name, shouldLog);
    },
    setItem: async (name: string, value: unknown) => {
      if (useWorker && workerStorage) {
        return await setItemWithWorker(workerStorage, storageAdapter, name, value, shouldLog);
      }
      const result = await setItemWithStorage(storageAdapter, name, value);
      if (!result.success && shouldLog) {
        logger.error('Error setting item in storage:', result.error);
      }
      return result;
    },
    removeItem: async (name: string) => {
      try {
        await storageAdapter.removeItem(name);
        return { success: true };
      } catch (error) {
        if (shouldLog) {
          logger.error('Error removing item from storage:', error);
        }
        return { success: false, message: getErrorMessage(error), error };
      }
    },
  };
}
