import type { StorageAdapter } from '@brainstrike/storage';
import { createLogger } from '@brainstrike/utils';
import type { WorkerStorage } from './worker-storage';

const logger = createLogger('Persistence');

async function getItemFromWorker(workerStorage: WorkerStorage, name: string): Promise<unknown> {
  const value = await workerStorage.getItem(name);
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    return JSON.parse(value);
  }
  return value;
}

async function getItemFromStorage(storageAdapter: StorageAdapter, name: string): Promise<unknown> {
  const value = await storageAdapter.getItem(name);
  return value ? JSON.parse(value) : null;
}

async function getItemWithWorkerFallback(
  workerStorage: WorkerStorage,
  storageAdapter: StorageAdapter,
  name: string,
  shouldLog: boolean
): Promise<unknown> {
  try {
    return await getItemFromWorker(workerStorage, name);
  } catch (error) {
    if (shouldLog) {
      logger.error('Worker getItem failed, falling back to main thread:', error);
    }
    return await getItemFromStorage(storageAdapter, name);
  }
}

async function getItemWithStorageOnly(
  storageAdapter: StorageAdapter,
  name: string,
  shouldLog: boolean
): Promise<unknown> {
  try {
    return await getItemFromStorage(storageAdapter, name);
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
): Promise<void> {
  try {
    await workerStorage.setItem(name, value);
  } catch (error) {
    if (shouldLog) {
      logger.error('Worker setItem failed, falling back to immediate approach:', error);
    }
    await storageAdapter.setItem(name, JSON.stringify(value));
  }
}

async function setItemWithStorage(
  storageAdapter: StorageAdapter,
  name: string,
  value: unknown
): Promise<void> {
  await storageAdapter.setItem(name, JSON.stringify(value));
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
        await setItemWithWorker(workerStorage, storageAdapter, name, value, shouldLog);
      } else {
        try {
          await setItemWithStorage(storageAdapter, name, value);
        } catch (error) {
          if (shouldLog) {
            logger.error('Error setting item in storage:', error);
          }
        }
      }
    },
    removeItem: async (name: string) => {
      try {
        await storageAdapter.removeItem(name);
      } catch (error) {
        if (shouldLog) {
          logger.error('Error removing item from storage:', error);
        }
      }
    },
  };
}
