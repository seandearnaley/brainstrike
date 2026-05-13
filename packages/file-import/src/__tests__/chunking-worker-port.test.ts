/**
 * Tests for ChunkingWorkerPort - Worker lifecycle and message handling.
 *
 * These tests use a mock Worker to verify:
 * - Worker initialization and ready state
 * - Single file chunking
 * - Batch processing with progress callbacks
 * - Error handling
 * - Cleanup on termination
 */

import type {
  ChunkError,
  ChunkProgress,
  ChunkResult,
  WorkerResponse,
} from '@brainstrike/chunking-worker';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ChunkingBatchCallbacks,
  createChunkingWorkerPort,
  toFileChunkInserts,
} from '../chunking-worker-port';

/**
 * Create a mock Worker that allows simulating worker responses.
 */
function createMockWorker() {
  const messageHandlers: Array<(event: MessageEvent) => void> = [];
  const errorHandlers: Array<(event: ErrorEvent) => void> = [];
  const postedMessages: unknown[] = [];

  const mockWorker = {
    addEventListener: vi.fn((type: string, handler: (event: unknown) => void) => {
      if (type === 'message') {
        messageHandlers.push(handler as (event: MessageEvent) => void);
      } else if (type === 'error') {
        errorHandlers.push(handler as (event: ErrorEvent) => void);
      }
    }),
    removeEventListener: vi.fn((type: string, handler: (event: unknown) => void) => {
      if (type === 'message') {
        const idx = messageHandlers.indexOf(handler as (event: MessageEvent) => void);
        if (idx >= 0) {
          messageHandlers.splice(idx, 1);
        }
      } else if (type === 'error') {
        const idx = errorHandlers.indexOf(handler as (event: ErrorEvent) => void);
        if (idx >= 0) {
          errorHandlers.splice(idx, 1);
        }
      }
    }),
    postMessage: vi.fn((message: unknown) => {
      postedMessages.push(message);
    }),
    terminate: vi.fn(),

    // Test helpers
    simulateMessage: (data: WorkerResponse) => {
      const event = { data } as MessageEvent<WorkerResponse>;
      for (const handler of messageHandlers) {
        handler(event);
      }
    },
    simulateError: (message: string) => {
      const event = { message, filename: 'worker.js', lineno: 1 } as ErrorEvent;
      for (const handler of errorHandlers) {
        handler(event);
      }
    },
    getPostedMessages: () => postedMessages,
    clearPostedMessages: () => {
      postedMessages.length = 0;
    },
  };

  return mockWorker as unknown as Worker & {
    simulateMessage: (data: WorkerResponse) => void;
    simulateError: (message: string) => void;
    getPostedMessages: () => unknown[];
    clearPostedMessages: () => void;
  };
}

