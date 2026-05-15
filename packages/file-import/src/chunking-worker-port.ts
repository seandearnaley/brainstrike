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
  chunkBatch(
    files: Array<{
      fileRecordId: string;
      content: string;
      fileName: string;
      filePath: string;
    }>,
    options: ChunkingRequestOptions,
    callbacks?: ChunkingBatchCallbacks
  ): Promise<ChunkResult[]>;
  /**
   * Chunk a single file.
   */
  chunkFile(
    fileRecordId: string,
    content: string,
    fileName: string,
    filePath: string,
    options: ChunkingRequestOptions
  ): Promise<ChunkResult>;
  chunkFileById?: (
    fileRecordId: string,
    options: ChunkingHostProxyRequestOptions
  ) => Promise<ChunkResult>;

  /**
   * Check if the worker is ready to receive requests.
   */
  isReady(): boolean;

  /**
   * Terminate the worker and clean up resources.
   */
  terminate(): void;
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
      id: `${fileRecordId}_chunk_${chunk.chunkIndex}`,
      fileRecordId,
      chunkIndex: chunk.chunkIndex,
      content: chunk.content,
      contentHash: chunk.contentHash,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      startOffset: chunk.startOffset,
      endOffset: chunk.endOffset,
      tokenCount: chunk.tokenCount,
      chunkType: chunk.chunkType,
      chunkSize: chunk.chunkSize,
      createdAt: now,
      updatedAt: now,
    };
    // Only set embeddingSetId if provided (exactOptionalPropertyTypes compliance)
    if (embeddingSetId !== undefined) {
      insert.embeddingSetId = embeddingSetId;
    }
    return insert;
  });
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
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
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
          id: error.id,
          fileRecordId: error.fileRecordId,
          error: error.error,
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

      case 'log':
        // Forward worker logs
        logger.debug(`[Worker] ${message.message}`, message.data);
        break;

      default:
        logger.warn('Unknown message type from worker', {
          type: (message as { type?: unknown }).type,
        });
    }
  }
  removeMessageListener = transport.onMessage((message) => {
    handleMessage(message as WorkerResponse);
  });
  transport.postMessage({ type: 'init' });

  let requestIdCounter = 0;

  return {
    transportKind: 'local-worker',
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

        pendingRequests.register(id, { resolve, reject });

        const request: ChunkRequest = {
          type: 'chunk',
          id,
          fileRecordId,
          content,
          fileName,
          filePath,
          options,
        };

        transport.postMessage(request);
      });
    },

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
          id: `chunk-${++requestIdCounter}`,
          fileRecordId: file.fileRecordId,
          content: file.content,
          fileName: file.fileName,
          filePath: file.filePath,
          options,
        }));

        const batchRequest: ChunkBatchRequest = {
          type: 'chunk-batch',
          requests,
        };

        transport.postMessage(batchRequest);
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
  };
}
