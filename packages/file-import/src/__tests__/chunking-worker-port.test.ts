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
    clearPostedMessages: () => {
      postedMessages.length = 0;
    },
    getPostedMessages: () => postedMessages,
    postMessage: vi.fn((message: unknown) => {
      postedMessages.push(message);
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
    simulateError: (message: string) => {
      const event = { filename: 'worker.js', lineno: 1, message } as ErrorEvent;
      for (const handler of errorHandlers) {
        handler(event);
      }
    },

    // Test helpers
    simulateMessage: (data: WorkerResponse) => {
      const event = { data } as MessageEvent<WorkerResponse>;
      for (const handler of messageHandlers) {
        handler(event);
      }
    },
    terminate: vi.fn(),
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

    it('silently ignores parser-host bridge envelopes (regression #1830-warns)', () => {
      // Regression: real-world capture showed 1833 "Unknown message type
      // from worker" warns per chunking session because parser-host:invoke
      // envelopes (from oxc-ipc-adapter) flow through the same worker
      // `message` channel that this port listens on. The dedicated bridge
      // handler in chunking-worker-context.tsx is the sole consumer.
      // This handler must silently skip them.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      createChunkingWorkerPort(mockWorker);
      mockWorker.simulateMessage({ type: 'ready' });

      mockWorker.simulateMessage({
        payload: { content: 'x', options: {}, requestId: 'oxc-ipc-1' },
        requestId: 'oxc-ipc-1',
        type: 'parser-host:invoke',
      } as unknown as Parameters<typeof mockWorker.simulateMessage>[0]);
      mockWorker.simulateMessage({
        requestId: 'oxc-ipc-1',
        response: { ok: true, requestId: 'oxc-ipc-1', root: { type: 'Program' } },
        type: 'parser-host:reply',
      } as unknown as Parameters<typeof mockWorker.simulateMessage>[0]);

      // No warn about unknown message type — those envelopes must be
      // silently passed through to the dedicated bridge handler.
      const unknownTypeWarn = warnSpy.mock.calls.find(
        (call) =>
          typeof call[0] === 'string' && call[0].includes('Unknown message type from worker')
      );
      expect(unknownTypeWarn).toBeUndefined();
      warnSpy.mockRestore();
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
        content: 'content',
        fileName: 'test.ts',
        filePath: '/test.ts',
        fileRecordId: 'file-1',
        options: { strategy: 'sentence' },
        type: 'chunk',
      });

      // Simulate worker response
      const result: ChunkResult = {
        chunks: [
          {
            chunkIndex: 0,
            chunkSize: 7,
            chunkType: 'sentence',
            content: 'content',
            contentHash: 'hash-1',
            endLine: 1,
            endOffset: 7,
            startLine: 1,
            startOffset: 0,
            tokenCount: 10,
          },
        ],
        fileRecordId: 'file-1',
        id: (messages[0] as { id: string }).id,
        skipped: false,
        strategyUsed: 'sentence',
        totalTokens: 10,
        type: 'result',
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
        error: 'Parse error',
        fileRecordId: 'file-1',
        id: (messages[0] as { id: string }).id,
        type: 'error',
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
        { content: 'content 1', fileName: 'a.ts', filePath: '/a.ts', fileRecordId: 'file-1' },
        { content: 'content 2', fileName: 'b.ts', filePath: '/b.ts', fileRecordId: 'file-2' },
      ];

      const promise = port.chunkBatch(files, { strategy: 'sentence' });

      const messages = mockWorker.getPostedMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        requests: expect.arrayContaining([
          expect.objectContaining({ content: 'content 1', fileRecordId: 'file-1' }),
          expect.objectContaining({ content: 'content 2', fileRecordId: 'file-2' }),
        ]),
        type: 'chunk-batch',
      });

      // Simulate results for both files
      const result1: ChunkResult = {
        chunks: [],
        fileRecordId: 'file-1',
        id: 'chunk-1',
        skipped: false,
        strategyUsed: 'sentence',
        totalTokens: 10,
        type: 'result',
      };
      const result2: ChunkResult = {
        chunks: [],
        fileRecordId: 'file-2',
        id: 'chunk-2',
        skipped: false,
        strategyUsed: 'sentence',
        totalTokens: 20,
        type: 'result',
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
        { content: 'content 1', fileName: 'a.ts', filePath: '/a.ts', fileRecordId: 'file-1' },
        { content: 'content 2', fileName: 'b.ts', filePath: '/b.ts', fileRecordId: 'file-2' },
      ];

      const callbacks: ChunkingBatchCallbacks = {
        onFileComplete: vi.fn(),
        onFileError: vi.fn(),
        onProgress: vi.fn(),
      };

      const promise = port.chunkBatch(files, { strategy: 'sentence' }, callbacks);

      // Simulate progress
      const progress: ChunkProgress = {
        chunksCreated: 3,
        currentIndex: 0,
        fileRecordId: 'file-1',
        id: 'chunk-1',
        totalFiles: 2,
        type: 'progress',
      };
      mockWorker.simulateMessage(progress);

      expect(callbacks.onProgress).toHaveBeenCalledWith('file-1', 3, 0, 2);

      // Complete the batch
      mockWorker.simulateMessage({
        chunks: [],
        fileRecordId: 'file-1',
        id: 'chunk-1',
        skipped: false,
        strategyUsed: 'sentence',
        totalTokens: 10,
        type: 'result',
      } satisfies ChunkResult);

      expect(callbacks.onFileComplete).toHaveBeenCalledWith(
        'file-1',
        expect.objectContaining({ fileRecordId: 'file-1' })
      );

      mockWorker.simulateMessage({
        chunks: [],
        fileRecordId: 'file-2',
        id: 'chunk-2',
        skipped: false,
        strategyUsed: 'sentence',
        totalTokens: 20,
        type: 'result',
      } satisfies ChunkResult);

      await promise;

      expect(callbacks.onFileComplete).toHaveBeenCalledTimes(2);
    });

    it('should reject batch when any file errors', async () => {
      const port = createChunkingWorkerPort(mockWorker);
      mockWorker.simulateMessage({ type: 'ready' });
      mockWorker.clearPostedMessages();

      const files = [
        { content: 'content 1', fileName: 'a.ts', filePath: '/a.ts', fileRecordId: 'file-1' },
        { content: 'content 2', fileName: 'b.ts', filePath: '/b.ts', fileRecordId: 'file-2' },
      ];

      const callbacks: ChunkingBatchCallbacks = {
        onFileError: vi.fn(),
      };

      const promise = port.chunkBatch(files, { strategy: 'sentence' }, callbacks);

      // First file errors
      const error: ChunkError = {
        error: 'Parse failed',
        fileRecordId: 'file-1',
        id: 'chunk-1',
        type: 'error',
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
        { content: 'content 1', fileName: 'a.ts', filePath: '/a.ts', fileRecordId: 'file-1' },
        { content: 'content 2', fileName: 'b.ts', filePath: '/b.ts', fileRecordId: 'file-2' },
      ];

      const promise = port.chunkBatch(files, { strategy: 'sentence', tokenTrueSizing: true });

      mockWorker.simulateMessage({
        error: 'Error: Accurate token counting unavailable: tiktoken encoder failed to initialize',
        fileRecordId: 'file-1',
        id: 'chunk-1',
        type: 'error',
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
            content: 'const marker = "<|endoftext|>";',
            fileName: 'a.ts',
            filePath: '/a.ts',
            fileRecordId: 'file-1',
          },
        ],
        { strategy: 'sentence', tokenTrueSizing: true }
      );

      mockWorker.simulateMessage({
        error:
          'Accurate token counting failed: The text contains a special token that is not allowed: <|endoftext|>',
        fileRecordId: 'file-1',
        id: 'chunk-1',
        type: 'error',
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
        chunks: [],
        fileRecordId: 'file-2',
        id: nextRequest.id,
        skipped: false,
        strategyUsed: 'sentence',
        totalTokens: 4,
        type: 'result',
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
        chunkSize: 11,
        chunkType: 'sentence' as const,
        content: 'First chunk',
        contentHash: 'hash-1',
        endLine: 2,
        endOffset: 11,
        startLine: 1,
        startOffset: 0,
        tokenCount: 10,
      },
      {
        chunkIndex: 1,
        chunkSize: 12,
        chunkType: 'sentence' as const,
        content: 'Second chunk',
        contentHash: 'hash-2',
        endLine: 6,
        endOffset: 25,
        startLine: 4,
        startOffset: 13,
        tokenCount: 15,
      },
    ];

    const inserts = toFileChunkInserts('file-123', chunks);

    expect(inserts).toHaveLength(2);
    expect(inserts[0]).toMatchObject({
      chunkIndex: 0,
      content: 'First chunk',
      contentHash: 'hash-1',
      endLine: 2,
      endOffset: 11,
      fileRecordId: 'file-123',
      id: 'file-123_chunk_0',
      startLine: 1,
      startOffset: 0,
      tokenCount: 10,
    });
    expect(inserts[1]).toMatchObject({
      chunkIndex: 1,
      fileRecordId: 'file-123',
      id: 'file-123_chunk_1',
    });
  });

  it('should include embeddingSetId when provided', () => {
    const chunks = [
      {
        chunkIndex: 0,
        chunkSize: 5,
        chunkType: 'sentence' as const,
        content: 'Chunk',
        contentHash: 'hash-1',
        endLine: 1,
        endOffset: 5,
        startLine: 1,
        startOffset: 0,
        tokenCount: 5,
      },
    ];

    const inserts = toFileChunkInserts('file-123', chunks, 'embedding-set-1');

    expect(inserts[0]?.embeddingSetId).toBe('embedding-set-1');
  });

  it('should not include embeddingSetId when not provided', () => {
    const chunks = [
      {
        chunkIndex: 0,
        chunkSize: 5,
        chunkType: 'sentence' as const,
        content: 'Chunk',
        contentHash: 'hash-1',
        endLine: 1,
        endOffset: 5,
        startLine: 1,
        startOffset: 0,
        tokenCount: 5,
      },
    ];

    const inserts = toFileChunkInserts('file-123', chunks);

    expect(inserts[0]).toBeDefined();
    expect(Object.hasOwn(inserts[0] as object, 'embeddingSetId')).toBe(false);
  });

  it('should reject chunks missing source range metadata', () => {
    const chunks = [
      {
        chunkIndex: 0,
        chunkSize: 5,
        chunkType: 'sentence' as const,
        content: 'Chunk',
        contentHash: 'hash-1',
        tokenCount: 5,
      },
    ];

    expect(() =>
      toFileChunkInserts('file-123', chunks as unknown as Parameters<typeof toFileChunkInserts>[1])
    ).toThrow('Chunk 0 has invalid required source range metadata.');
  });
});
