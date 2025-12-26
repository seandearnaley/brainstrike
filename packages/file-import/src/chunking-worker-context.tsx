/**
 * ChunkingWorkerContext - React context for the chunking worker.
 *
 * This provides the chunking worker at the app root level, ensuring:
 * - Worker is initialized once, not on every component render
 * - Progress updates in child components don't re-invoke the worker
 * - Clean separation between worker lifecycle and UI state
 */

import { createLogger } from '@brainstrike/utils';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  type ChunkingBatchCallbacks,
  type ChunkingWorkerPort,
  createChunkingWorkerPort,
} from './chunking-worker-port';
import { resolveChunkingWorkerUrl } from './resolve-chunking-worker-url';

const logger = createLogger('ChunkingWorkerContext');

// ============================================================================
// Context Types
// ============================================================================

export type ChunkingWorkerContextValue = {
  /** The worker port for sending chunking requests (null if not ready) */
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

const ChunkingWorkerContext = createContext<ChunkingWorkerContextValue | null>(null);

// ============================================================================
// Provider Component
// ============================================================================

export type ChunkingWorkerProviderProps = {
  children: ReactNode;
};

/**
 * Provider component that initializes and manages the chunking worker.
 *
 * Place this at your app root to ensure the worker is initialized once
 * and shared across all components that need it.
 *
 * @example
 * ```tsx
 * // In your app root
 * <ChunkingWorkerProvider>
 *   <App />
 * </ChunkingWorkerProvider>
 *
 * // In any child component
 * const { port, isReady } = useChunkingWorkerContext();
 * ```
 */
export function ChunkingWorkerProvider({ children }: ChunkingWorkerProviderProps): ReactNode {
  const [isReady, setIsReady] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  // Track when port is created (separate from ready state)
  const [portCreated, setPortCreated] = useState(false);

  // Use refs for worker/port to avoid re-renders when they change
  const workerRef = useRef<Worker | null>(null);
  const portRef = useRef<ChunkingWorkerPort | null>(null);
  const initPromiseRef = useRef<Promise<void> | null>(null);

  const initialize = useCallback(async () => {
    // Prevent double initialization
    if (initPromiseRef.current) {
      return initPromiseRef.current;
    }

    initPromiseRef.current = (async () => {
      try {
        logger.debug('Initializing chunking worker');
        const workerUrl = await resolveChunkingWorkerUrl();
        const worker = new Worker(workerUrl, { type: 'module' });
        workerRef.current = worker;

        // Create port FIRST, before attaching message handlers.
        // This prevents a race condition where the "ready" message triggers
        // a re-render before portRef.current is set.
        const port = createChunkingWorkerPort(worker);
        portRef.current = port;
        setPortCreated(true);

        // Handle ready signal
        const handleMessage = (event: MessageEvent) => {
          if (event.data.type === 'ready') {
            logger.debug('Chunking worker ready');
            setIsReady(true);
            setError(null);
            worker.removeEventListener('message', handleMessage);
          } else if (event.data.type === 'error' && event.data.id === '__init__') {
            const errorMsg = event.data.error || 'Worker initialization failed';
            logger.error('Chunking worker init error', { error: errorMsg });
            setError(new Error(errorMsg));
            worker.removeEventListener('message', handleMessage);
          }
        };

        const handleError = (event: ErrorEvent) => {
          const errorDetails = {
            message: event.message || 'Unknown worker error',
            filename: event.filename || 'unknown',
            lineno: event.lineno || 0,
          };
          logger.error('Chunking worker error event', errorDetails);
          setError(new Error(errorDetails.message));
        };

        worker.addEventListener('message', handleMessage);
        worker.addEventListener('error', handleError);

        // Poll for ready state as backup
        const checkReadyInterval = setInterval(() => {
          if (port.isReady()) {
            setIsReady(true);
            clearInterval(checkReadyInterval);
          }
        }, 100);

        // Clear interval after 10s
        setTimeout(() => {
          clearInterval(checkReadyInterval);
          if (!portRef.current?.isReady()) {
            logger.warn('Worker ready timeout after 10s');
          }
        }, 10_000);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Failed to initialize worker';
        logger.error('Failed to initialize chunking worker', { error: errorMsg });
        setError(new Error(errorMsg));
      }
    })();

    return initPromiseRef.current;
  }, []);

  const reinitialize = useCallback(() => {
    logger.info('Reinitializing chunking worker');

    // Cleanup existing
    if (portRef.current) {
      portRef.current.terminate();
    }
    if (workerRef.current) {
      workerRef.current.terminate();
    }

    // Reset state
    workerRef.current = null;
    portRef.current = null;
    initPromiseRef.current = null;
    setIsReady(false);
    setPortCreated(false);
    setError(null);
    setIsProcessing(false);

    // Reinitialize
    void initialize();
  }, [initialize]);

  // Initialize on mount
  useEffect(() => {
    void initialize();

    // Cleanup on unmount - reset all state for React StrictMode double-mount
    return () => {
      if (portRef.current) {
        portRef.current.terminate();
      }
      if (workerRef.current) {
        workerRef.current.terminate();
      }
      // Reset refs so next mount starts fresh (StrictMode compatibility)
      workerRef.current = null;
      portRef.current = null;
      initPromiseRef.current = null;
    };
  }, [initialize]);

  // Create wrapped port that tracks processing state
  // This returns the port even when not ready - consumers should check isReady()
  // This prevents fallback to main thread when import starts before worker is ready
  const wrappedPort = useMemo((): ChunkingWorkerPort | null => {
    if (!portCreated) {
      return null;
    }
    const currentPort = portRef.current;
    if (!currentPort) {
      return null;
    }

    return {
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
        portRef.current = null;
        setIsReady(false);
      },
    };
    // Re-run when port becomes available (not just when ready)
    // This ensures port is returned as soon as it's created, even if not ready yet
    // Note: Using portCreated state instead of portRef.current because refs don't trigger re-renders
  }, [portCreated]);

  const contextValue = useMemo<ChunkingWorkerContextValue>(
    () => ({
      port: wrappedPort,
      isReady,
      isProcessing,
      error,
      reinitialize,
    }),
    [wrappedPort, isReady, isProcessing, error, reinitialize]
  );

  return (
    <ChunkingWorkerContext.Provider value={contextValue}>{children}</ChunkingWorkerContext.Provider>
  );
}

// ============================================================================
// Consumer Hook
// ============================================================================

/**
 * Hook to access the chunking worker from context.
 *
 * Must be used within a ChunkingWorkerProvider.
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const { port, isReady, error } = useChunkingWorkerContext();
 *
 *   if (error) return <div>Worker error: {error.message}</div>;
 *   if (!isReady) return <div>Loading worker...</div>;
 *
 *   // Use port.chunkFile() or port.chunkBatch()
 * }
 * ```
 */
export function useChunkingWorkerContext(): ChunkingWorkerContextValue {
  const context = useContext(ChunkingWorkerContext);

  if (!context) {
    throw new Error('useChunkingWorkerContext must be used within a ChunkingWorkerProvider');
  }

  return context;
}

/**
 * Hook to access just the chunking worker port from context.
 *
 * This is a convenience hook when you only need the port and don't
 * care about isReady/isProcessing/error states.
 *
 * Returns null if worker is not ready.
 */
export function useChunkingWorkerPort(): ChunkingWorkerPort | null {
  const { port } = useChunkingWorkerContext();
  return port;
}
