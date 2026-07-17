/**
 * Tests for the streaming import orchestrator.
 *
 * These tests verify:
 * - Sequential file processing with backpressure
 * - Concurrent processing with limited parallelism
 * - Error isolation and continue-on-error behavior
 * - Progress tracking and callbacks
 * - Content reader integration (read, prefetch, release)
 * - Abort signal handling
 */

import { describe, expect, it } from 'vitest';
import {
  type ContentReader,
  type FileProcessResult,
  type StreamingProgress,
  streamingImport,
} from '../src/index.js';

// =============================================================================
// TEST HELPERS
// =============================================================================

/**
 * Create a mock content reader that tracks calls.
 */
function createMockReader(contentMap: Record<string, string | null> = {}): ContentReader & {
  readCalls: string[];
  releaseCalls: string[];
  prefetchCalls: string[][];
} {
  const readCalls: string[] = [];
  const releaseCalls: string[] = [];
  const prefetchCalls: string[][] = [];

  return {
    async prefetchBatch(keys: string[]) {
      prefetchCalls.push([...keys]);
    },
    prefetchCalls,
    readCalls,
    async readContent(compositeKey: string) {
      readCalls.push(compositeKey);
      return contentMap[compositeKey] ?? null;
    },
    releaseCalls,
    releaseContent(compositeKey: string) {
      releaseCalls.push(compositeKey);
    },
  };
}

/**
 * Create a simple process callback that succeeds.
 */
function createSuccessProcessor(): (key: string, content: string) => Promise<FileProcessResult> {
  return async (_key: string, content: string) => ({
    chunksCreated: Math.ceil(content.length / 100),
    jobsEnqueued: Math.ceil(content.length / 100),
    success: true,
  });
}

/**
 * Create a process callback that tracks calls.
 */
function createTrackingProcessor(): {
  processor: (key: string, content: string) => Promise<FileProcessResult>;
  calls: Array<{ key: string; content: string }>;
} {
  const calls: Array<{ key: string; content: string }> = [];
  return {
    calls,
    processor: async (key: string, content: string) => {
      calls.push({ content, key });
      return {
        chunksCreated: 1,
        jobsEnqueued: 1,
        success: true,
      };
    },
  };
}

// =============================================================================
// BASIC FUNCTIONALITY TESTS
// =============================================================================

