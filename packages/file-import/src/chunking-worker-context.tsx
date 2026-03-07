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

const TERMINAL_TOKENIZER_ERROR_PATTERNS: RegExp[] = [
  /^accurate token counting unavailable:/i,
  /^accurate token counting failed:/i,
  /tiktoken encoder failed to initialize/i,
];

function normalizeTerminalErrorMessage(errorMessage: string): string {
  return errorMessage.trim().replace(/^error:\s*/i, '');
}

function isTerminalTokenizerError(errorMessage: string): boolean {
  const normalized = normalizeTerminalErrorMessage(errorMessage);
  return TERMINAL_TOKENIZER_ERROR_PATTERNS.some((pattern) => pattern.test(normalized));
}

interface WorkerErrorMessage {
  error: string;
  fileRecordId?: string;
  id?: string;
  type: 'error';
}

function isWorkerErrorMessage(data: unknown): data is WorkerErrorMessage {
  if (typeof data !== 'object' || data === null) {
    return false;
  }

  const candidate = data as Partial<WorkerErrorMessage>;
  return candidate.type === 'error' && typeof candidate.error === 'string';
}

function isInitWorkerErrorMessage(data: unknown): data is WorkerErrorMessage {
  return isWorkerErrorMessage(data) && data.id === '__init__';
}

function getTerminalTokenizerErrorMessage(data: unknown): WorkerErrorMessage | null {
  if (!isWorkerErrorMessage(data)) {
    return null;
  }

  return isTerminalTokenizerError(data.error) ? data : null;
}

// ============================================================================
// Context Types
// ============================================================================

export interface ChunkingWorkerContextValue {
  /** Start the worker if it has not been created yet */
  ensureStarted: () => Promise<ChunkingWorkerPort>;
  /** Any error that occurred during worker initialization */
  error: Error | null;
  /** Whether the worker is currently processing a request */
  isProcessing: boolean;
  /** Whether the worker is ready to receive requests */
  isReady: boolean;
  /** The worker port for sending chunking requests (null if not ready) */
  port: ChunkingWorkerPort | null;
  /** Reinitialize the worker (e.g., after an error) */
  reinitialize: () => void;
}

const ChunkingWorkerContext = createContext<ChunkingWorkerContextValue | null>(null);

// ============================================================================
// Provider Component
// ============================================================================

