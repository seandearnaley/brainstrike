import type { StorageAdapter } from '@brainstrike/storage';
import { createLogger } from '@brainstrike/utils/logger';
import { resolveWorkerStorageUrl, WorkerStorage } from './worker-storage';

export interface WorkerInitResult {
  useWorker: boolean;
  workerStorage: WorkerStorage | null;
}

const logger = createLogger('Persistence');

function getEnvironmentReason(isTest: boolean): string {
  if (isTest) {
    return 'test environment';
  }
  return 'SSR environment';
}

function tryInitializeWorker(
  storageAdapter: StorageAdapter,
  shouldLog: boolean
): {
  workerStorage: WorkerStorage | null;
  useWorker: boolean;
} {
  try {
    const workerUrl = resolveWorkerStorageUrl();
    const workerStorage = new WorkerStorage(workerUrl, storageAdapter);
    const useWorker = workerStorage.isWorkerAvailable;
    if (shouldLog && useWorker) {
      logger.debug('Web Worker enabled for background state persistence');
    }
    return { useWorker, workerStorage };
  } catch (error) {
    if (shouldLog) {
      logger.warn('Failed to initialize Web Worker, falling back to immediate approach:', error);
    }
    return { useWorker: false, workerStorage: null };
  }
}

function setupCleanupHandlers(workerStorage: WorkerStorage | null): void {
  if (typeof window !== 'undefined') {
    const flushPendingWrites = () => {
      workerStorage?.flushPendingWrites();
    };
    const handleBeforeUnload = () => {
      if (workerStorage) {
        flushPendingWrites();
        workerStorage.destroy();
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        flushPendingWrites();
      }
    };
    window.addEventListener('unload', handleBeforeUnload);
    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('pagehide', handleBeforeUnload);
    document.addEventListener('visibilitychange', handleVisibilityChange);
  }
}

export function initWorker(
  storageAdapter: StorageAdapter,
  isTest: boolean,
  shouldLog: boolean
): WorkerInitResult {
  if (typeof window !== 'undefined' && !isTest) {
    const { workerStorage, useWorker } = tryInitializeWorker(storageAdapter, shouldLog);
    setupCleanupHandlers(workerStorage);
    return { useWorker, workerStorage };
  }

  if (shouldLog) {
    const reason = getEnvironmentReason(isTest);
    logger.debug(`Web Worker disabled due to ${reason}, using immediate persistence`);
  }

  return { useWorker: false, workerStorage: null };
}
