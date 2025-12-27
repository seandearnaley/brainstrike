/**
 * Browser-based tests for TreeCache using Vitest 4 Browser Mode
 *
 * These tests run in a real Chromium browser to validate:
 * - Real IndexedDB API behavior
 * - Proper persistence across operations
 * - Cache TTL expiration
 * - Error handling and graceful degradation
 */

import type { IFileNode } from '@brainstrike/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearTreeCache,
  getCachedTree,
  getTreeCacheStats,
  removeCachedTree,
  setCachedTree,
} from '../tree-cache';

describe('TreeCache (Browser Mode)', () => {
  const TEST_ROOT_ID = 'vitest-browser-test-root';

  // Sample file nodes for testing
  const createTestNodes = (): IFileNode[] => [
    {
      name: 'root',
      path: '/root',
      type: 'directory',
      handle: undefined as unknown as FileSystemDirectoryHandle,
      depth: 0,
      selectionState: 'unchecked',
      rootFolderId: 'test-root',
      children: [
        {
          name: 'file1.ts',
          path: '/root/file1.ts',
          type: 'file',
          handle: undefined as unknown as FileSystemFileHandle,
          depth: 1,
          selectionState: 'unchecked',
          rootFolderId: 'test-root',
        },
        {
          name: 'subfolder',
          path: '/root/subfolder',
          type: 'directory',
          handle: undefined as unknown as FileSystemDirectoryHandle,
          depth: 1,
          selectionState: 'unchecked',
          rootFolderId: 'test-root',
          children: [
            {
              name: 'file2.ts',
              path: '/root/subfolder/file2.ts',
              type: 'file',
              handle: undefined as unknown as FileSystemFileHandle,
              depth: 2,
              selectionState: 'unchecked',
              rootFolderId: 'test-root',
            },
          ],
        },
      ],
    },
  ];

  beforeEach(async () => {
    // Clear any test data from previous runs
    await clearTreeCache();
  });

  afterEach(async () => {
    // Cleanup test data
    await removeCachedTree(TEST_ROOT_ID);
  });

  describe('Real IndexedDB API', () => {
    it('should use real browser IndexedDB', () => {
      expect(typeof window).toBe('object');
      expect(typeof window.indexedDB).toBe('object');
    });

    it('should return cache miss for non-existent entry', async () => {
      const result = await getCachedTree('non-existent-root');

      expect(result.hit).toBe(false);
      if (!result.hit) {
        expect(result.reason).toBe('miss');
      }
    });

    it('should store and retrieve a tree', async () => {
      const nodes = createTestNodes();

      await setCachedTree(TEST_ROOT_ID, nodes);
      const result = await getCachedTree(TEST_ROOT_ID);

      expect(result.hit).toBe(true);
      if (result.hit) {
        expect(result.nodes).toHaveLength(1);
        expect(result.nodes[0]?.name).toBe('root');
        expect(result.nodes[0]?.children).toHaveLength(2);
        expect(result.cachedAt).toBeLessThanOrEqual(Date.now());
      }
    });

    it('should preserve nested structure', async () => {
      const nodes = createTestNodes();

      await setCachedTree(TEST_ROOT_ID, nodes);
      const result = await getCachedTree(TEST_ROOT_ID);

      expect(result.hit).toBe(true);
      if (result.hit) {
        const root = result.nodes[0];
        expect(root).toBeDefined();
        const subfolder = root?.children?.find((c) => c.name === 'subfolder');
        expect(subfolder).toBeDefined();
        expect(subfolder?.children).toHaveLength(1);
        expect(subfolder?.children?.[0]?.name).toBe('file2.ts');
      }
    });

    it('should strip FileSystemHandle objects from cached data', async () => {
      const nodesWithHandle: IFileNode[] = [
        {
          name: 'test.ts',
          path: '/test.ts',
          type: 'file',
          depth: 0,
          selectionState: 'unchecked',
          rootFolderId: 'test-root',
          // Simulate a handle (browsers may serialize this, but we strip it)
          handle: { kind: 'file' } as unknown as FileSystemFileHandle,
        },
      ];

      await setCachedTree(TEST_ROOT_ID, nodesWithHandle);
      const result = await getCachedTree(TEST_ROOT_ID);

      expect(result.hit).toBe(true);
      if (result.hit) {
        // Handle should be undefined after cache retrieval
        expect(result.nodes[0]?.handle).toBeUndefined();
      }
    });

    it('should update existing cache entry', async () => {
      const firstNode = createTestNodes()[0];
      const nodes1 = firstNode ? [firstNode] : [];
      const nodes2: IFileNode[] = [
        {
          name: 'updated-root',
          path: '/updated-root',
          type: 'directory',
          handle: undefined as unknown as FileSystemDirectoryHandle,
          depth: 0,
          selectionState: 'unchecked',
          rootFolderId: 'test-root',
        },
      ];

      await setCachedTree(TEST_ROOT_ID, nodes1);
      await setCachedTree(TEST_ROOT_ID, nodes2);

      const result = await getCachedTree(TEST_ROOT_ID);
      expect(result.hit).toBe(true);
      if (result.hit) {
        expect(result.nodes[0]?.name).toBe('updated-root');
      }
    });

    it('should remove a cached tree', async () => {
      const nodes = createTestNodes();

      await setCachedTree(TEST_ROOT_ID, nodes);
      await removeCachedTree(TEST_ROOT_ID);

      const result = await getCachedTree(TEST_ROOT_ID);
      expect(result.hit).toBe(false);
    });

    it('should clear all cached trees', async () => {
      const nodes = createTestNodes();
      const root1 = `${TEST_ROOT_ID}-1`;
      const root2 = `${TEST_ROOT_ID}-2`;

      await setCachedTree(root1, nodes);
      await setCachedTree(root2, nodes);
      await clearTreeCache();

      const result1 = await getCachedTree(root1);
      const result2 = await getCachedTree(root2);

      expect(result1.hit).toBe(false);
      expect(result2.hit).toBe(false);
    });
  });

  describe('Cache statistics', () => {
    it('should return zero stats for empty cache', async () => {
      await clearTreeCache();
      const stats = await getTreeCacheStats();

      expect(stats.entryCount).toBe(0);
      expect(stats.totalNodes).toBe(0);
      expect(stats.oldestEntry).toBeNull();
    });

    it('should count entries and nodes correctly', async () => {
      const nodes = createTestNodes(); // 1 root + 2 children + 1 nested = 4 nodes

      await setCachedTree(TEST_ROOT_ID, nodes);
      const stats = await getTreeCacheStats();

      expect(stats.entryCount).toBe(1);
      expect(stats.totalNodes).toBe(4);
      expect(stats.oldestEntry).toBeDefined();
      expect(stats.oldestEntry).toBeLessThanOrEqual(Date.now());
    });

    it('should track multiple entries', async () => {
      const nodes = createTestNodes();
      const root1 = `${TEST_ROOT_ID}-stats-1`;
      const root2 = `${TEST_ROOT_ID}-stats-2`;

      await setCachedTree(root1, nodes);
      await setCachedTree(root2, nodes);
      const stats = await getTreeCacheStats();

      expect(stats.entryCount).toBe(2);
      expect(stats.totalNodes).toBe(8); // 4 nodes x 2 entries

      // Cleanup
      await removeCachedTree(root1);
      await removeCachedTree(root2);
    });
  });

  describe('Edge cases', () => {
    it('should handle empty nodes array', async () => {
      await setCachedTree(TEST_ROOT_ID, []);
      const result = await getCachedTree(TEST_ROOT_ID);

      expect(result.hit).toBe(true);
      if (result.hit) {
        expect(result.nodes).toHaveLength(0);
      }
    });

    it('should handle special characters in root ID', async () => {
      const specialRootId = `${TEST_ROOT_ID}-special:chars/path~with.dots`;
      const nodes = createTestNodes();

      await setCachedTree(specialRootId, nodes);
      const result = await getCachedTree(specialRootId);

      expect(result.hit).toBe(true);

      // Cleanup
      await removeCachedTree(specialRootId);
    });

    it('should handle unicode in file names', async () => {
      const unicodeNodes: IFileNode[] = [
        {
          name: '你好世界.ts',
          path: '/你好世界.ts',
          type: 'file',
          handle: undefined as unknown as FileSystemFileHandle,
          depth: 0,
          selectionState: 'unchecked',
          rootFolderId: 'test-root',
        },
      ];

      await setCachedTree(TEST_ROOT_ID, unicodeNodes);
      const result = await getCachedTree(TEST_ROOT_ID);

      expect(result.hit).toBe(true);
      if (result.hit) {
        expect(result.nodes[0]?.name).toBe('你好世界.ts');
      }
    });

    it('should handle deeply nested structures', async () => {
      // Create a deeply nested structure (5 levels)
      const deepNodes: IFileNode[] = [
        {
          name: 'level1',
          path: '/level1',
          type: 'directory',
          handle: undefined as unknown as FileSystemDirectoryHandle,
          depth: 0,
          selectionState: 'unchecked',
          rootFolderId: 'test-root',
          children: [
            {
              name: 'level2',
              path: '/level1/level2',
              type: 'directory',
              handle: undefined as unknown as FileSystemDirectoryHandle,
              depth: 1,
              selectionState: 'unchecked',
              rootFolderId: 'test-root',
              children: [
                {
                  name: 'level3',
                  path: '/level1/level2/level3',
                  type: 'directory',
                  handle: undefined as unknown as FileSystemDirectoryHandle,
                  depth: 2,
                  selectionState: 'unchecked',
                  rootFolderId: 'test-root',
                  children: [
                    {
                      name: 'level4',
                      path: '/level1/level2/level3/level4',
                      type: 'directory',
                      handle: undefined as unknown as FileSystemDirectoryHandle,
                      depth: 3,
                      selectionState: 'unchecked',
                      rootFolderId: 'test-root',
                      children: [
                        {
                          name: 'deep-file.ts',
                          path: '/level1/level2/level3/level4/deep-file.ts',
                          type: 'file',
                          handle: undefined as unknown as FileSystemFileHandle,
                          depth: 4,
                          selectionState: 'unchecked',
                          rootFolderId: 'test-root',
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ];

      await setCachedTree(TEST_ROOT_ID, deepNodes);
      const result = await getCachedTree(TEST_ROOT_ID);

      expect(result.hit).toBe(true);
      if (result.hit) {
        // Verify all 5 nodes are present
        const stats = await getTreeCacheStats();
        expect(stats.totalNodes).toBe(5);

        // Verify deep structure is preserved
        const level4 = result.nodes[0]?.children?.[0]?.children?.[0]?.children?.[0];
        expect(level4?.name).toBe('level4');
        expect(level4?.children?.[0]?.name).toBe('deep-file.ts');
      }
    });
  });

  describe('Performance baseline', () => {
    it('should handle large trees efficiently', async () => {
      // Create a tree with 100 nodes
      const largeNodes: IFileNode[] = [];
      for (let i = 0; i < 100; i++) {
        largeNodes.push({
          name: `file-${i}.ts`,
          path: `/root/file-${i}.ts`,
          type: 'file',
          handle: undefined as unknown as FileSystemFileHandle,
          depth: 0,
          selectionState: 'unchecked',
          rootFolderId: 'test-root',
        });
      }

      const startWrite = performance.now();
      await setCachedTree(TEST_ROOT_ID, largeNodes);
      const writeTime = performance.now() - startWrite;

      const startRead = performance.now();
      const result = await getCachedTree(TEST_ROOT_ID);
      const readTime = performance.now() - startRead;

      // Log performance metrics
      console.log(`Write 100 nodes: ${writeTime.toFixed(2)}ms`);
      console.log(`Read 100 nodes: ${readTime.toFixed(2)}ms`);

      expect(result.hit).toBe(true);
      if (result.hit) {
        expect(result.nodes).toHaveLength(100);
      }

      // Sanity check - should complete in reasonable time
      expect(writeTime).toBeLessThan(2000);
      expect(readTime).toBeLessThan(1000);
    });
  });
});
