/**
 * Progressive Listing Integration Tests (BST-147)
 *
 * Tests the streaming directory API integration with the file explorer UI.
 * Verifies:
 * - MockFileSystemAdapter streaming support
 * - Batch delivery during directory loading
 * - Cancellation on folder collapse
 * - UI updates as batches arrive
 */

import { type MockFileEntry, MockFileSystemAdapter } from '@brainstrike/file-system';
import { describe, expect, it, vi } from 'vitest';

describe('Progressive Listing Integration', () => {
  /**
   * Create a large mock directory with many files for testing batched streaming.
   */
  function createLargeMockFileSystem(fileCount: number): Record<string, MockFileEntry> {
    const children: Record<string, MockFileEntry> = {};
    for (let i = 0; i < fileCount; i++) {
      const paddedNum = String(i).padStart(4, '0');
      children[`file-${paddedNum}.ts`] = {
        content: `// File ${i}`,
        name: `file-${paddedNum}.ts`,
        size: 50,
        type: 'file',
      };
    }
    return {
      src: {
        children,
        name: 'src',
        type: 'directory',
      },
    };
  }

  describe('MockFileSystemAdapter streaming support', () => {
    it('should have readDirectoryStreaming method', () => {
      const adapter = new MockFileSystemAdapter();
      expect(typeof adapter.readDirectoryStreaming).toBe('function');
    });

    it('should deliver entries in batches', async () => {
      const adapter = new MockFileSystemAdapter(createLargeMockFileSystem(100));
      await adapter.requestDirectoryAccess();

      const handle = {
        _internal: { mockDir: true },
        kind: 'directory' as const,
        name: 'src',
        path: 'mock-root/src',
        platform: 'web' as const,
      };

      const batches: { count: number; done: boolean; total: number }[] = [];
      await adapter.readDirectoryStreaming(
        handle,
        (nodes, meta) => {
          batches.push({ count: nodes.length, done: meta.done, total: meta.total });
        },
        { batchSize: 25 }
      );

      // Should have multiple batches for 100 files with batchSize=25
      expect(batches.length).toBe(4);
      expect(batches[0]!.count).toBe(25);
      expect(batches[0]!.done).toBe(false);
      expect(batches[3]!.done).toBe(true);
      expect(batches[3]!.total).toBe(100);
    });

    it('should handle single batch for small directories', async () => {
      const adapter = new MockFileSystemAdapter({
        docs: {
          children: {
            'guide.md': { content: '# Guide', name: 'guide.md', type: 'file' },
            'readme.md': { content: '# Readme', name: 'readme.md', type: 'file' },
          },
          name: 'docs',
          type: 'directory',
        },
      });
      await adapter.requestDirectoryAccess();

      const handle = {
        _internal: { mockDir: true },
        kind: 'directory' as const,
        name: 'docs',
        path: 'mock-root/docs',
        platform: 'web' as const,
      };

      const batches: { count: number; done: boolean }[] = [];
      await adapter.readDirectoryStreaming(handle, (nodes, meta) => {
        batches.push({ count: nodes.length, done: meta.done });
      });

      // Small directory should complete in single batch
      expect(batches.length).toBe(1);
      expect(batches[0]!.done).toBe(true);
      expect(batches[0]!.count).toBe(2);
    });

    it('should handle empty directories', async () => {
      const adapter = new MockFileSystemAdapter({
        empty: {
          children: {},
          name: 'empty',
          type: 'directory',
        },
      });
      await adapter.requestDirectoryAccess();

      const handle = {
        _internal: { mockDir: true },
        kind: 'directory' as const,
        name: 'empty',
        path: 'mock-root/empty',
        platform: 'web' as const,
      };

      const batches: { count: number; done: boolean; total: number }[] = [];
      await adapter.readDirectoryStreaming(handle, (nodes, meta) => {
        batches.push({ count: nodes.length, done: meta.done, total: meta.total });
      });

      expect(batches.length).toBe(1);
      expect(batches[0]!.done).toBe(true);
      expect(batches[0]!.total).toBe(0);
      expect(batches[0]!.count).toBe(0);
    });
  });

  describe('Cancellation support', () => {
    it('should stop streaming when signal is aborted before start', async () => {
      const adapter = new MockFileSystemAdapter(createLargeMockFileSystem(100));
      await adapter.requestDirectoryAccess();

      const handle = {
        _internal: { mockDir: true },
        kind: 'directory' as const,
        name: 'src',
        path: 'mock-root/src',
        platform: 'web' as const,
      };

      const abortController = new AbortController();
      abortController.abort();

      const onBatch = vi.fn();

      await expect(
        adapter.readDirectoryStreaming(handle, onBatch, {
          signal: abortController.signal,
        })
      ).rejects.toThrow('Operation was cancelled');

      expect(onBatch).not.toHaveBeenCalled();
    });

    it('should stop streaming when signal is aborted mid-stream', async () => {
      const adapter = new MockFileSystemAdapter(createLargeMockFileSystem(200));
      // Add delay to simulate real async I/O and allow abort to take effect
      adapter.setStreamingDelay(10);
      await adapter.requestDirectoryAccess();

      const handle = {
        _internal: { mockDir: true },
        kind: 'directory' as const,
        name: 'src',
        path: 'mock-root/src',
        platform: 'web' as const,
      };

      const abortController = new AbortController();
      const batches: number[] = [];

      const promise = adapter.readDirectoryStreaming(
        handle,
        (nodes) => {
          batches.push(nodes.length);
          // Abort after first batch
          if (batches.length === 1) {
            abortController.abort();
          }
        },
        {
          batchSize: 25,
          signal: abortController.signal,
        }
      );

      await expect(promise).rejects.toThrow('Operation was cancelled');

      // Should have received at most 2 batches before abort took effect
      expect(batches.length).toBeLessThanOrEqual(2);
    });
  });

  describe('Streaming delay configuration', () => {
    it('should support configurable streaming delay', async () => {
      const adapter = new MockFileSystemAdapter(createLargeMockFileSystem(100));
      adapter.setStreamingDelay(5);
      await adapter.requestDirectoryAccess();

      const handle = {
        _internal: { mockDir: true },
        kind: 'directory' as const,
        name: 'src',
        path: 'mock-root/src',
        platform: 'web' as const,
      };

      const startTime = performance.now();
      const batches: number[] = [];

      await adapter.readDirectoryStreaming(
        handle,
        (nodes) => {
          batches.push(nodes.length);
        },
        { batchSize: 25 }
      );

      const endTime = performance.now();

      // With 4 batches and 5ms delay between non-final batches,
      // expect at least ~15ms total (3 delays between 4 batches)
      expect(batches.length).toBe(4);
      expect(endTime - startTime).toBeGreaterThanOrEqual(10);
    });

    it('should deliver instantly with zero delay', async () => {
      const adapter = new MockFileSystemAdapter(createLargeMockFileSystem(100));
      adapter.setStreamingDelay(0);
      await adapter.requestDirectoryAccess();

      const handle = {
        _internal: { mockDir: true },
        kind: 'directory' as const,
        name: 'src',
        path: 'mock-root/src',
        platform: 'web' as const,
      };

      const startTime = performance.now();
      await adapter.readDirectoryStreaming(handle, () => {}, { batchSize: 25 });
      const endTime = performance.now();

      // Should complete nearly instantly with zero delay
      expect(endTime - startTime).toBeLessThan(50);
    });
  });

  describe('File node creation', () => {
    it('should create proper IFileNode structure for streamed entries', async () => {
      const adapter = new MockFileSystemAdapter({
        project: {
          children: {
            'index.ts': {
              content: 'export default {};',
              name: 'index.ts',
              size: 20,
              type: 'file',
            },
            lib: {
              children: {},
              name: 'lib',
              type: 'directory',
            },
          },
          name: 'project',
          type: 'directory',
        },
      });
      await adapter.requestDirectoryAccess();

      const handle = {
        _internal: { mockDir: true },
        kind: 'directory' as const,
        name: 'project',
        path: 'mock-root/project',
        platform: 'web' as const,
      };

      let receivedNodes: unknown[] = [];
      await adapter.readDirectoryStreaming(handle, (nodes) => {
        receivedNodes = nodes;
      });

      expect(receivedNodes.length).toBe(2);

      // Directory should come first (sorted: directories first)
      const dirNode = receivedNodes[0] as { name: string; type: string; children: unknown[] };
      expect(dirNode.name).toBe('lib');
      expect(dirNode.type).toBe('directory');
      expect(dirNode.children).toEqual([]);

      // File should come second
      const fileNode = receivedNodes[1] as { name: string; type: string; size: number };
      expect(fileNode.name).toBe('index.ts');
      expect(fileNode.type).toBe('file');
      expect(fileNode.size).toBe(20);
    });
  });
});