describe('createChunkingWorkerPort', () => {
  let mockWorker: ReturnType<typeof createMockWorker>;

  beforeEach(() => {
    mockWorker = createMockWorker();
  });

  describe('initialization', () => {
    it('should start with isReady() returning false', () => {
      const port = createChunkingWorkerPort(mockWorker);
      expect(port.isReady()).toBe(false);
      expect(mockWorker.getPostedMessages()).toEqual([{ type: 'init' }]);
    });

    it('should set isReady() to true when worker sends ready message', () => {
      const port = createChunkingWorkerPort(mockWorker);

      mockWorker.simulateMessage({ type: 'ready' });

      expect(port.isReady()).toBe(true);
    });
  });

  describe('chunkFile', () => {
    it('should post a chunk request to the worker', async () => {
      const port = createChunkingWorkerPort(mockWorker);
      mockWorker.simulateMessage({ type: 'ready' });
      mockWorker.clearPostedMessages();

      // Start chunking but don't await yet
      const promise = port.chunkFile('file-1', 'content', 'test.ts', '/test.ts', {
        strategy: 'sentence',
      });

      // Verify the message was posted
      const messages = mockWorker.getPostedMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        type: 'chunk',
        fileRecordId: 'file-1',
        content: 'content',
        fileName: 'test.ts',
        filePath: '/test.ts',
        options: { strategy: 'sentence' },
      });

      // Simulate worker response
      const result: ChunkResult = {
        type: 'result',
        id: (messages[0] as { id: string }).id,
        fileRecordId: 'file-1',
        chunks: [
          {
            chunkIndex: 0,
            content: 'content',
            contentHash: 'hash-1',
            startLine: 1,
            endLine: 1,
            startOffset: 0,
            endOffset: 7,
            tokenCount: 10,
            chunkType: 'sentence',
            chunkSize: 7,
          },
        ],
        strategyUsed: 'sentence',
        totalTokens: 10,
        skipped: false,
      };
      mockWorker.simulateMessage(result);

      // Await and verify result
      const actual = await promise;
      expect(actual).toEqual(result);
    });

    it('should reject with error when worker reports error', async () => {
      const port = createChunkingWorkerPort(mockWorker);
      mockWorker.simulateMessage({ type: 'ready' });
      mockWorker.clearPostedMessages();

      const promise = port.chunkFile('file-1', 'bad content', 'test.ts', '/test.ts', {
        strategy: 'sentence',
      });

      const messages = mockWorker.getPostedMessages();
      const error: ChunkError = {
        type: 'error',
        id: (messages[0] as { id: string }).id,
        fileRecordId: 'file-1',
        error: 'Parse error',
      };
      mockWorker.simulateMessage(error);

      await expect(promise).rejects.toThrow('Parse error');
    });
  });

  describe('chunkBatch', () => {
    it('should post a batch request to the worker', async () => {
      const port = createChunkingWorkerPort(mockWorker);
      mockWorker.simulateMessage({ type: 'ready' });
      mockWorker.clearPostedMessages();

      const files = [
        { fileRecordId: 'file-1', content: 'content 1', fileName: 'a.ts', filePath: '/a.ts' },
        { fileRecordId: 'file-2', content: 'content 2', fileName: 'b.ts', filePath: '/b.ts' },
      ];

      const promise = port.chunkBatch(files, { strategy: 'sentence' });

      const messages = mockWorker.getPostedMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        type: 'chunk-batch',
        requests: expect.arrayContaining([
          expect.objectContaining({ fileRecordId: 'file-1', content: 'content 1' }),
          expect.objectContaining({ fileRecordId: 'file-2', content: 'content 2' }),
        ]),
      });

      // Simulate results for both files
      const result1: ChunkResult = {
        type: 'result',
        id: 'chunk-1',
        fileRecordId: 'file-1',
        chunks: [],
        strategyUsed: 'sentence',
        totalTokens: 10,
        skipped: false,
      };
      const result2: ChunkResult = {
        type: 'result',
        id: 'chunk-2',
        fileRecordId: 'file-2',
        chunks: [],
        strategyUsed: 'sentence',
        totalTokens: 20,
        skipped: false,
      };

      mockWorker.simulateMessage(result1);
      mockWorker.simulateMessage(result2);

      const results = await promise;
      expect(results).toHaveLength(2);
      expect(results[0]?.fileRecordId).toBe('file-1');
      expect(results[1]?.fileRecordId).toBe('file-2');
    });

    it('should call progress callbacks during batch processing', async () => {
      const port = createChunkingWorkerPort(mockWorker);
      mockWorker.simulateMessage({ type: 'ready' });
      mockWorker.clearPostedMessages();

      const files = [
        { fileRecordId: 'file-1', content: 'content 1', fileName: 'a.ts', filePath: '/a.ts' },
        { fileRecordId: 'file-2', content: 'content 2', fileName: 'b.ts', filePath: '/b.ts' },
      ];

      const callbacks: ChunkingBatchCallbacks = {
        onProgress: vi.fn(),
        onFileComplete: vi.fn(),
        onFileError: vi.fn(),
      };

      const promise = port.chunkBatch(files, { strategy: 'sentence' }, callbacks);

      // Simulate progress
      const progress: ChunkProgress = {
        type: 'progress',
        id: 'chunk-1',
        fileRecordId: 'file-1',
        chunksCreated: 3,
        currentIndex: 0,
        totalFiles: 2,
      };
      mockWorker.simulateMessage(progress);

      expect(callbacks.onProgress).toHaveBeenCalledWith('file-1', 3, 0, 2);

      // Complete the batch
      mockWorker.simulateMessage({
        type: 'result',
        id: 'chunk-1',
        fileRecordId: 'file-1',
        chunks: [],
        strategyUsed: 'sentence',
        totalTokens: 10,
        skipped: false,
      } satisfies ChunkResult);

      expect(callbacks.onFileComplete).toHaveBeenCalledWith(
        'file-1',
        expect.objectContaining({ fileRecordId: 'file-1' })
      );

      mockWorker.simulateMessage({
        type: 'result',
        id: 'chunk-2',
        fileRecordId: 'file-2',
        chunks: [],
        strategyUsed: 'sentence',
        totalTokens: 20,
        skipped: false,
      } satisfies ChunkResult);

      await promise;

      expect(callbacks.onFileComplete).toHaveBeenCalledTimes(2);
    });

    it('should reject batch when any file errors', async () => {
      const port = createChunkingWorkerPort(mockWorker);
      mockWorker.simulateMessage({ type: 'ready' });
      mockWorker.clearPostedMessages();

      const files = [
        { fileRecordId: 'file-1', content: 'content 1', fileName: 'a.ts', filePath: '/a.ts' },
        { fileRecordId: 'file-2', content: 'content 2', fileName: 'b.ts', filePath: '/b.ts' },
      ];

      const callbacks: ChunkingBatchCallbacks = {
        onFileError: vi.fn(),
      };

      const promise = port.chunkBatch(files, { strategy: 'sentence' }, callbacks);

      // First file errors
      const error: ChunkError = {
        type: 'error',
        id: 'chunk-1',
        fileRecordId: 'file-1',
        error: 'Parse failed',
      };
      mockWorker.simulateMessage(error);

      expect(callbacks.onFileError).toHaveBeenCalledWith('file-1', 'Parse failed');
      await expect(promise).rejects.toThrow('Chunking batch failed for file-1: Parse failed');
    });

    it('enters terminal failure state on tokenizer initialization errors', async () => {
      const port = createChunkingWorkerPort(mockWorker);
      mockWorker.simulateMessage({ type: 'ready' });
      mockWorker.clearPostedMessages();

      const files = [
        { fileRecordId: 'file-1', content: 'content 1', fileName: 'a.ts', filePath: '/a.ts' },
        { fileRecordId: 'file-2', content: 'content 2', fileName: 'b.ts', filePath: '/b.ts' },
      ];

      const promise = port.chunkBatch(files, { strategy: 'sentence', tokenTrueSizing: true });

      mockWorker.simulateMessage({
        type: 'error',
        id: 'chunk-1',
        fileRecordId: 'file-1',
        error: 'Error: Accurate token counting unavailable: tiktoken encoder failed to initialize',
      } satisfies ChunkError);

      await expect(promise).rejects.toThrow('terminal tokenizer failure state');
      expect(port.isReady()).toBe(false);
      expect(mockWorker.terminate).toHaveBeenCalled();

      await expect(
        port.chunkFile('file-3', 'content', 'c.ts', '/c.ts', {
          strategy: 'sentence',
          tokenTrueSizing: true,
        })
      ).rejects.toThrow('terminal tokenizer failure state');
    });

    it('keeps content-level tokenization failures file-scoped and reusable', async () => {
      const port = createChunkingWorkerPort(mockWorker);
      mockWorker.simulateMessage({ type: 'ready' });
      mockWorker.clearPostedMessages();

      const batchPromise = port.chunkBatch(
        [
          {
            fileRecordId: 'file-1',
            content: 'const marker = "<|endoftext|>";',
            fileName: 'a.ts',
            filePath: '/a.ts',
          },
        ],
        { strategy: 'sentence', tokenTrueSizing: true }
      );

      mockWorker.simulateMessage({
        type: 'error',
        id: 'chunk-1',
        fileRecordId: 'file-1',
        error:
          'Accurate token counting failed: The text contains a special token that is not allowed: <|endoftext|>',
      } satisfies ChunkError);

      await expect(batchPromise).rejects.toThrow(
        'Chunking batch failed for file-1: Accurate token counting failed: The text contains a special token that is not allowed: <|endoftext|>'
      );
      expect(port.isReady()).toBe(true);
      expect(mockWorker.terminate).not.toHaveBeenCalled();

      const filePromise = port.chunkFile('file-2', 'const ok = true;', 'b.ts', '/b.ts', {
        strategy: 'sentence',
        tokenTrueSizing: true,
      });
      const nextRequest = mockWorker.getPostedMessages().at(-1) as { id: string };

      mockWorker.simulateMessage({
        type: 'result',
        id: nextRequest.id,
        fileRecordId: 'file-2',
        chunks: [],
        strategyUsed: 'sentence',
        totalTokens: 4,
        skipped: false,
      } satisfies ChunkResult);

      await expect(filePromise).resolves.toMatchObject({
        fileRecordId: 'file-2',
        totalTokens: 4,
      });
    });
  });

  describe('terminate', () => {
    it('should clean up resources on termination', () => {
      const port = createChunkingWorkerPort(mockWorker);
      mockWorker.simulateMessage({ type: 'ready' });
      expect(port.isReady()).toBe(true);

      port.terminate();

      expect(port.isReady()).toBe(false);
      expect(mockWorker.terminate).toHaveBeenCalled();
      expect(mockWorker.removeEventListener).toHaveBeenCalled();
    });
  });
});

