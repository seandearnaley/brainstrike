import { createLogger } from '@brainstrike/logging';
import type { StorageAdapter } from '@brainstrike/storage';

const logger = createLogger('Persistence');

export type PersistedStateDiscardReason = 'malformed-value' | 'unavailable-read';

export type StorageOperationResult =
  | { success: true }
  | { success: false; message: string; error: unknown };

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const getErrorMetadata = (error: unknown, name: string): { errorName: string; name: string } => ({
  errorName: error instanceof Error ? error.name : typeof error,
  name,
});

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

async function setItemWithStorage(
  storageAdapter: StorageAdapter,
  name: string,
  value: unknown
): Promise<StorageOperationResult> {
  try {
    await storageAdapter.setItem(name, JSON.stringify(value));
    return { success: true };
  } catch (error) {
    return { error, message: getErrorMessage(error), success: false };
  }
}

export function createStorageWrapper(
  storageAdapter: StorageAdapter,
  shouldLog: boolean,
  onDiscard?: (reason?: PersistedStateDiscardReason) => void
) {
  return {
    getItem: async (name: string) =>
      await getItemWithStorageOnly(storageAdapter, name, shouldLog, onDiscard),
    removeItem: async (name: string) => {
      try {
        await storageAdapter.removeItem(name);
        return { success: true };
      } catch (error) {
        if (shouldLog) {
          logger.error('Error removing item from storage:', getErrorMetadata(error, name));
        }
        return { error, message: getErrorMessage(error), success: false };
      }
    },
    setItem: async (name: string, value: unknown) => {
      const result = await setItemWithStorage(storageAdapter, name, value);
      if (!result.success && shouldLog) {
        logger.error('Error setting item in storage:', getErrorMetadata(result.error, name));
      }
      return result;
    },
  };
}
