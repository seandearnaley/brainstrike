/**
 * ChunkingWorkerContext - React context for chunking execution.
 *
 * The provider can either:
 * - own a local browser Worker in the current renderer, or
 * - proxy requests to the hidden desktop chunking host renderer.
 */

import type { ChunkingRequestOptions, ChunkResult } from '@brainstrike/chunking-worker';
import { createLogger } from '@brainstrike/utils/logger';
import {
  createContext,
  type MutableRefObject,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  ChunkingBatchCallbacks,
  ChunkingHostProxyRequestOptions,
  ChunkingWorkerPort,
} from './chunking-worker-port';
import { resolveChunkingWorkerUrl } from './resolve-chunking-worker-url';

const logger = createLogger('ChunkingWorkerContext');
const CHUNKING_WORKER_READY_TIMEOUT_MS = 30_000;

const TERMINAL_TOKENIZER_ERROR_PATTERNS: RegExp[] = [
  /^accurate token counting unavailable:/i,
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

interface ChunkingWorkerMessageContext {
  clearReadyMonitor: () => void;
  enterTerminalFailureState: (failure: Error, context: string) => void;
  markReady: () => void;
  readyReceived: boolean;
  setReadyReceived: () => void;
}

function handleChunkingWorkerMessageData(
  data: unknown,
  context: ChunkingWorkerMessageContext
): void {
  if (data && typeof data === 'object' && 'type' in data && data.type === 'ready') {
    if (context.readyReceived) {
      return;
    }
    context.setReadyReceived();
    context.clearReadyMonitor();
    logger.debug('Chunking worker ready');
    context.markReady();
    return;
  }

  if (isInitWorkerErrorMessage(data)) {
    const errorMessage = data.error || 'Worker initialization failed';
    logger.error('Chunking worker init error', { error: errorMessage });
    context.enterTerminalFailureState(new Error(errorMessage), 'worker.message.__init__');
    return;
  }

  const tokenizerErrorData = getTerminalTokenizerErrorMessage(data);
  if (!tokenizerErrorData) {
    return;
  }

  const tokenizerError = tokenizerErrorData.error;
  logger.error('Chunking worker tokenizer failure', {
    id: tokenizerErrorData.id,
    fileRecordId: tokenizerErrorData.fileRecordId,
    error: tokenizerError,
  });
  context.enterTerminalFailureState(
    new Error(tokenizerError),
    `worker.message.tokenizer.${tokenizerErrorData.fileRecordId ?? tokenizerErrorData.id ?? 'unknown'}`
  );
}

export interface ChunkingWorkerContextValue {
  ensureStarted: () => Promise<ChunkingWorkerPort>;
  error: Error | null;
  isProcessing: boolean;
  isReady: boolean;
  port: ChunkingWorkerPort | null;
  reinitialize: () => void;
}

// ─── Parser-host bridge (Phase 4 / chunking-parser PRD §4) ──────────────
//
// The chunking-worker's oxc-ipc-adapter runs in a Web Worker realm that
// cannot directly `import('electron')` or call ipcRenderer (contextIsolation
// + sandbox + nodeIntegrationInWorker=off). Instead, the worker posts an
// envelope to its parent (this renderer thread), which routes the request
// through the preload-exposed `window.parserHost.parse(...)` and posts the
// response back to the worker.
//
// Both ends agree on envelope shape:
//   invoke: { type: 'parser-host:invoke', requestId, payload }
//   reply:  { type: 'parser-host:reply',  requestId, response }
//
// In environments without the preload bridge (apps/web, tests without the
// global mocked) we silently no-op — the adapter's timeout fires and the
// per-file fallback wrapper routes to Babel. No crashes.
//
// Source-of-truth for the request payload shape lives in
// `apps/desktop/src/parser-host-shared.ts`; we don't import it across the
// package boundary, we just pass the payload through opaquely.

const PARSER_HOST_INVOKE = 'parser-host:invoke';
const PARSER_HOST_REPLY = 'parser-host:reply';

interface ParserHostBridge {
  parse(payload: unknown): Promise<unknown>;
}

function getParserHostBridge(): ParserHostBridge | null {
  if (typeof globalThis === 'undefined') {
    return null;
  }
  const bridge = (globalThis as { parserHost?: unknown }).parserHost;
  if (
    bridge &&
    typeof bridge === 'object' &&
    typeof (bridge as ParserHostBridge).parse === 'function'
  ) {
    return bridge as ParserHostBridge;
  }
  return null;
}

function isInvokeEnvelope(value: unknown): value is {
  type: typeof PARSER_HOST_INVOKE;
  requestId: string;
  payload: unknown;
} {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const v = value as Record<string, unknown>;
  return v['type'] === PARSER_HOST_INVOKE && typeof v['requestId'] === 'string';
}

function createParserHostBridgeHandler(worker: Worker): (event: MessageEvent) => void {
  return (event: MessageEvent) => {
    const data = event.data;
    if (!isInvokeEnvelope(data)) {
      return;
    }
    const bridge = getParserHostBridge();
    if (!bridge) {
      // No bridge available in this environment — reply with a failure so
      // the worker's pending promise rejects quickly rather than waiting
      // for the timeout, and the per-file fallback runs.
      worker.postMessage({
        requestId: data.requestId,
        response: {
          error: 'parser host bridge unavailable in this environment',
          ok: false,
          requestId: data.requestId,
        },
        type: PARSER_HOST_REPLY,
      });
      return;
    }
    bridge
      .parse(data.payload)
      .then((response) => {
        worker.postMessage({
          requestId: data.requestId,
          response,
          type: PARSER_HOST_REPLY,
        });
      })
      .catch((error: unknown) => {
        worker.postMessage({
          requestId: data.requestId,
          response: {
            error: error instanceof Error ? error.message : String(error),
            ok: false,
            requestId: data.requestId,
          },
          type: PARSER_HOST_REPLY,
        });
      });
  };
}

const ChunkingWorkerContext = createContext<ChunkingWorkerContextValue | null>(null);

let chunkingWorkerPortFactoryPromise: Promise<typeof import('./chunking-worker-port')> | null =
  null;

async function loadChunkingWorkerPortFactory(): Promise<typeof import('./chunking-worker-port')> {
  if (!chunkingWorkerPortFactoryPromise) {
    chunkingWorkerPortFactoryPromise = import('./chunking-worker-port');
  }
  return chunkingWorkerPortFactoryPromise;
}

export interface ChunkingWorkerProviderProps {
  autoStart?: boolean;
  children: ReactNode;
  mode?: 'host-proxy' | 'local';
}

interface ChunkingHostLifecycleState {
  active: boolean;
  lastError: string | null;
  runtimeId: string;
  runtimeKind: 'chunking-host';
  state: 'error' | 'running' | 'starting' | 'stopped' | 'stopping';
}

interface ChunkingHostFilePayload {
  content: string;
  fileName: string;
  filePath: string;
  fileRecordId: string;
}

interface ChunkingHostChunkFileRequest extends ChunkingHostFilePayload {
  kind: 'chunk-file';
  options: ChunkingHostProxyRequestOptions;
  requestId: string;
}

interface ChunkingHostChunkFileByIdRequest {
  fileRecordId: string;
  kind: 'chunk-file-by-id';
  options: ChunkingHostProxyRequestOptions;
  requestId: string;
}

interface ChunkingHostChunkBatchRequest {
  files: readonly ChunkingHostFilePayload[];
  kind: 'chunk-batch';
  options: ChunkingHostProxyRequestOptions;
  requestId: string;
}

interface ChunkingHostBridge {
  chunkBatch: (request: ChunkingHostChunkBatchRequest) => Promise<ChunkResult[]>;
  chunkFile: (
    request: ChunkingHostChunkFileByIdRequest | ChunkingHostChunkFileRequest
  ) => Promise<ChunkResult>;
  ensureStarted: () => Promise<ChunkingHostLifecycleState>;
  getStatus: () => Promise<ChunkingHostLifecycleState>;
  onProgress: (
    callback: (progress: {
      channel: 'chunk' | 'chunk-file-complete' | 'chunk-file-error';
      payload:
        | {
            chunksCreated: number;
            currentIndex?: number;
            fileRecordId: string;
            totalFiles?: number;
          }
        | {
            fileRecordId: string;
            result: ChunkResult;
          }
        | {
            errorMessage: string;
            fileRecordId: string;
          };
      requestId: string;
      runtimeId: string;
      type: 'progress';
    }) => void
  ) => () => void;
  onStatus: (callback: (status: ChunkingHostLifecycleState) => void) => () => void;
  reset: () => Promise<ChunkingHostLifecycleState>;
}

function getChunkingHostBridge(): ChunkingHostBridge | null {
  const currentWindow = window as Window & {
    chunkingHost?: ChunkingHostBridge;
  };
  return currentWindow.chunkingHost ?? null;
}

function createChunkingHostError(status: ChunkingHostLifecycleState): Error {
  return new Error(status.lastError ?? `Chunking host is not running (state: ${status.state}).`);
}

function createChunkingRequestId(prefix: 'batch' | 'file'): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function toChunkingHostRequestOptions(
  options: ChunkingRequestOptions
): ChunkingHostProxyRequestOptions {
  return {
    requestedStrategy: options.strategy,
    ...(options.allowLargeFiles === undefined ? {} : { allowLargeFiles: options.allowLargeFiles }),
    ...(options.forceStrategy === undefined ? {} : { forceStrategy: options.forceStrategy }),
    ...(options.ignoreFileTypeRecommendations === undefined
      ? {}
      : { ignoreFileTypeRecommendations: options.ignoreFileTypeRecommendations }),
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    ...(options.maxTokensCap === undefined ? {} : { maxTokensCap: options.maxTokensCap }),
    ...(options.overlap === undefined ? {} : { overlap: options.overlap }),
    ...(options.separators === undefined ? {} : { separators: options.separators }),
    ...(options.tokenTrueSizing === undefined ? {} : { tokenTrueSizing: options.tokenTrueSizing }),
  };
}

function ChunkingHostProxyProvider({
  autoStart = true,
  children,
}: Pick<ChunkingWorkerProviderProps, 'autoStart' | 'children'>): ReactNode {
  const [status, setStatus] = useState<ChunkingHostLifecycleState>({
    state: 'stopped',
    active: false,
    lastError: null,
    runtimeKind: 'chunking-host',
    runtimeId: 'chunking-host:stopped',
  });
  const [error, setError] = useState<Error | null>(null);
  const pendingBatchCallbacksRef = useRef(new Map<string, ChunkingBatchCallbacks | undefined>());
  const bridgeRef = useRef<ChunkingHostBridge | null>(null);

  const updateFromStatus = useCallback((nextStatus: ChunkingHostLifecycleState) => {
    setStatus(nextStatus);
    if (nextStatus.state === 'error') {
      setError(createChunkingHostError(nextStatus));
      return;
    }
    if (nextStatus.state === 'running') {
      setError(null);
    }
  }, []);

  const ensureStarted = useCallback(async (): Promise<ChunkingWorkerPort> => {
    const bridge = getChunkingHostBridge();
    if (!bridge) {
      throw new Error('Chunking host bridge is not available.');
    }

    bridgeRef.current = bridge;
    const nextStatus = await bridge.ensureStarted();
    updateFromStatus(nextStatus);
    if (nextStatus.state !== 'running') {
      throw createChunkingHostError(nextStatus);
    }

    return createChunkingHostProxyPort(bridge, pendingBatchCallbacksRef);
  }, [updateFromStatus]);

  const reinitialize = useCallback(() => {
    const bridge = getChunkingHostBridge();
    if (!bridge) {
      setError(new Error('Chunking host bridge is not available.'));
      return;
    }
    void bridge
      .reset()
      .then((nextStatus) => {
        bridgeRef.current = bridge;
        updateFromStatus(nextStatus);
      })
      .catch((resetError) => {
        const message = resetError instanceof Error ? resetError.message : String(resetError);
        setError(new Error(message));
      });
  }, [updateFromStatus]);

  // biome-ignore lint/plugin: Host status is external IPC state that must be mirrored into React.
  useEffect(() => {
    const bridge = getChunkingHostBridge();
    if (!bridge) {
      setError(new Error('Chunking host bridge is not available.'));
      return;
    }

    bridgeRef.current = bridge;
    let disposed = false;

    void bridge
      .getStatus()
      .then((nextStatus) => {
        if (disposed) {
          return;
        }
        updateFromStatus(nextStatus);
      })
      .catch((statusError) => {
        if (disposed) {
          return;
        }
        const message = statusError instanceof Error ? statusError.message : String(statusError);
        setError(new Error(message));
      });

    const cleanupStatus = bridge.onStatus((nextStatus) => {
      if (disposed) {
        return;
      }
      updateFromStatus(nextStatus);
    });

    if (autoStart) {
      void ensureStarted();
    }

    return () => {
      disposed = true;
      cleanupStatus();
      pendingBatchCallbacksRef.current.clear();
    };
  }, [autoStart, ensureStarted, updateFromStatus]);

  const currentPortState = useMemo<ChunkingWorkerPort | null>(() => {
    const bridge = bridgeRef.current;
    if (!(bridge && status.state === 'running')) {
      return null;
    }
    return createChunkingHostProxyPort(bridge, pendingBatchCallbacksRef);
  }, [status.state]);

  const contextValue = useMemo<ChunkingWorkerContextValue>(
    () => ({
      ensureStarted,
      port: currentPortState,
      isReady: status.state === 'running',
      isProcessing: status.active,
      error,
      reinitialize,
    }),
    [currentPortState, ensureStarted, error, reinitialize, status.active, status.state]
  );

  return (
    <ChunkingWorkerContext.Provider value={contextValue}>{children}</ChunkingWorkerContext.Provider>
  );
}

function createChunkingHostProxyPort(
  bridge: ChunkingHostBridge,
  pendingBatchCallbacksRef: MutableRefObject<Map<string, ChunkingBatchCallbacks | undefined>>
): ChunkingWorkerPort {
  return {
    transportKind: 'host-proxy',
    chunkFileById: async (fileRecordId: string, options: ChunkingHostProxyRequestOptions) =>
      bridge.chunkFile({
        kind: 'chunk-file-by-id',
        requestId: createChunkingRequestId('file'),
        fileRecordId,
        options,
      }),
    chunkFile: async (
      fileRecordId: string,
      content: string,
      fileName: string,
      filePath: string,
      options: ChunkingRequestOptions
    ) =>
      bridge.chunkFile({
        kind: 'chunk-file',
        requestId: createChunkingRequestId('file'),
        fileRecordId,
        content,
        fileName,
        filePath,
        options: toChunkingHostRequestOptions(options),
      }),
    chunkBatch: async (
      files: Array<{
        fileRecordId: string;
        content: string;
        fileName: string;
        filePath: string;
      }>,
      options: ChunkingRequestOptions,
      callbacks?: ChunkingBatchCallbacks
    ) => {
      const requestId = createChunkingRequestId('batch');
      pendingBatchCallbacksRef.current.set(requestId, callbacks);
      const cleanupProgress = bridge.onProgress((progress) => {
        if (progress.requestId !== requestId) {
          return;
        }
        const registeredCallbacks = pendingBatchCallbacksRef.current.get(requestId);
        if (!registeredCallbacks) {
          return;
        }
        if (progress.channel === 'chunk') {
          const payload = progress.payload as {
            chunksCreated: number;
            currentIndex?: number;
            fileRecordId: string;
            totalFiles?: number;
          };
          registeredCallbacks.onProgress?.(
            payload.fileRecordId,
            payload.chunksCreated,
            payload.currentIndex ?? 0,
            payload.totalFiles ?? 0
          );
          return;
        }
        if (progress.channel === 'chunk-file-complete') {
          const payload = progress.payload as { fileRecordId: string; result: ChunkResult };
          registeredCallbacks.onFileComplete?.(payload.fileRecordId, payload.result);
          return;
        }
        if (progress.channel === 'chunk-file-error') {
          const payload = progress.payload as { errorMessage: string; fileRecordId: string };
          registeredCallbacks.onFileError?.(payload.fileRecordId, payload.errorMessage);
        }
      });

      try {
        return await bridge.chunkBatch({
          kind: 'chunk-batch',
          requestId,
          files,
          options: toChunkingHostRequestOptions(options),
        });
      } finally {
        cleanupProgress();
        pendingBatchCallbacksRef.current.delete(requestId);
      }
    },
    isReady: () => true,
    // Host-proxy mode does not own the hidden renderer lifecycle.
    terminate: () => {},
  };
}

function ChunkingLocalWorkerProvider({
  autoStart = true,
  children,
}: Pick<ChunkingWorkerProviderProps, 'autoStart' | 'children'>): ReactNode {
  const [isReady, setIsReady] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [currentPortState, setCurrentPortState] = useState<ChunkingWorkerPort | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const portRef = useRef<ChunkingWorkerPort | null>(null);
  const initPromiseRef = useRef<Promise<void> | null>(null);
  const lifecycleGenerationRef = useRef(0);
  const readyMonitorCleanupRef = useRef<(() => void) | null>(null);
  const workerListenerCleanupRef = useRef<(() => void) | null>(null);
  const terminalFailureActiveRef = useRef(false);

  const clearReadyMonitor = useCallback(() => {
    readyMonitorCleanupRef.current?.();
    readyMonitorCleanupRef.current = null;
  }, []);

  const clearWorkerListeners = useCallback(() => {
    workerListenerCleanupRef.current?.();
    workerListenerCleanupRef.current = null;
  }, []);

  const disposeCurrentWorker = useCallback(() => {
    clearReadyMonitor();
    clearWorkerListeners();

    const activePort = portRef.current;
    const activeWorker = workerRef.current;
    portRef.current = null;
    workerRef.current = null;

    if (activePort) {
      activePort.terminate();
    } else if (activeWorker) {
      activeWorker.terminate();
    }

    setCurrentPortState(null);
  }, [clearReadyMonitor, clearWorkerListeners]);

  const enterTerminalFailureState = useCallback(
    (failure: Error, context: string) => {
      if (terminalFailureActiveRef.current) {
        return;
      }
      terminalFailureActiveRef.current = true;
      lifecycleGenerationRef.current += 1;
      logger.error('Chunking worker entered terminal failure state', {
        context,
        error: failure.message,
      });
      setError(failure);
      setIsReady(false);
      setIsProcessing(false);
      initPromiseRef.current = null;
      disposeCurrentWorker();
    },
    [disposeCurrentWorker]
  );

  const initialize = useCallback(async (): Promise<ChunkingWorkerPort> => {
    if (initPromiseRef.current) {
      await initPromiseRef.current;
      if (!portRef.current) {
        throw new Error('Chunking worker port was not created');
      }
      return portRef.current;
    }

    const generation = ++lifecycleGenerationRef.current;
    initPromiseRef.current = (async () => {
      try {
        terminalFailureActiveRef.current = false;
        let readyReceived = false;
        logger.debug('Initializing chunking worker');
        const workerUrl = await resolveChunkingWorkerUrl();
        if (generation !== lifecycleGenerationRef.current) {
          return;
        }
        const worker = new Worker(workerUrl, { type: 'module' });
        workerRef.current = worker;

        const handleMessage = (event: MessageEvent) => {
          if (generation !== lifecycleGenerationRef.current) {
            return;
          }
          handleChunkingWorkerMessageData(event.data, {
            clearReadyMonitor,
            enterTerminalFailureState,
            markReady: () => {
              setIsReady(true);
              setError(null);
            },
            readyReceived,
            setReadyReceived: () => {
              readyReceived = true;
            },
          });
        };

        const handleError = (event: ErrorEvent) => {
          if (generation !== lifecycleGenerationRef.current) {
            return;
          }
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
        // Parser-host bridge: when the chunking-worker's oxc-ipc-adapter
        // posts a parser-host:invoke envelope, route it through the
        // preload-exposed `window.parserHost.parse` IPC channel and post
        // the response back to the worker. No-op when the global isn't
        // present (apps/web, tests without bridge mocked).
        const handleParserHostBridge = createParserHostBridgeHandler(worker);
        worker.addEventListener('message', handleParserHostBridge);
        const cleanupWorkerListeners = () => {
          worker.removeEventListener('message', handleMessage);
          worker.removeEventListener('error', handleError);
          worker.removeEventListener('message', handleParserHostBridge);
        };
        workerListenerCleanupRef.current = cleanupWorkerListeners;

        const { createChunkingWorkerPort } = await loadChunkingWorkerPortFactory();
        if (generation !== lifecycleGenerationRef.current) {
          cleanupWorkerListeners();
          if (workerListenerCleanupRef.current === cleanupWorkerListeners) {
            workerListenerCleanupRef.current = null;
          }
          worker.terminate();
          return;
        }
        const port = createChunkingWorkerPort(worker);
        portRef.current = port;
        setCurrentPortState(port);

        const checkReadyInterval = setInterval(() => {
          if (generation !== lifecycleGenerationRef.current) {
            clearReadyMonitor();
            return;
          }
          if (port.isReady()) {
            clearReadyMonitor();
            setIsReady(true);
            setError(null);
          }
        }, 100);

        const readyTimeout = setTimeout(() => {
          if (generation !== lifecycleGenerationRef.current) {
            return;
          }
          clearReadyMonitor();
          if (!port.isReady()) {
            const timeoutError = new Error(
              `Chunking worker ready timeout after ${CHUNKING_WORKER_READY_TIMEOUT_MS / 1000} seconds`
            );
            logger.error(timeoutError.message);
            enterTerminalFailureState(timeoutError, 'worker.ready-timeout');
          }
        }, CHUNKING_WORKER_READY_TIMEOUT_MS);

        readyMonitorCleanupRef.current = () => {
          clearInterval(checkReadyInterval);
          clearTimeout(readyTimeout);
        };
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
  }, [clearReadyMonitor, enterTerminalFailureState]);

  const startInitialization = useCallback(() => {
    void initialize().catch((err) => {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error('Chunking worker initialization did not produce a port', { error: errorMsg });
    });
  }, [initialize]);

  const reinitialize = useCallback(() => {
    logger.info('Reinitializing chunking worker');

    lifecycleGenerationRef.current += 1;
    initPromiseRef.current = null;
    setIsReady(false);
    setError(null);
    setIsProcessing(false);
    terminalFailureActiveRef.current = false;
    disposeCurrentWorker();

    startInitialization();
  }, [disposeCurrentWorker, startInitialization]);

  useEffect(() => {
    if (autoStart) {
      startInitialization();
    }

    return () => {
      lifecycleGenerationRef.current += 1;
      initPromiseRef.current = null;
      terminalFailureActiveRef.current = false;
      disposeCurrentWorker();
    };
  }, [autoStart, disposeCurrentWorker, startInitialization]);

  const wrappedPort = useMemo((): ChunkingWorkerPort | null => {
    if (!currentPortState) {
      return null;
    }

    const wrappedPort: ChunkingWorkerPort = {
      transportKind: currentPortState.transportKind,
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
      ...(currentPortState.chunkFileById
        ? {
            chunkFileById: async (...args) => {
              setIsProcessing(true);
              try {
                const result = await currentPortState.chunkFileById?.(...args);
                if (!result) {
                  throw new Error('Chunking worker port missing chunkFileById implementation.');
                }
                setIsProcessing(false);
                return result;
              } catch (err) {
                setIsProcessing(false);
                throw err;
              }
            },
          }
        : {}),
      isReady: () => currentPortState.isReady(),
      terminate: () => {
        currentPortState.terminate();
        portRef.current = null;
        setIsReady(false);
        setCurrentPortState(null);
      },
    };

    return wrappedPort;
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
    [error, initialize, isProcessing, isReady, reinitialize, wrappedPort]
  );

  return (
    <ChunkingWorkerContext.Provider value={contextValue}>{children}</ChunkingWorkerContext.Provider>
  );
}

export function ChunkingWorkerProvider({
  autoStart = true,
  children,
  mode = 'local',
}: ChunkingWorkerProviderProps): ReactNode {
  if (mode === 'host-proxy') {
    return <ChunkingHostProxyProvider autoStart={autoStart}>{children}</ChunkingHostProxyProvider>;
  }
  return (
    <ChunkingLocalWorkerProvider autoStart={autoStart}>{children}</ChunkingLocalWorkerProvider>
  );
}

export function useChunkingWorkerContext(): ChunkingWorkerContextValue {
  const context = useContext(ChunkingWorkerContext);

  if (!context) {
    throw new Error('useChunkingWorkerContext must be used within a ChunkingWorkerProvider');
  }

  return context;
}

export function useChunkingWorkerPort(): ChunkingWorkerPort | null {
  const { port } = useChunkingWorkerContext();
  return port;
}