export interface ChunkingWorkerProviderProps {
  autoStart?: boolean;
  children: ReactNode;
}

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
export function ChunkingWorkerProvider({
  autoStart = true,
  children,
}: ChunkingWorkerProviderProps): ReactNode {
  const [isReady, setIsReady] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  // Track the port in state so useMemo doesn't need to read from ref during render
  const [currentPortState, setCurrentPortState] = useState<ChunkingWorkerPort | null>(null);

  // Use refs for worker/port to avoid re-renders when they change
  const workerRef = useRef<Worker | null>(null);
  const portRef = useRef<ChunkingWorkerPort | null>(null);
  const initPromiseRef = useRef<Promise<void> | null>(null);
  const terminalFailureActiveRef = useRef(false);

  const enterTerminalFailureState = useCallback((failure: Error, context: string) => {
    if (terminalFailureActiveRef.current) {
      return;
    }
    terminalFailureActiveRef.current = true;
    logger.error('Chunking worker entered terminal failure state', {
      context,
      error: failure.message,
    });
    // CRITICAL: Keep worker lifecycle deterministic. Once terminal failure happens,
    // tear down worker+port so callers cannot keep dispatching to a broken worker.
    setError(failure);
    setIsReady(false);
    setIsProcessing(false);
    if (portRef.current) {
      portRef.current.terminate();
      portRef.current = null;
    }
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }
    setCurrentPortState(null);
  }, []);

  const initialize = useCallback(async (): Promise<ChunkingWorkerPort> => {
    // Prevent double initialization
    if (initPromiseRef.current) {
      await initPromiseRef.current;
      if (!portRef.current) {
        throw new Error('Chunking worker port was not created');
      }
      return portRef.current;
    }

    initPromiseRef.current = (async () => {
      try {
        terminalFailureActiveRef.current = false;
        let readyReceived = false;
        logger.debug('Initializing chunking worker');
        const workerUrl = await resolveChunkingWorkerUrl();
        const worker = new Worker(workerUrl, { type: 'module' });
        workerRef.current = worker;

        // Create port FIRST, before attaching message handlers.
        // This prevents a race condition where the "ready" message triggers
        // a re-render before portRef.current is set.
        const port = createChunkingWorkerPort(worker);
        portRef.current = port;
        setCurrentPortState(port);

        const handleMessage = (event: MessageEvent) => {
          const { data } = event;

          if (data.type === 'ready') {
            if (readyReceived) {
              return;
            }
            readyReceived = true;
            // Keep this listener active after ready so runtime tokenizer failures
            // can still force a deterministic terminal worker state.
            logger.debug('Chunking worker ready');
            setIsReady(true);
            setError(null);
            return;
          }

          if (isInitWorkerErrorMessage(data)) {
            const errorMsg = data.error || 'Worker initialization failed';
            logger.error('Chunking worker init error', { error: errorMsg });
            worker.removeEventListener('message', handleMessage);
            enterTerminalFailureState(new Error(errorMsg), 'worker.message.__init__');
            return;
          }

          const tokenizerErrorData = getTerminalTokenizerErrorMessage(data);
          if (tokenizerErrorData) {
            const tokenizerError = tokenizerErrorData.error;
            logger.error('Chunking worker tokenizer failure', {
              id: tokenizerErrorData.id,
              fileRecordId: tokenizerErrorData.fileRecordId,
              error: tokenizerError,
            });
            worker.removeEventListener('message', handleMessage);
            enterTerminalFailureState(
              new Error(tokenizerError),
              `worker.message.tokenizer.${tokenizerErrorData.fileRecordId ?? tokenizerErrorData.id ?? 'unknown'}`
            );
          }
        };

        const handleError = (event: ErrorEvent) => {
          const errorDetails = {
            message: event.message || 'Unknown worker error',
            filename: event.filename || 'unknown',
            lineno: event.lineno || 0,
          };
          logger.error('Chunking worker error event', errorDetails);
          const runtimeError = new Error(
            `Chunking worker runtime error: ${errorDetails.message} (${errorDetails.filename}:${errorDetails.lineno})`
          );
          enterTerminalFailureState(runtimeError, 'worker.error');
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
            const timeoutError = new Error('Chunking worker ready timeout after 10 seconds');
            logger.error(timeoutError.message);
            // CRITICAL: Fail hard on startup timeout; no fallback mode is allowed.
            enterTerminalFailureState(timeoutError, 'worker.ready-timeout');
          }
        }, 10_000);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Failed to initialize worker';
        logger.error('Failed to initialize chunking worker', { error: errorMsg });
        enterTerminalFailureState(new Error(errorMsg), 'worker.initialize');
      }
    })();

    await initPromiseRef.current;
    if (!portRef.current) {
      throw new Error('Chunking worker port was not created');
    }
    return portRef.current;
  }, [enterTerminalFailureState]);

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
    setCurrentPortState(null);
    setError(null);
    setIsProcessing(false);
    terminalFailureActiveRef.current = false;

    // Reinitialize
    void initialize();
  }, [initialize]);

  useEffect(() => {
    if (autoStart) {
      void initialize();
    }

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
      terminalFailureActiveRef.current = false;
    };
  }, [autoStart, initialize]);

  // Create wrapped port that tracks processing state
  // This returns the port even when not ready - consumers should check isReady()
  // This prevents fallback to main thread when import starts before worker is ready
  // Note: Using currentPortState (state) instead of portRef.current because refs don't trigger re-renders
  const wrappedPort = useMemo((): ChunkingWorkerPort | null => {
    if (!currentPortState) {
      return null;
    }

    return {
      chunkFile: async (...args) => {
        setIsProcessing(true);
        try {
          const result = await currentPortState.chunkFile(...args);
          setIsProcessing(false);
          return result;
        } catch (err) {
          setIsProcessing(false);
          throw err;
        }
      },
      chunkBatch: async (files, options, callbacks?: ChunkingBatchCallbacks) => {
        setIsProcessing(true);
        try {
          const result = await currentPortState.chunkBatch(files, options, callbacks);
          setIsProcessing(false);
          return result;
        } catch (err) {
          setIsProcessing(false);
          throw err;
        }
      },
      isReady: () => currentPortState.isReady(),
      terminate: () => {
        currentPortState.terminate();
        portRef.current = null;
        setIsReady(false);
      },
    };
  }, [currentPortState]);

  const contextValue = useMemo<ChunkingWorkerContextValue>(
    () => ({
      ensureStarted: initialize,
      port: wrappedPort,
      isReady,
      isProcessing,
      error,
      reinitialize,
    }),
    [initialize, wrappedPort, isReady, isProcessing, error, reinitialize]
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
