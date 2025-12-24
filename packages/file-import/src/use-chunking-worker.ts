/**
 * useChunkingWorker - React hook for managing the chunking worker lifecycle.
 *
 * This hook:
 * - Creates and manages the Web Worker instance
 * - Provides a ChunkingWorkerPort for communicating with the worker
 * - Handles worker initialization and cleanup
 */

import { createLogger } from '@brainstrike/utils';
import { useCallback, useState, useSyncExternalStore } from 'react';
import {
  type ChunkingBatchCallbacks,
  type ChunkingWorkerPort,
  createChunkingWorkerPort,
} from './chunking-worker-port';
import { resolveChunkingWorkerUrl } from './resolve-chunking-worker-url';

const logger = createLogger('useChunkingWorker');

// ============================================================================
// MODULE-LEVEL SINGLETON - Initializes when module loads, not in React
// ============================================================================

let singletonWorker: Worker | null = null;
let singletonPort: ChunkingWorkerPort | null = null;
let singletonReady = false;
let singletonError: Error | null = null;
let singletonInitPromise: Promise<void> | null = null;
const singletonListeners: Set<() => void> = new Set();
let singletonVersion = 0;

function notifyListeners() {
  singletonVersion += 1;
  for (const listener of singletonListeners) {
    listener();
  }
}

async function initializeSingleton(): Promise<void> {
  if (singletonInitPromise) {
    return singletonInitPromise;
  }

  singletonInitPromise = (async () => {
    try {
      const workerUrl = await resolveChunkingWorkerUrl();
      const worker = new Worker(workerUrl, { type: 'module' });
      singletonWorker = worker;

      // Handle ready signal
      const handleMessage = (event: MessageEvent) => {
        if (event.data.type === 'ready') {
          logger.debug('Chunking worker ready');
          singletonReady = true;
          singletonError = null;
          worker.removeEventListener('message', handleMessage);
          notifyListeners();
        } else if (event.data.type === 'error' && event.data.id === '__init__') {
          const errorMsg = event.data.error || 'Worker initialization failed';
          logger.error('Chunking worker init error', { error: errorMsg });
          singletonError = new Error(errorMsg);
          worker.removeEventListener('message', handleMessage);
          notifyListeners();
        }
      };

      const handleError = (event: ErrorEvent) => {
        const errorDetails = {
          message: event.message || 'Unknown worker error (script may have failed to load)',
          filename: event.filename || 'unknown',
          lineno: event.lineno || 0,
          colno: event.colno || 0,
        };
        logger.error('Chunking worker error event', errorDetails);
        singletonError = new Error(errorDetails.message);
        notifyListeners();
      };

      worker.addEventListener('message', handleMessage);
      worker.addEventListener('error', handleError);

      const port = createChunkingWorkerPort(worker);
      singletonPort = port;

      // Also poll for ready state
      const checkReadyInterval = setInterval(() => {
        if (port.isReady()) {
          singletonReady = true;
          clearInterval(checkReadyInterval);
          notifyListeners();
        }
      }, 100);

      // Clear interval after 10s regardless
      setTimeout(() => {
        clearInterval(checkReadyInterval);
        if (!singletonReady) {
          logger.warn('Worker ready timeout after 10s');
        }
      }, 10_000);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to initialize worker';
      logger.error('Failed to initialize chunking worker singleton', { error: errorMsg });
      singletonError = new Error(errorMsg);
      notifyListeners();
    }
  })();

  return singletonInitPromise;
}

// Start initialization immediately when module loads
initializeSingleton().catch((err) => {
  logger.error('Singleton initialization promise rejected', {
    error: err instanceof Error ? err.message : String(err),
  });
});

// ============================================================================
// React Hook - Just returns singleton state
// ============================================================================

export type UseChunkingWorkerResult = {
  /** The worker port for sending chunking requests */
  port: ChunkingWorkerPort | null;
  /** Whether the worker is ready to receive requests */
  isReady: boolean;
  /** Whether the worker is currently processing a request */
  isProcessing: boolean;
  /** Any error that occurred during worker initialization */
  error: Error | null;
  /** Reinitialize the worker (e.g., after an error) */
  reinitialize: () => void;
};

/**
 * React hook for managing the chunking worker lifecycle.
 * Uses a module-level singleton worker for better reliability.
 */
export function useChunkingWorker(): UseChunkingWorkerResult {
  // NOTE: No logging here - this runs on every render and would spam logs

  const [isProcessing, setIsProcessing] = useState(false);
  const subscribe = useCallback((listener: () => void) => {
    singletonListeners.add(listener);
    return () => {
      singletonListeners.delete(listener);
    };
  }, []);
  const getSnapshot = useCallback(() => singletonVersion, []);
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const reinitialize = useCallback(() => {
    logger.info('Reinitializing chunking worker singleton');
    if (singletonPort) {
      singletonPort.terminate();
    }
    if (singletonWorker) {
      singletonWorker.terminate();
    }
    singletonWorker = null;
    singletonPort = null;
    singletonReady = false;
    singletonError = null;
    singletonInitPromise = null;
    void initializeSingleton();
  }, []);

  // Wrap port methods to track processing state
  const currentPort = singletonPort;
  const wrappedPort: ChunkingWorkerPort | null = currentPort
    ? {
        chunkFile: async (...args) => {
          setIsProcessing(true);
          try {
            return await currentPort.chunkFile(...args);
          } finally {
            setIsProcessing(false);
          }
        },
        chunkBatch: async (files, options, callbacks?: ChunkingBatchCallbacks) => {
          setIsProcessing(true);
          try {
            return await currentPort.chunkBatch(files, options, callbacks);
          } finally {
            setIsProcessing(false);
          }
        },
        isReady: () => currentPort.isReady(),
        terminate: () => {
          currentPort.terminate();
          singletonPort = null;
          singletonReady = false;
        },
      }
    : null;

  return {
    port: wrappedPort,
    isReady: singletonReady,
    isProcessing,
    error: singletonError,
    reinitialize,
  };
}

/**
 * Create a standalone chunking worker port (without React).
 *
 * Useful for non-React contexts or when you need direct control.
 *
 * @example
 * ```ts
 * const { port, waitForReady, terminate } = await createStandaloneChunkingWorker();
 * await waitForReady();
 *
 * const result = await port.chunkFile(...);
 *
 * terminate();
 * ```
 */
export async function createStandaloneChunkingWorker(): Promise<{
  port: ChunkingWorkerPort;
  waitForReady: () => Promise<void>;
  terminate: () => void;
}> {
  const workerUrl = await resolveChunkingWorkerUrl();
  const worker = new Worker(workerUrl, { type: 'module' });
  const port = createChunkingWorkerPort(worker);

  const waitForReady = (): Promise<void> =>
    new Promise((resolve, reject) => {
      if (port.isReady()) {
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('Worker ready timeout'));
      }, 10_000);

      const checkReady = () => {
        if (port.isReady()) {
          clearTimeout(timeout);
          clearInterval(interval);
          resolve();
        }
      };

      const interval = setInterval(checkReady, 100);
    });

  const terminate = () => {
    port.terminate();
    worker.terminate();
  };

  return { port, waitForReady, terminate };
}