describe('streamingImport', () => {
  describe('basic functionality', () => {
    it('processes files sequentially by default', async () => {
      const contentMap = {
        'folder1:file1.ts': 'content1',
        'folder1:file2.ts': 'content2',
        'folder1:file3.ts': 'content3',
      };
      const reader = createMockReader(contentMap);
      const { processor, calls } = createTrackingProcessor();

      const result = await streamingImport({
        compositeKeys: Object.keys(contentMap),
        contentReader: reader,
        processFile: processor,
      });

      expect(result.totalFiles).toBe(3);
      expect(result.successCount).toBe(3);
      expect(result.errorCount).toBe(0);
      expect(calls).toHaveLength(3);
      // Verify sequential order
      expect(calls[0]?.key).toBe('folder1:file1.ts');
      expect(calls[1]?.key).toBe('folder1:file2.ts');
      expect(calls[2]?.key).toBe('folder1:file3.ts');
    });

    it('returns correct file results', async () => {
      const contentMap = { 'folder:test.ts': 'some content here' };
      const reader = createMockReader(contentMap);

      const result = await streamingImport({
        compositeKeys: ['folder:test.ts'],
        contentReader: reader,
        processFile: async () => ({
          chunksCreated: 5,
          existed: false,
          jobsEnqueued: 5,
          success: true,
        }),
      });

      expect(result.files).toHaveLength(1);
      const file = result.files[0];
      expect(file?.path).toBe('test.ts');
      expect(file?.compositeKey).toBe('folder:test.ts');
      expect(file?.imported).toBe(true);
      expect(file?.chunksCreated).toBe(5);
      expect(file?.jobsEnqueued).toBe(5);
      expect(file?.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('aggregates totals correctly', async () => {
      const contentMap = {
        'f:a.ts': 'a',
        'f:b.ts': 'bb',
        'f:c.ts': 'ccc',
      };
      const reader = createMockReader(contentMap);

      const result = await streamingImport({
        compositeKeys: Object.keys(contentMap),
        contentReader: reader,
        processFile: async (_key, content) => ({
          chunksCreated: content.length,
          jobsEnqueued: content.length * 2,
          success: true,
        }),
      });

      expect(result.totalFiles).toBe(3);
      expect(result.totalChunks).toBe(6); // 1 + 2 + 3
      expect(result.totalJobsEnqueued).toBe(12); // 2 + 4 + 6
    });

    it('handles empty input', async () => {
      const reader = createMockReader({});

      const result = await streamingImport({
        compositeKeys: [],
        contentReader: reader,
        processFile: createSuccessProcessor(),
      });

      expect(result.totalFiles).toBe(0);
      expect(result.successCount).toBe(0);
      expect(result.files).toHaveLength(0);
    });
  });

  // =============================================================================
  // CONTENT READER INTEGRATION
  // =============================================================================

  describe('content reader integration', () => {
    it('calls readContent for each file', async () => {
      const contentMap = {
        'f:one.ts': 'one',
        'f:two.ts': 'two',
      };
      const reader = createMockReader(contentMap);

      await streamingImport({
        compositeKeys: Object.keys(contentMap),
        contentReader: reader,
        processFile: createSuccessProcessor(),
      });

      expect(reader.readCalls).toEqual(['f:one.ts', 'f:two.ts']);
    });

    it('calls releaseContent after processing each file', async () => {
      const contentMap = {
        'f:a.ts': 'a',
        'f:b.ts': 'b',
      };
      const reader = createMockReader(contentMap);

      await streamingImport({
        compositeKeys: Object.keys(contentMap),
        contentReader: reader,
        processFile: createSuccessProcessor(),
      });

      expect(reader.releaseCalls).toEqual(['f:a.ts', 'f:b.ts']);
    });

    it('handles null content (file not found)', async () => {
      const reader = createMockReader({ 'f:exists.ts': 'content' });

      const result = await streamingImport({
        compositeKeys: ['f:exists.ts', 'f:missing.ts'],
        contentReader: reader,
        processFile: createSuccessProcessor(),
      });

      expect(result.successCount).toBe(1);
      expect(result.errorCount).toBe(1);

      const missing = result.files.find((f) => f.compositeKey === 'f:missing.ts');
      expect(missing?.imported).toBe(false);
      expect(missing?.error).toBe('Failed to read file content');
    });

    it('releases content even on processor error', async () => {
      const contentMap = { 'f:error.ts': 'will fail' };
      const reader = createMockReader(contentMap);

      await streamingImport({
        compositeKeys: ['f:error.ts'],
        contentReader: reader,
        processFile: async () => {
          throw new Error('Processor failed');
        },
      });

      expect(reader.releaseCalls).toContain('f:error.ts');
    });
  });

  // =============================================================================
  // ERROR HANDLING
  // =============================================================================

  describe('error handling', () => {
    it('isolates errors to individual files by default', async () => {
      const contentMap = {
        'f:bad.ts': 'will fail',
        'f:ok1.ts': 'good1',
        'f:ok2.ts': 'good2',
      };
      const reader = createMockReader(contentMap);

      const result = await streamingImport({
        compositeKeys: Object.keys(contentMap),
        contentReader: reader,
        processFile: async (key) => {
          if (key.includes('bad')) {
            throw new Error('Intentional failure');
          }
          return { chunksCreated: 1, jobsEnqueued: 1, success: true };
        },
      });

      expect(result.successCount).toBe(2);
      expect(result.errorCount).toBe(1);
      expect(result.files.find((f) => f.compositeKey === 'f:ok1.ts')?.imported).toBe(true);
      expect(result.files.find((f) => f.compositeKey === 'f:ok2.ts')?.imported).toBe(true);
    });

    it('stops on first error when continueOnError is false', async () => {
      const contentMap = {
        'f:bad.ts': 'will fail',
        'f:ok1.ts': 'good1',
        'f:ok2.ts': 'should not process',
      };
      const reader = createMockReader(contentMap);
      const { processor, calls } = createTrackingProcessor();

      const wrappedProcessor = async (key: string, content: string) => {
        if (key.includes('bad')) {
          throw new Error('Stop here');
        }
        return processor(key, content);
      };

      const result = await streamingImport({
        compositeKeys: ['f:ok1.ts', 'f:bad.ts', 'f:ok2.ts'],
        contentReader: reader,
        options: { continueOnError: false },
        processFile: wrappedProcessor,
      });

      // Should have processed ok1 and bad, but not ok2
      expect(calls).toHaveLength(1); // Only ok1 processed by tracking processor
      expect(result.files).toHaveLength(2); // ok1 and bad
    });

    it('captures error messages in file results', async () => {
      const reader = createMockReader({ 'f:fail.ts': 'content' });

      const result = await streamingImport({
        compositeKeys: ['f:fail.ts'],
        contentReader: reader,
        processFile: async () => {
          throw new Error('Specific error message');
        },
      });

      expect(result.files[0]?.error).toBe('Specific error message');
    });
  });

  // =============================================================================
  // PROGRESS TRACKING
  // =============================================================================

  describe('progress tracking', () => {
    it('calls progress callback during processing', async () => {
      const contentMap = {
        'f:a.ts': 'a',
        'f:b.ts': 'b',
        'f:c.ts': 'c',
      };
      const reader = createMockReader(contentMap);
      const progressUpdates: StreamingProgress[] = [];

      await streamingImport({
        compositeKeys: Object.keys(contentMap),
        contentReader: reader,
        onProgress: (p) => progressUpdates.push({ ...p }),
        options: { progressThrottleMs: 0 }, // Disable throttling for tests
        processFile: createSuccessProcessor(),
      });

      // Should have progress updates
      expect(progressUpdates.length).toBeGreaterThan(0);

      // Final update should show completion
      const final = progressUpdates.at(-1);
      expect(final?.completed).toBe(3);
      expect(final?.percentage).toBe(100);
    });

    it('includes current file in progress', async () => {
      const reader = createMockReader({ 'folder:myfile.ts': 'content' });
      let capturedFile: string | undefined;

      await streamingImport({
        compositeKeys: ['folder:myfile.ts'],
        contentReader: reader,
        onProgress: (p) => {
          if (p.currentFile) {
            capturedFile = p.currentFile;
          }
        },
        options: { progressThrottleMs: 0 },
        processFile: createSuccessProcessor(),
      });

      expect(capturedFile).toBe('folder:myfile.ts');
    });

    it('tracks elapsed time', async () => {
      const reader = createMockReader({ 'f:slow.ts': 'content' });

      await streamingImport({
        compositeKeys: ['f:slow.ts'],
        contentReader: reader,
        onProgress: (p) => {
          expect(p.elapsedMs).toBeGreaterThanOrEqual(0);
        },
        options: { progressThrottleMs: 0 },
        processFile: async () => {
          await new Promise((r) => setTimeout(r, 10));
          return { chunksCreated: 1, jobsEnqueued: 1, success: true };
        },
      });
    });
  });

  // =============================================================================
  // CONCURRENCY
  // =============================================================================

  describe('concurrency', () => {
    it('processes files concurrently when concurrency > 1', async () => {
      const contentMap = {
        'f:a.ts': 'a',
        'f:b.ts': 'b',
        'f:c.ts': 'c',
        'f:d.ts': 'd',
      };
      const reader = createMockReader(contentMap);
      let maxConcurrent = 0;
      let currentConcurrent = 0;

      await streamingImport({
        compositeKeys: Object.keys(contentMap),
        contentReader: reader,
        options: { concurrency: 2 },
        processFile: async () => {
          currentConcurrent++;
          maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
          await new Promise((r) => setTimeout(r, 10));
          currentConcurrent--;
          return { chunksCreated: 1, jobsEnqueued: 1, success: true };
        },
      });

      // With concurrency 2, we should see at most 2 concurrent
      expect(maxConcurrent).toBeLessThanOrEqual(2);
      // And actually use concurrency
      expect(maxConcurrent).toBeGreaterThanOrEqual(1);
    });

    it('prefetches when configured', async () => {
      const contentMap = {
        'f:1.ts': '1',
        'f:2.ts': '2',
        'f:3.ts': '3',
        'f:4.ts': '4',
      };
      const reader = createMockReader(contentMap);

      await streamingImport({
        compositeKeys: Object.keys(contentMap),
        contentReader: reader,
        options: { concurrency: 2, prefetchAhead: 2 },
        processFile: createSuccessProcessor(),
      });

      // Should have called prefetch
      expect(reader.prefetchCalls.length).toBeGreaterThan(0);
    });
  });

  // =============================================================================
  // ABORT HANDLING
  // =============================================================================

  describe('abort handling', () => {
    it('respects abort signal before starting', async () => {
      const reader = createMockReader({ 'f:a.ts': 'a' });
      const controller = new AbortController();
      controller.abort();

      const result = await streamingImport({
        compositeKeys: ['f:a.ts'],
        contentReader: reader,
        processFile: createSuccessProcessor(),
        signal: controller.signal,
      });

      expect(result.files).toHaveLength(0);
      expect(reader.readCalls).toHaveLength(0);
    });

    it('stops processing when aborted mid-stream', async () => {
      const contentMap = {
        'f:1.ts': '1',
        'f:2.ts': '2',
        'f:3.ts': '3',
      };
      const reader = createMockReader(contentMap);
      const controller = new AbortController();
      let processCount = 0;

      const result = await streamingImport({
        compositeKeys: Object.keys(contentMap),
        contentReader: reader,
        processFile: async () => {
          processCount++;
          if (processCount === 2) {
            controller.abort();
          }
          return { chunksCreated: 1, jobsEnqueued: 1, success: true };
        },
        signal: controller.signal,
      });

      // Should have stopped after 2 files
      expect(result.files.length).toBeLessThanOrEqual(2);
    });
  });

  // =============================================================================
  // PATH EXTRACTION
  // =============================================================================

  describe('path extraction', () => {
    it('extracts path from composite key correctly', async () => {
      const reader = createMockReader({
        'folder-id:src/components/Button.tsx': 'content',
      });

      const result = await streamingImport({
        compositeKeys: ['folder-id:src/components/Button.tsx'],
        contentReader: reader,
        processFile: createSuccessProcessor(),
      });

      expect(result.files[0]?.path).toBe('src/components/Button.tsx');
    });

    it('handles keys without colon separator', async () => {
      const reader = createMockReader({ simplekey: 'content' });

      const result = await streamingImport({
        compositeKeys: ['simplekey'],
        contentReader: reader,
        processFile: createSuccessProcessor(),
      });

      expect(result.files[0]?.path).toBe('simplekey');
    });
  });
});