describe('toFileChunkInserts', () => {
  it('should convert portable chunks to database inserts', () => {
    const chunks = [
      {
        chunkIndex: 0,
        content: 'First chunk',
        contentHash: 'hash-1',
        tokenCount: 10,
        chunkType: 'sentence' as const,
        chunkSize: 11,
        startLine: 1,
        endLine: 2,
        startOffset: 0,
        endOffset: 11,
      },
      {
        chunkIndex: 1,
        content: 'Second chunk',
        contentHash: 'hash-2',
        tokenCount: 15,
        chunkType: 'sentence' as const,
        chunkSize: 12,
        startLine: 4,
        endLine: 6,
        startOffset: 13,
        endOffset: 25,
      },
    ];

    const inserts = toFileChunkInserts('file-123', chunks);

    expect(inserts).toHaveLength(2);
    expect(inserts[0]).toMatchObject({
      id: 'file-123_chunk_0',
      fileRecordId: 'file-123',
      chunkIndex: 0,
      content: 'First chunk',
      contentHash: 'hash-1',
      tokenCount: 10,
      startLine: 1,
      endLine: 2,
      startOffset: 0,
      endOffset: 11,
    });
    expect(inserts[1]).toMatchObject({
      id: 'file-123_chunk_1',
      fileRecordId: 'file-123',
      chunkIndex: 1,
    });
  });

  it('should include embeddingSetId when provided', () => {
    const chunks = [
      {
        chunkIndex: 0,
        content: 'Chunk',
        contentHash: 'hash-1',
        startLine: 1,
        endLine: 1,
        startOffset: 0,
        endOffset: 5,
        tokenCount: 5,
        chunkType: 'sentence' as const,
        chunkSize: 5,
      },
    ];

    const inserts = toFileChunkInserts('file-123', chunks, 'embedding-set-1');

    expect(inserts[0]?.embeddingSetId).toBe('embedding-set-1');
  });

  it('should not include embeddingSetId when not provided', () => {
    const chunks = [
      {
        chunkIndex: 0,
        content: 'Chunk',
        contentHash: 'hash-1',
        startLine: 1,
        endLine: 1,
        startOffset: 0,
        endOffset: 5,
        tokenCount: 5,
        chunkType: 'sentence' as const,
        chunkSize: 5,
      },
    ];

    const inserts = toFileChunkInserts('file-123', chunks);

    expect(inserts[0]).toBeDefined();
    expect(Object.hasOwn(inserts[0] as object, 'embeddingSetId')).toBe(false);
  });
});
