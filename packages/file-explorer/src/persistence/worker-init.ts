import { createLogger } from '@brainstrike/utils';
import { WorkerStorage } from './worker-storage';

export type WorkerInitResult = {
  workerStorage: WorkerStorage | null;
  useWorker: boolean;
};

const logger = createLogger('Persistence');

function isHeadlessEnvironment(): boolean {
  const ciKey = 'CI';
  return (
    typeof navigator !== 'undefined' &&
    (navigator.webdriver === true ||
      navigator.userAgent.includes('HeadlessChrome') ||
      navigator.userAgent.includes('PhantomJS') ||
      'playwright' in globalThis ||
      (typeof process !== 'undefined' && process.env?.[ciKey] === 'true'))
  );
}

function isElectronEnvironment(): boolean {
  const electronKey = 'electron';
  return (
    (typeof window !== 'undefined' &&
      (window as { process?: { type?: string } }).process?.type === 'renderer') ||
    navigator?.userAgent.toLowerCase().includes('electron') ||
    (typeof globalThis !== 'undefined' && ('require' in globalThis || 'electron' in globalThis)) ||
    (typeof process !== 'undefined' && process.versions?.[electronKey] !== undefined)
  );
}

function getEnvironmentReason(isTest: boolean, isElectron: boolean, isHeadless: boolean): string {
  if (isTest) {
    return 'test environment';
  }
  if (isElectron) {
    return 'Electron environment';
  }
  if (isHeadless) {
    return 'headless/CI environment';
  }
  return 'SSR environment';
}

function tryInitializeWorker(shouldLog: boolean): {
  workerStorage: WorkerStorage | null;
  useWorker: boolean;
} {
  try {
    const workerStorage = new WorkerStorage();
    const useWorker = workerStorage.isWorkerAvailable;
    if (shouldLog && useWorker) {
      logger.debug('Web Worker enabled for background state persistence');
    }
    return { workerStorage, useWorker };
  } catch (error) {
    if (shouldLog) {
      logger.warn('Failed to initialize Web Worker, falling back to immediate approach:', error);
    }
    return { workerStorage: null, useWorker: false };
  }
}

function setupCleanupHandlers(workerStorage: WorkerStorage | null): void {
  if (typeof window !== 'undefined') {
    const handleBeforeUnload = () => {
      if (workerStorage) {
        workerStorage.destroy();
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('pagehide', handleBeforeUnload);
  }
}

export function initWorker(isTest: boolean, shouldLog: boolean): WorkerInitResult {
  const isHeadless = isHeadlessEnvironment();
  const isElectron = isElectronEnvironment();

  if (typeof window !== 'undefined' && !isTest && !isElectron && !isHeadless) {
    const { workerStorage, useWorker } = tryInitializeWorker(shouldLog);
    setupCleanupHandlers(workerStorage);
    return { workerStorage, useWorker };
  }

  if (shouldLog) {
    const reason = getEnvironmentReason(isTest, isElectron, isHeadless);
    logger.debug(`Web Worker disabled due to ${reason}, using immediate persistence`);
  }

  return { workerStorage: null, useWorker: false };
}
