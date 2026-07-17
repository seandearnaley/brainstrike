/**
 * ChunkingWorkerPort - Abstraction layer for communicating with the chunking worker.
 *
 * This module provides a port-based interface for chunking operations that:
 * - Manages worker lifecycle and message passing
 * - Converts between portable chunks and database inserts
 * - Provides Promise-based API for single file and batch operations
 */

import type {
  ChunkBatchRequest,
  ChunkError,
  ChunkingRequestOptions,
  ChunkProgress,
  ChunkRequest,
  ChunkResult,
  PortableChunk,
  WorkerResponse,
} from '@brainstrike/chunking-worker';
import type { FileChunkInsert } from '@brainstrike/db';
import { createLogger } from '@brainstrike/utils/logger';
import { createRequestTracker, createWorkerRuntimeClient } from '@brainstrike/worker-runtime';

const logger = createLogger('ChunkingWorkerPort');

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

function assertPortableChunkSourceRange(chunk: PortableChunk): void {
  if (
    !(
      Number.isSafeInteger(chunk.startLine) &&
      Number.isSafeInteger(chunk.endLine) &&
      Number.isSafeInteger(chunk.startOffset) &&
      Number.isSafeInteger(chunk.endOffset) &&
      chunk.startLine >= 1 &&
      chunk.endLine >= chunk.startLine &&
      chunk.startOffset >= 0 &&
      chunk.endOffset >= chunk.startOffset
    )
  ) {
    throw new Error(`Chunk ${chunk.chunkIndex} has invalid required source range metadata.`);
  }
}

/**
 * Callbacks for batch processing events.
 */
export interface ChunkingBatchCallbacks {
  onFileComplete?: (fileRecordId: string, result: ChunkResult) => void;
  onFileError?: (fileRecordId: string, error: string) => void;
  onProgress?: (
    fileRecordId: string,
    chunksCreated: number,
    currentIndex: number,
    total: number
  ) => void;
}

export interface ChunkingHostProxyRequestOptions {
  readonly allowLargeFiles?: boolean;
  readonly forceStrategy?: boolean;
  readonly ignoreFileTypeRecommendations?: boolean;
  readonly maxTokens?: number;
  readonly maxTokensCap?: number;
  readonly overlap?: number;
  readonly requestedStrategy?: ChunkingRequestOptions['strategy'];
  readonly separators?: readonly string[];
  readonly tokenTrueSizing?: boolean;
}

/**
 * Port interface for interacting with the chunking worker.
 */
export interface ChunkingWorkerPort {
  /**
   * Chunk multiple files in a batch.
   */
  chunkBatch: (
    files: Array<{
      fileRecordId: string;
      content: string;
      fileName: string;
      filePath: string;
    }>,
    options: ChunkingRequestOptions,
    callbacks?: ChunkingBatchCallbacks
  ) => Promise<ChunkResult[]>;
  /**
   * Chunk a single file.
   */
  chunkFile: (
    fileRecordId: string,
    content: string,
    fileName: string,
    filePath: string,
    options: ChunkingRequestOptions
  ) => Promise<ChunkResult>;
  chunkFileById?: (
    fileRecordId: string,
    options: ChunkingHostProxyRequestOptions
  ) => Promise<ChunkResult>;

  /**
   * Check if the worker is ready to receive requests.
   */
  isReady: () => boolean;

  /**
   * Terminate the worker and clean up resources.
   */
  terminate: () => void;
  readonly transportKind: 'host-proxy' | 'local-worker';
}

/**
 * Convert PortableChunk[] to FileChunkInsert[] for database insertion.
 *
 * @param fileRecordId - The file record ID to associate with chunks
 * @param chunks - Portable chunks from the worker
 * @param embeddingSetId - Optional embedding set ID to associate with chunks
 */
