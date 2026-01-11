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
import type { ChunkingStrategy, FileChunkInsert } from '@brainstrike/db';
import { createLogger } from '@brainstrike/utils';

const logger = createLogger('ChunkingWorkerPort');

/**
 * Callbacks for batch processing events.
 */
export interface ChunkingBatchCallbacks {
  onProgress?: (
    fileRecordId: string,
    chunksCreated: number,
    currentIndex: number,
    total: number
  ) => void;
  onFileComplete?: (fileRecordId: string, result: ChunkResult) => void;
  onFileError?: (fileRecordId: string, error: string) => void;
}

/**
 * Port interface for interacting with the chunking worker.
 */
export interface ChunkingWorkerPort {
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
   * Check if the worker is ready to receive requests.
   */
  isReady(): boolean;

  /**
   * Terminate the worker and clean up resources.
   */
  terminate(): void;
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
    const insert: FileChunkInsert = {
      id: `${fileRecordId}_chunk_${chunk.chunkIndex}`,
      fileRecordId,
      chunkIndex: chunk.chunkIndex,
      content: chunk.content,
      contentHash: chunk.contentHash,
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
  let ready = false;
  const pendingRequests = new Map<
    string,
    {
      resolve: (result: ChunkResult) => void;
      reject: (error: Error) => void;
    }
  >();
  let batchCallbacks: ChunkingBatchCallbacks | null = null;
  const batchResults = new Map<string, ChunkResult>();
  let batchResolve: ((results: ChunkResult[]) => void) | null = null;
  let batchFileIds: string[] = [];

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Worker message dispatch handles multiple variants.
  function handleMessage(event: MessageEvent<WorkerResponse>) {
    const message = event.data;

    switch (message.type) {
      case 'ready':
        ready = true;
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
            batchResolve = null;
            batchFileIds = [];
            batchResults.clear();
            batchCallbacks = null;
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

        // Check if this is a batch error
        if (batchFileIds.includes(error.fileRecordId)) {
          batchCallbacks?.onFileError?.(error.fileRecordId, error.error);
          // Create a failed result for this file
          const failedResult: ChunkResult = {
            type: 'result',
            id: error.id,
            fileRecordId: error.fileRecordId,
            chunks: [],
            strategyUsed: 'sentence' as ChunkingStrategy,
            totalTokens: 0,
            skipped: true,
            skipReason: error.error,
          };
          batchResults.set(error.fileRecordId, failedResult);

          // Check if batch is complete
          if (batchResults.size === batchFileIds.length && batchResolve) {
            const orderedResults = batchFileIds.map((id) => batchResults.get(id) as ChunkResult);
            batchResolve(orderedResults);
            batchResolve = null;
            batchFileIds = [];
            batchResults.clear();
            batchCallbacks = null;
          }
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

  worker.addEventListener('message', handleMessage);
  worker.addEventListener('error', (event) => {
    logger.error('Worker error event', {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
    });
  });

  let requestIdCounter = 0;

  return {
    chunkFile(
      fileRecordId: string,
      content: string,
      fileName: string,
      filePath: string,
      options: ChunkingRequestOptions
    ): Promise<ChunkResult> {
      return new Promise((resolve, reject) => {
        const id = `chunk-${++requestIdCounter}`;

        pendingRequests.set(id, { resolve, reject });

        const request: ChunkRequest = {
          type: 'chunk',
          id,
          fileRecordId,
          content,
          fileName,
          filePath,
          options,
        };

        worker.postMessage(request);
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
      return new Promise((resolve) => {
        batchResolve = resolve;
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

        worker.postMessage(batchRequest);
      });
    },

    isReady(): boolean {
      return ready;
    },

    terminate(): void {
      worker.removeEventListener('message', handleMessage);
      worker.terminate();
      ready = false;
      pendingRequests.clear();
      batchResults.clear();
      batchResolve = null;
      batchCallbacks = null;
      batchFileIds = [];
    },
  };
}
