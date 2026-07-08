/**
 * useChunkingWorker - React hook for managing the chunking worker lifecycle.
 *
 * This hook:
 * - Creates and manages the Web Worker instance
 * - Provides a ChunkingWorkerPort for communicating with the worker
 * - Handles worker initialization and cleanup
 */

import { createLogger } from '@brainstrike/utils/logger';
import { useCallback, useState, useSyncExternalStore } from 'react';
import {
  type ChunkingBatchCallbacks,
  type ChunkingWorkerPort,
  createChunkingWorkerPort,
} from './chunking-worker-port';
import { resolveChunkingWorkerUrl } from './resolve-chunking-worker-url';

const logger = createLogger('useChunkingWorker');
const CHUNKING_WORKER_READY_TIMEOUT_MS = 30_000;

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
// Guard async worker callbacks against reinitialize() races so stale workers
// cannot overwrite the singleton state after a newer generation has started.
let singletonGeneration = 0;

function notifyListeners() {
  singletonVersion += 1;
  for (const listener of singletonListeners) {
    listener();
  }
}

async function initializeSingleton(): Promise<void> {
  // If already initialized or initialization is in progress, return existing promise
  if (singletonInitPromise) {
    return singletonInitPromise;
  }

  // CRITICAL: Create and store the promise synchronously to prevent race conditions.
  // Any concurrent calls will see this promise and return it immediately.
  const generation = ++singletonGeneration;
  singletonInitPromise = (async () => {
    try {
      const workerUrl = await resolveChunkingWorkerUrl();
      const worker = new Worker(workerUrl, { type: 'module' });
      singletonWorker = worker;

      // Handle ready signal
      const handleMessage = (event: MessageEvent) => {
        if (generation !== singletonGeneration) {
          return;
        }
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
          worker.removeEventListener('error', handleError);
          notifyListeners();
        }
      };

      const handleError = (event: ErrorEvent) => {
        if (generation !== singletonGeneration) {
          return;
        }
        const errorDetails = {
          colno: event.colno || 0,
          filename: event.filename || 'unknown',
          lineno: event.lineno || 0,
          message: event.message || 'Unknown worker error (script may have failed to load)',
          timestamp: new Date().toISOString(),
          workerUrl,
        };
        logger.error('Chunking worker error event', errorDetails);
        // Include full details in error message for debugging
        const detailedMessage =
          `Chunking worker error: ${errorDetails.message} ` +
          `(file: ${errorDetails.filename}:${errorDetails.lineno}:${errorDetails.colno})`;
        singletonError = new Error(detailedMessage);
        singletonReady = false;
        worker.removeEventListener('error', handleError);
        worker.removeEventListener('message', handleMessage);
        // CRITICAL: Hard-stop on worker runtime errors to avoid degraded behavior.
        if (singletonPort) {
          singletonPort.terminate();
          singletonPort = null;
        }
        if (singletonWorker) {
          singletonWorker.terminate();
          singletonWorker = null;
        }
        // Attach details as a property for programmatic access
        (singletonError as Error & { details?: typeof errorDetails }).details = errorDetails;
        notifyListeners();
      };

      worker.addEventListener('message', handleMessage);
      worker.addEventListener('error', handleError);

      const port = createChunkingWorkerPort(worker);
      singletonPort = port;

      // Cold-starting the chunking worker can legitimately take longer than a normal
      // UI interaction because the worker bundle is large and parsed off-thread.
      // Use a deterministic but generous timeout so we fail only on a real hang.
      setTimeout(() => {
        if (!(singletonReady || singletonError)) {
          const errorDetails = {
            message: `Chunking worker failed to become ready within ${CHUNKING_WORKER_READY_TIMEOUT_MS / 1000} seconds`,
            portExists: !!singletonPort,
            timestamp: new Date().toISOString(),
            workerExists: !!singletonWorker,
            workerUrl,
          };
          logger.error('Chunking worker ready timeout', errorDetails);
          const detailedMessage =
            `${errorDetails.message}. ` +
            `Worker URL: ${errorDetails.workerUrl}, ` +
            `worker: ${errorDetails.workerExists}, port: ${errorDetails.portExists}`;
          singletonError = new Error(detailedMessage);
          singletonReady = false;
          // CRITICAL: Startup timeout is terminal for this worker instance.
          if (singletonPort) {
            singletonPort.terminate();
            singletonPort = null;
          }
          if (singletonWorker) {
            singletonWorker.terminate();
            singletonWorker = null;
          }
          (singletonError as Error & { details?: typeof errorDetails }).details = errorDetails;
          notifyListeners();
        }
      }, CHUNKING_WORKER_READY_TIMEOUT_MS);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to initialize worker';
      logger.error('Failed to initialize chunking worker singleton', { error: errorMsg });
      singletonError = new Error(errorMsg);
      notifyListeners();
    }
  })();

  return singletonInitPromise;
}

// Note: Initialization is lazy - happens when hook is first called
// This allows tests to mock the module before initialization occurs

// ============================================================================
// React Hook - Just returns singleton state
// ============================================================================

export interface UseChunkingWorkerResult {
  /** Any error that occurred during worker initialization */
  error: Error | null;
  /** Whether the worker is currently processing a request */
  isProcessing: boolean;
  /** Whether the worker is ready to receive requests */
  isReady: boolean;
  /** The worker port for sending chunking requests */
  port: ChunkingWorkerPort | null;
  /** Reinitialize the worker (e.g., after an error) */
  reinitialize: () => void;
}

/**
 * React hook for managing the chunking worker lifecycle.
 * Uses a module-level singleton worker for better reliability.
 */
export function useChunkingWorker(): UseChunkingWorkerResult {
  // NOTE: No logging here - this runs on every render and would spam logs

  const [isProcessing, setIsProcessing] = useState(false);

  // Lazy initialization - only happens when hook is first called (not at module load)
  // This allows tests to mock the module before initialization
  if (!singletonInitPromise) {
    void initializeSingleton();
  }

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
        chunkBatch: async (files, options, callbacks?: ChunkingBatchCallbacks) => {
          setIsProcessing(true);
          try {
            return await currentPort.chunkBatch(files, options, callbacks);
          } finally {
            setIsProcessing(false);
          }
        },
        chunkFile: async (...args) => {
          setIsProcessing(true);
          try {
            return await currentPort.chunkFile(...args);
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
        transportKind: currentPort.transportKind,
      }
    : null;

  return {
    error: singletonError,
    isProcessing,
    isReady: singletonReady,
    port: wrappedPort,
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

      const cleanup = () => {
        clearTimeout(timeout);
        worker.removeEventListener('message', onMessage);
      };

      const onMessage = (event: MessageEvent) => {
        if (event.data.type === 'ready') {
          cleanup();
          resolve();
        } else if (event.data.type === 'error' && event.data.id === '__init__') {
          cleanup();
          reject(new Error(event.data.error || 'Worker initialization failed'));
        }
      };

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Worker ready timeout'));
      }, CHUNKING_WORKER_READY_TIMEOUT_MS);

      worker.addEventListener('message', onMessage);
    });

  const terminate = () => {
    port.terminate();
    worker.terminate();
  };

  return { port, terminate, waitForReady };
}