export function toFileChunkInserts(
  fileRecordId: string,
  chunks: PortableChunk[],
  embeddingSetId?: string
): FileChunkInsert[] {
  const now = new Date().toISOString();
  return chunks.map((chunk) => {
    assertPortableChunkSourceRange(chunk);
    const insert: FileChunkInsert = {
      chunkIndex: chunk.chunkIndex,
      chunkSize: chunk.chunkSize,
      chunkType: chunk.chunkType,
      content: chunk.content,
      contentHash: chunk.contentHash,
      createdAt: now,
      endLine: chunk.endLine,
      endOffset: chunk.endOffset,
      fileRecordId,
      id: `${fileRecordId}_chunk_${chunk.chunkIndex}`,
      startLine: chunk.startLine,
      startOffset: chunk.startOffset,
      tokenCount: chunk.tokenCount,
      updatedAt: now,
    };
    // Only set embeddingSetId if provided (exactOptionalPropertyTypes compliance)
    if (embeddingSetId !== undefined) {
      insert.embeddingSetId = embeddingSetId;
    }
    return insert;
  });
}

interface ChunkingWorkerInitMessage {
  parserEnv?: 'browser' | 'electron-chunking-host';
  parserFlag?: 'auto' | 'babel' | 'oxc';
  treeSitterLanguages?: readonly string[];
  type: 'init';
}

/**
 * Build the worker's init payload. When this code runs inside the Electron
 * chunking-host renderer, the preload bridge has exposed
 * `globalThis.parserHost.parse` — its presence is our deterministic signal
 * that the worker should advertise the chunking-host environment so its
 * selectAdapter routes oxc parses through the IPC bridge.
 *
 * In apps/web (no preload) and tests without the bridge mocked, parserEnv
 * stays undefined and the worker keeps its 'browser' default.
 *
 * Tree-sitter languages (Phase 8 of #998) are forwarded from the renderer's
 * globalThis to the worker's realm via the same init message. Without this
 * forward the worker would always see an empty list and never enable
 * tree-sitter routing.
 */
function buildInitMessage(): ChunkingWorkerInitMessage {
  const init: ChunkingWorkerInitMessage = { type: 'init' };
  if (typeof globalThis !== 'undefined') {
    const bridge = (globalThis as { parserHost?: unknown }).parserHost;
    if (
      bridge &&
      typeof bridge === 'object' &&
      typeof (bridge as { parse?: unknown }).parse === 'function'
    ) {
      init.parserEnv = 'electron-chunking-host';
    }
    // biome-ignore-start lint/style/useNamingConvention: shared global keys, intentional UPPER_SNAKE_CASE
    interface ParserGlobals {
      __BRAINSTRIKE_PARSER_FLAG__?: unknown;
      __BRAINSTRIKE_TREE_SITTER_LANGUAGES__?: unknown;
    }
    // biome-ignore-end lint/style/useNamingConvention: shared global keys, intentional UPPER_SNAKE_CASE
    const flag = (globalThis as ParserGlobals).__BRAINSTRIKE_PARSER_FLAG__;
    if (flag === 'auto' || flag === 'babel' || flag === 'oxc') {
      init.parserFlag = flag;
    }
    const languages = (globalThis as ParserGlobals).__BRAINSTRIKE_TREE_SITTER_LANGUAGES__;
    if (Array.isArray(languages)) {
      // The worker's defensive coercion in getEnabledTreeSitterLanguages
      // re-validates entries; we just need to ensure SOMETHING serializable
      // gets across. Empty array (kill switch) and undefined (default-on)
      // are meaningfully different — keep that distinction.
      init.treeSitterLanguages = languages.filter((s): s is string => typeof s === 'string');
    }
  }
  return init;
}

/**
 * Create a ChunkingWorkerPort from a Worker instance.
 *
 * @param worker - The Web Worker running chunking.worker.js
 */
export function createChunkingWorkerPort(worker: Worker): ChunkingWorkerPort {
  const pendingRequests = createRequestTracker<{
    reject: (error: Error) => void;
    resolve: (result: ChunkResult) => void;
  }>();
  let removeMessageListener = () => {};
  const runtime = createWorkerRuntimeClient(worker, {
    createErrorFromEvent: (event) => {
      logger.error('Worker error event', {
        colno: event.colno,
        filename: event.filename,
        lineno: event.lineno,
        message: event.message,
      });
      const detailSuffix = ` (${event.filename || 'unknown'}:${event.lineno || 0}:${event.colno || 0})`;
      return new Error(
        event.message
          ? `Chunking worker runtime error: ${event.message}${detailSuffix}`
          : `Chunking worker runtime error (missing ErrorEvent.message)${detailSuffix}`
      );
    },
    onFailure: (failure) => {
      rejectAllPending(failure);
      removeMessageListener();
      runtime.dispose();
      worker.terminate();
    },
  });
  const transport = runtime.transport;
  let batchCallbacks: ChunkingBatchCallbacks | null = null;
  const batchResults = new Map<string, ChunkResult>();
  let batchResolve: ((results: ChunkResult[]) => void) | null = null;
  let batchReject: ((error: Error) => void) | null = null;
  let batchFileIds: string[] = [];

  function clearBatchState(): void {
    batchResolve = null;
    batchReject = null;
    batchFileIds = [];
    batchResults.clear();
    batchCallbacks = null;
  }

  function rejectAllPending(error: Error): void {
    for (const [, pending] of pendingRequests.entries()) {
      pending.reject(error);
    }
    pendingRequests.clear();
    if (batchReject) {
      batchReject(error);
    }
    clearBatchState();
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Worker message dispatch handles multiple variants.
  function handleMessage(message: WorkerResponse) {
    // Parser-host bridge envelopes (parser-host:invoke from the worker,
    // parser-host:reply from the renderer) are consumed by the dedicated
    // bridge handler in chunking-worker-context.tsx. They flow through
    // the same worker `message` event channel that this port listens on,
    // but they aren't chunking responses — silently ignore so we don't
    // spam "Unknown message type from worker" warns (regression
    // discovered 2026-05-17 in real-world log capture: 1830+ warns
    // per chunking session).
    const messageType = (message as { type?: unknown }).type;
    if (typeof messageType === 'string' && messageType.startsWith('parser-host:')) {
      return;
    }
    switch (message.type) {
      case 'ready':
        runtime.markReady();
        logger.info('Chunking worker ready');
        break;

      case 'result': {
        const result = message as ChunkResult;
        // Check if this is a batch result
        if (batchFileIds.includes(result.fileRecordId)) {
          batchResults.set(result.fileRecordId, result);
          batchCallbacks?.onFileComplete?.(result.fileRecordId, result);

          // Check if batch is complete
          if (batchResults.size === batchFileIds.length && batchResolve) {
            const orderedResults = batchFileIds.map((id) => batchResults.get(id) as ChunkResult);
            batchResolve(orderedResults);
            clearBatchState();
          }
        } else {
          // Single file result
          const pending = pendingRequests.get(result.id);
          if (pending) {
            pending.resolve(result);
            pendingRequests.delete(result.id);
          }
        }
        break;
      }

      case 'progress': {
        const progress = message as ChunkProgress;
        batchCallbacks?.onProgress?.(
          progress.fileRecordId,
          progress.chunksCreated,
          progress.currentIndex ?? 0,
          progress.totalFiles ?? 1
        );
        break;
      }

      case 'error': {
        const error = message as ChunkError;
        logger.error('Worker error', {
          error: error.error,
          fileRecordId: error.fileRecordId,
          id: error.id,
        });

        const tokenizerTerminalError = isTerminalTokenizerError(error.error);
        const terminalLifecycleError =
          error.id === '__init__' || error.fileRecordId === '__init__' || tokenizerTerminalError;

        if (terminalLifecycleError) {
          const failure = new Error(
            tokenizerTerminalError
              ? `Chunking worker entered terminal tokenizer failure state: ${error.error}`
              : `Chunking worker initialization failed: ${error.error}`
          );
          runtime.markFailed(failure);

          // CRITICAL: init/runtime worker errors are terminal. Reject all pending
          // operations immediately so callers don't hang waiting for file-level results.
          // Tokenizer-init failures are terminal too: retrying the same worker only
          // fans out duplicate errors and hides the root cause.
          rejectAllPending(failure);
          removeMessageListener();
          runtime.dispose();
          worker.terminate();
          break;
        }

        // Check if this is a batch error
        if (batchFileIds.includes(error.fileRecordId)) {
          batchCallbacks?.onFileError?.(error.fileRecordId, error.error);
          // CRITICAL: No partial-success fallback for batch chunking.
          // A single worker failure must fail the entire batch to keep import state consistent.
          const batchError = new Error(
            `Chunking batch failed for ${error.fileRecordId}: ${error.error}`
          );
          if (batchReject) {
            batchReject(batchError);
          }
          clearBatchState();
        } else {
          // Single file error
          const pending = pendingRequests.get(error.id);
          if (pending) {
            pending.reject(new Error(error.error));
            pendingRequests.delete(error.id);
          }
        }
        break;
      }

      case 'log': {
        // Forward worker logs at the worker's reported level so info/warn
        // messages aren't silently buried under the dev log-level filter.
        const workerLevel = message.level;
        const forward =
          workerLevel === 'error'
            ? logger.error
            : workerLevel === 'warn'
              ? logger.warn
              : workerLevel === 'info'
                ? logger.info
                : logger.debug;
        forward.call(logger, `[Worker] ${message.message}`, message.data);
        break;
      }

      default:
        logger.warn('Unknown message type from worker', {
          type: (message as { type?: unknown }).type,
        });
    }
  }
  removeMessageListener = transport.onMessage((message) => {
    handleMessage(message as WorkerResponse);
  });
  // P1 #994 fix: tell the worker which parser-routing environment it's in.
  // Workers have their own globalThis realm and can't read flags the
  // renderer sets on window, so we propagate via the existing init
  // message. The chunking-host renderer is the only context where the
  // parser-host bridge (window.parserHost, set up via preload contextBridge)
  // is available — its presence is the deterministic signal that this
  // worker should route oxc parses through the IPC bridge.
  transport.postMessage(buildInitMessage());

  let requestIdCounter = 0;

  return {
    chunkBatch(
      files: Array<{
        fileRecordId: string;
        content: string;
        fileName: string;
        filePath: string;
      }>,
      options: ChunkingRequestOptions,
      callbacks?: ChunkingBatchCallbacks
    ): Promise<ChunkResult[]> {
      const failure = runtime.getFailure();
      if (failure) {
        return Promise.reject(failure);
      }
      return new Promise((resolve, reject) => {
        batchResolve = resolve;
        batchReject = reject;
        batchCallbacks = callbacks ?? null;
        batchFileIds = files.map((f) => f.fileRecordId);
        batchResults.clear();

        const requests = files.map((file) => ({
          content: file.content,
          fileName: file.fileName,
          filePath: file.filePath,
          fileRecordId: file.fileRecordId,
          id: `chunk-${++requestIdCounter}`,
          options,
        }));

        const batchRequest: ChunkBatchRequest = {
          requests,
          type: 'chunk-batch',
        };

        transport.postMessage(batchRequest);
      });
    },
    chunkFile(
      fileRecordId: string,
      content: string,
      fileName: string,
      filePath: string,
      options: ChunkingRequestOptions
    ): Promise<ChunkResult> {
      const failure = runtime.getFailure();
      if (failure) {
        return Promise.reject(failure);
      }
      return new Promise((resolve, reject) => {
        const id = `chunk-${++requestIdCounter}`;

        pendingRequests.register(id, { reject, resolve });

        const request: ChunkRequest = {
          content,
          fileName,
          filePath,
          fileRecordId,
          id,
          options,
          type: 'chunk',
        };

        transport.postMessage(request);
      });
    },

    isReady(): boolean {
      return runtime.isReady();
    },

    terminate(): void {
      removeMessageListener();
      runtime.dispose();
      rejectAllPending(new Error('Chunking worker terminated'));
      worker.terminate();
      runtime.resetReady();
      runtime.clearFailure();
    },
    transportKind: 'local-worker',
  };
}
