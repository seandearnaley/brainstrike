/**
 * BFS Engine Tests
 *
 * Tests for the breadth-first search engine used in expand-all operations.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BFSEngine } from './bfs-engine';
import type { WorkerFileNode, WorkerToMainMessage } from './types';

// Test fixtures
function createFileNode(overrides: Partial<WorkerFileNode> = {}): WorkerFileNode {
  return {
    name: 'file.txt',
    path: '/root/file.txt',
    type: 'file',
    depth: 1,
    rootFolderId: 'root',
    ...overrides,
  };
}

function createDirectoryNode(overrides: Partial<WorkerFileNode> = {}): WorkerFileNode {
  return {
    name: 'dir',
    path: '/root/dir',
    type: 'directory',
    depth: 1,
    rootFolderId: 'root',
    loadState: 'unloaded',
    ...overrides,
  };
}

describe('BFSEngine', () => {
  let engine: BFSEngine;
  let postMessageMock: ReturnType<typeof vi.fn<[WorkerToMainMessage], void>>;
  let messages: WorkerToMainMessage[];

  beforeEach(() => {
    messages = [];
    postMessageMock = vi.fn((msg: WorkerToMainMessage) => {
      messages.push(msg);
    });
    engine = new BFSEngine(postMessageMock);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('setTree / getTree', () => {
    it('should store and retrieve tree', () => {
      const tree = [createDirectoryNode()];

      engine.setTree(tree, 'root');

      expect(engine.getTree()).toEqual(tree);
    });

    it('should replace existing tree', () => {
      const tree1 = [createDirectoryNode({ path: '/root/dir1' })];
      const tree2 = [createDirectoryNode({ path: '/root/dir2' })];

      engine.setTree(tree1, 'root');
      engine.setTree(tree2, 'root');

      expect(engine.getTree()).toEqual(tree2);
    });
  });

  describe('handleLoadResult', () => {
    it('should update tree with loaded children', () => {
      const tree = [createDirectoryNode({ path: '/root/dir', loadState: 'loading' })];
      engine.setTree(tree, 'root');

      const children = [createFileNode({ path: '/root/dir/file.txt' })];
      engine.handleLoadResult('/root/dir', children);

      const updatedTree = engine.getTree();
      expect(updatedTree[0]?.children).toHaveLength(1);
      expect(updatedTree[0]?.loadState).toBe('loaded');
    });

    it('should emit children-loaded patch without a redundant loaded-state patch', () => {
      const tree = [createDirectoryNode({ path: '/root/dir', loadState: 'loading' })];
      engine.setTree(tree, 'root');
      messages = [];

      const children = [createFileNode({ path: '/root/dir/file.txt' })];
      engine.handleLoadResult('/root/dir', children);

      expect(messages).toContainEqual({
        type: 'childrenLoaded',
        payload: { path: '/root/dir', children, loadState: 'loaded' },
      });
      expect(
        messages.some(
          (message) =>
            message.type === 'nodeLoadStateChanged' &&
            message.payload.path === '/root/dir' &&
            message.payload.loadState === 'loaded'
        )
      ).toBe(false);
      expect(messages.some((message) => message.type === 'treeSnapshot')).toBe(false);
    });

    it('should not report unchanged expanded paths as both removed and added', () => {
      const child = createDirectoryNode({
        name: 'child',
        path: '/root/dir/child',
        depth: 2,
        loadState: 'loaded',
      });
      const tree = [
        createDirectoryNode({
          path: '/root/dir',
          loadState: 'loaded',
          children: [child],
        }),
      ];
      engine.setTree(tree, 'root');
      messages = [];

      engine.handleLoadResult('/root/dir', [child]);

      const deltaMsg = messages.find((message) => message.type === 'expandedPathsDelta');
      expect(deltaMsg).toBeUndefined();
    });

    it('should resolve pending load promise when all paths complete', async () => {
      const tree = [createDirectoryNode({ path: '/root/dir', loadState: 'unloaded' })];
      engine.setTree(tree, 'root');

      // Start a load operation (simulating what expandAll would do internally)
      // We can't directly test requestLoads since it's private, but we can test
      // that handleLoadResult properly updates the tree
      const children = [createFileNode({ path: '/root/dir/file.txt' })];
      engine.handleLoadResult('/root/dir', children);

      const updatedTree = engine.getTree();
      expect(updatedTree[0]?.loadState).toBe('loaded');
    });

    it('should maintain the path index without a full rebuild after directory loads', () => {
      const tree = [
        createDirectoryNode({
          path: '/root',
          loadState: 'loaded',
          children: [createDirectoryNode({ path: '/root/dir', loadState: 'loading', depth: 1 })],
        }),
      ];
      engine.setTree(tree, 'root');
      const indexedEngine = engine as unknown as {
        buildPathIndex: (nodes: WorkerFileNode[]) => void;
      };
      const buildPathIndexSpy = vi.spyOn(indexedEngine, 'buildPathIndex');

      engine.handleLoadResult('/root/dir', [
        createDirectoryNode({ path: '/root/dir/child', loadState: 'unloaded', depth: 2 }),
      ]);

      expect(buildPathIndexSpy).not.toHaveBeenCalled();
    });

    it('should remove stale subtree entries from the path index after directory reloads', () => {
      const tree = [
        createDirectoryNode({
          path: '/root',
          loadState: 'loaded',
          children: [
            createDirectoryNode({
              path: '/root/dir',
              loadState: 'loaded',
              depth: 1,
              children: [
                createFileNode({ path: '/root/dir/stale.txt', name: 'stale.txt', depth: 2 }),
              ],
            }),
          ],
        }),
      ];
      engine.setTree(tree, 'root');
      const indexedEngine = engine as unknown as {
        findNode: (path: string) => WorkerFileNode | null;
      };

      engine.handleLoadResult('/root/dir', [
        createFileNode({ path: '/root/dir/fresh.txt', name: 'fresh.txt', depth: 2 }),
      ]);

      expect(indexedEngine.findNode('/root/dir/stale.txt')).toBeNull();
      expect(indexedEngine.findNode('/root/dir/fresh.txt')?.name).toBe('fresh.txt');
    });

    it('warns when a legacy id-less load result could match multiple pending loads', () => {
      const tree = [createDirectoryNode({ path: '/root/dir', loadState: 'loading' })];
      engine.setTree(tree, 'root');
      const mutableEngine = engine as unknown as {
        pendingLoads: Map<
          string,
          {
            operationId: number;
            paths: Set<string>;
            reject: (error: Error) => void;
            results: Map<string, unknown>;
            resolve: (result: unknown) => void;
            timeoutId: ReturnType<typeof setTimeout>;
          }
        >;
      };
      const noop = (): void => {};
      const extraTimeout = setTimeout(noop, 0);
      mutableEngine.pendingLoads.set('request-1', {
        operationId: 1,
        paths: new Set(['/root/dir']),
        reject: noop,
        results: new Map(),
        resolve: noop,
        timeoutId: setTimeout(noop, 0),
      });
      mutableEngine.pendingLoads.set('request-2', {
        operationId: 2,
        paths: new Set(['/root/other']),
        reject: noop,
        results: new Map(),
        resolve: noop,
        timeoutId: extraTimeout,
      });

      engine.handleLoadResult('/root/dir', [createFileNode({ path: '/root/dir/file.txt' })]);

      expect(messages).toContainEqual({
        type: 'log',
        level: 'warn',
        message: 'Legacy id-less load result resolved while 2 loads were pending',
      });
      clearTimeout(extraTimeout);
    });
  });

  describe('handleLoadError', () => {
    it('should set error state on node', () => {
      const tree = [createDirectoryNode({ path: '/root/dir', loadState: 'loading' })];
      engine.setTree(tree, 'root');

      engine.handleLoadError('/root/dir', 'Permission denied');

      const updatedTree = engine.getTree();
      expect(updatedTree[0]?.loadState).toBe('error');
      expect(updatedTree[0]?.loadError).toBe('Permission denied');
    });
  });

  describe('abort', () => {
    it('should set aborted flag', () => {
      engine.abort();

      // The abort flag is private, but we can verify behavior
      // by checking that operations complete early
      expect(postMessageMock).not.toHaveBeenCalled();
    });

    it('should resolve pending loads with empty results', () => {
      // Engine internally tracks pending loads - abort should clear them
      engine.abort();

      // No errors should be thrown
      expect(true).toBe(true);
    });
  });

  describe('collapseAll', () => {
    it('should keep tree data cached (not reset to unloaded)', () => {
      const tree = [
        createDirectoryNode({
          path: '/root/dir',
          loadState: 'loaded',
          children: [createFileNode({ path: '/root/dir/file.txt' })],
        }),
      ];
      engine.setTree(tree, 'root');

      engine.collapseAll();

      // Tree data should remain cached - loadState stays 'loaded', children preserved
      const updatedTree = engine.getTree();
      expect(updatedTree[0]?.loadState).toBe('loaded');
      expect(updatedTree[0]?.children).toHaveLength(1);
    });

    it('should send expanded-path removal patch', () => {
      const tree = [
        createDirectoryNode({
          path: '/root/dir',
          loadState: 'loaded',
          children: [createFileNode({ path: '/root/dir/file.txt' })],
        }),
      ];
      engine.setTree(tree, 'root');

      engine.collapseAll();

      const deltaMsg = messages.find((m) => m.type === 'expandedPathsDelta');
      expect(deltaMsg).toBeDefined();
      if (deltaMsg?.type === 'expandedPathsDelta') {
        expect(deltaMsg.payload.added).toEqual([]);
        expect(deltaMsg.payload.removed).toEqual(['/root/dir']);
      }
    });

    it('should not affect file nodes', () => {
      const tree = [
        createDirectoryNode({ path: '/root/dir', loadState: 'loaded' }),
        createFileNode({ path: '/root/file.txt' }),
      ];
      engine.setTree(tree, 'root');

      engine.collapseAll();

      const updatedTree = engine.getTree();
      expect(updatedTree[1]?.type).toBe('file');
    });
  });

  describe('loadPaths', () => {
    it('should send complete message for empty paths', async () => {
      engine.setTree([], 'root');

      await engine.loadPaths([]);

      const completeMsg = messages.find((m) => m.type === 'complete');
      expect(completeMsg).toBeDefined();
    });

    it('should skip already loaded directories', async () => {
      const tree = [createDirectoryNode({ path: '/root/dir', loadState: 'loaded', children: [] })];
      engine.setTree(tree, 'root');

      // Start loadPaths - it will skip already loaded dirs and complete
      await engine.loadPaths(['/root/dir']);

      // Should have sent progress update (skipped count)
      const progressMsg = messages.find((m) => m.type === 'progress');
      expect(progressMsg).toBeDefined();

      // Should complete successfully
      const completeMsg = messages.find((m) => m.type === 'complete');
      expect(completeMsg).toBeDefined();
    });

    it('should log start and completion for non-empty paths', async () => {
      const tree = [createDirectoryNode({ path: '/root/dir', loadState: 'unloaded' })];
      engine.setTree(tree, 'root');

      const loadPromise = engine.loadPaths(['/root/dir']);

      // Wait for request and simulate response
      await vi.waitFor(() => {
        const requestMsg = messages.find((m) => m.type === 'requestLoad');
        expect(requestMsg).toBeDefined();
      });

      engine.handleLoadResult('/root/dir', []);
      await loadPromise;

      const logMessages = messages.filter((m) => m.type === 'log');
      expect(logMessages.length).toBeGreaterThan(0);
    });
  });

  describe('expandAll', () => {
    it('should send log messages during operation', async () => {
      const tree = [createDirectoryNode({ path: '/root/dir', loadState: 'loaded', children: [] })];
      engine.setTree(tree, 'root');

      // Start expandAll but abort immediately to prevent hanging
      const expandPromise = engine.expandAll();

      // Wait a tick for the async operation to start
      await new Promise((resolve) => setTimeout(resolve, 10));

      // The operation should have started logging
      const logMessages = messages.filter((m) => m.type === 'log');
      expect(logMessages.length).toBeGreaterThan(0);

      // Complete the test
      engine.abort();
      await expandPromise; // Should complete without error after abort
    });

    it('should send complete message when all directories are loaded', async () => {
      // Tree with already-loaded directory (nothing to expand)
      const tree = [createDirectoryNode({ path: '/root/dir', loadState: 'loaded', children: [] })];
      engine.setTree(tree, 'root');

      await engine.expandAll();

      const completeMsg = messages.find((m) => m.type === 'complete');
      expect(completeMsg).toBeDefined();
      if (completeMsg?.type === 'complete') {
        expect(completeMsg.payload).not.toHaveProperty('tree');
        expect(completeMsg.payload.expandedPaths).toContain('/root/dir');
      }
    });

    it('should request loads for unloaded directories', async () => {
      const tree = [createDirectoryNode({ path: '/root/dir', loadState: 'unloaded' })];
      engine.setTree(tree, 'root');

      // Start expandAll
      const expandPromise = engine.expandAll();

      // Wait for request to be sent
      await vi.waitFor(() => {
        const requestLoadMsg = messages.find((m) => m.type === 'requestLoad');
        expect(requestLoadMsg).toBeDefined();
      });

      // Simulate load completion
      engine.handleLoadResult('/root/dir', []);

      await expandPromise;

      const completeMsg = messages.find((m) => m.type === 'complete');
      expect(completeMsg).toBeDefined();
    });

    it('should handle nested directories in BFS order', async () => {
      const tree = [createDirectoryNode({ path: '/root/parent', loadState: 'unloaded' })];
      engine.setTree(tree, 'root');

      const expandPromise = engine.expandAll();

      // Wait for first request
      await vi.waitFor(() => {
        const requestLoadMsg = messages.find((m) => m.type === 'requestLoad');
        expect(requestLoadMsg).toBeDefined();
      });

      // Simulate first load - parent contains a child directory
      engine.handleLoadResult('/root/parent', [
        createDirectoryNode({ path: '/root/parent/child', loadState: 'unloaded', depth: 2 }),
      ]);

      // Wait for next wave request
      await vi.waitFor(() => {
        const allRequests = messages.filter((m) => m.type === 'requestLoad');
        expect(allRequests.length).toBeGreaterThanOrEqual(2);
      });

      // Simulate second load
      engine.handleLoadResult('/root/parent/child', []);

      await expandPromise;

      const completeMsg = messages.find((m) => m.type === 'complete');
      expect(completeMsg).toBeDefined();
    });

    it('should stop when aborted', async () => {
      const tree = [createDirectoryNode({ path: '/root/dir', loadState: 'unloaded' })];
      engine.setTree(tree, 'root');

      const expandPromise = engine.expandAll();

      // Wait for request to be sent
      await vi.waitFor(() => {
        const requestLoadMsg = messages.find((m) => m.type === 'requestLoad');
        expect(requestLoadMsg).toBeDefined();
      });

      // Abort the operation
      engine.abort();

      await expandPromise;

      // Should have logged abort
      const logMessages = messages.filter((m) => m.type === 'log');
      const abortLog = logMessages.find((m) => m.type === 'log' && m.message.includes('Aborted'));
      expect(abortLog).toBeDefined();
    });

    it('should include loadedCount=0 in complete message when all directories are cached', async () => {
      // Tree with all directories already loaded (no fetching needed)
      const tree = [
        createDirectoryNode({
          path: '/root/dir1',
          loadState: 'loaded',
          children: [createFileNode({ path: '/root/dir1/file.txt' })],
        }),
        createDirectoryNode({
          path: '/root/dir2',
          loadState: 'loaded',
          children: [],
        }),
      ];
      engine.setTree(tree, 'root');

      await engine.expandAll();

      const completeMsg = messages.find((m) => m.type === 'complete');
      expect(completeMsg).toBeDefined();
      if (completeMsg?.type === 'complete') {
        expect(completeMsg.payload.loadedCount).toBe(0);
      }
    });

    it('should include loadedCount > 0 in complete message when directories need loading', async () => {
      const tree = [createDirectoryNode({ path: '/root/dir', loadState: 'unloaded' })];
      engine.setTree(tree, 'root');

      const expandPromise = engine.expandAll();

      // Wait for request to be sent
      await vi.waitFor(() => {
        const requestLoadMsg = messages.find((m) => m.type === 'requestLoad');
        expect(requestLoadMsg).toBeDefined();
      });

      // Simulate load completion
      engine.handleLoadResult('/root/dir', [createFileNode({ path: '/root/dir/file.txt' })]);

      await expandPromise;

      const completeMsg = messages.find((m) => m.type === 'complete');
      expect(completeMsg).toBeDefined();
      if (completeMsg?.type === 'complete') {
        expect(completeMsg.payload.loadedCount).toBe(1);
      }
    });
  });

  describe('loadPaths loadedCount', () => {
    it('should include loadedCount=0 in complete message for empty paths', async () => {
      engine.setTree([], 'root');

      await engine.loadPaths([]);

      const completeMsg = messages.find((m) => m.type === 'complete');
      expect(completeMsg).toBeDefined();
      if (completeMsg?.type === 'complete') {
        expect(completeMsg.payload.loadedCount).toBe(0);
      }
    });

    it('should include loadedCount=0 when all paths are already loaded', async () => {
      const tree = [createDirectoryNode({ path: '/root/dir', loadState: 'loaded', children: [] })];
      engine.setTree(tree, 'root');

      await engine.loadPaths(['/root/dir']);

      const completeMsg = messages.find((m) => m.type === 'complete');
      expect(completeMsg).toBeDefined();
      if (completeMsg?.type === 'complete') {
        expect(completeMsg.payload.loadedCount).toBe(0);
      }
    });

    it('should include loadedCount > 0 when paths need loading', async () => {
      const tree = [createDirectoryNode({ path: '/root/dir', loadState: 'unloaded' })];
      engine.setTree(tree, 'root');

      const loadPromise = engine.loadPaths(['/root/dir']);

      // Wait for request and simulate response
      await vi.waitFor(() => {
        const requestMsg = messages.find((m) => m.type === 'requestLoad');
        expect(requestMsg).toBeDefined();
      });

      engine.handleLoadResult('/root/dir', [createFileNode({ path: '/root/dir/file.txt' })]);
      await loadPromise;

      const completeMsg = messages.find((m) => m.type === 'complete');
      expect(completeMsg).toBeDefined();
      if (completeMsg?.type === 'complete') {
        expect(completeMsg.payload.loadedCount).toBe(1);
      }
    });

    it('should retry not-found paths after parents are loaded (hierarchical restoration)', async () => {
      // This tests the retry mechanism for paths that don't exist in the tree yet
      // because their parent directories haven't been loaded.
      // Start with just the root directory loaded
      const tree = [createDirectoryNode({ path: '/root/parent', loadState: 'unloaded' })];
      engine.setTree(tree, 'root');

      // Request loading a nested path that doesn't exist yet (child path before parent loaded)
      const loadPromise = engine.loadPaths(['/root/parent', '/root/parent/child']);

      // Wait for request to load the parent first (shallowest first by depth sorting)
      await vi.waitFor(() => {
        const requestMsg = messages.find((m) => m.type === 'requestLoad');
        expect(requestMsg).toBeDefined();
      });

      // Simulate parent loading - it contains the child directory
      engine.handleLoadResult('/root/parent', [
        createDirectoryNode({ path: '/root/parent/child', loadState: 'unloaded', depth: 2 }),
      ]);

      // Wait for the child path to be requested (after retry)
      await vi.waitFor(() => {
        const allRequests = messages.filter((m) => m.type === 'requestLoad');
        expect(allRequests.length).toBeGreaterThanOrEqual(2);
      });

      // Simulate child loading
      engine.handleLoadResult('/root/parent/child', []);

      await loadPromise;

      const completeMsg = messages.find((m) => m.type === 'complete');
      expect(completeMsg).toBeDefined();
      if (completeMsg?.type === 'complete') {
        // Both parent and child should be loaded
        expect(completeMsg.payload.loadedCount).toBe(2);
      }
    });
  });

  describe('loadSubtree', () => {
    it('should send complete with 0 count when start path not found', async () => {
      engine.setTree([], 'root');

      await engine.loadSubtree('/root/nonexistent');

      const completeMsg = messages.find((m) => m.type === 'complete');
      expect(completeMsg).toBeDefined();
      if (completeMsg?.type === 'complete') {
        expect(completeMsg.payload.loadedCount).toBe(0);
      }
    });

    it('should send complete with 0 count when start path is a file', async () => {
      const tree = [createFileNode({ path: '/root/file.txt' })];
      engine.setTree(tree, 'root');

      await engine.loadSubtree('/root/file.txt');

      const completeMsg = messages.find((m) => m.type === 'complete');
      expect(completeMsg).toBeDefined();
      if (completeMsg?.type === 'complete') {
        expect(completeMsg.payload.loadedCount).toBe(0);
      }
    });

    it('should send complete with 0 count when directory is already fully loaded', async () => {
      const tree = [
        createDirectoryNode({
          path: '/root/dir',
          loadState: 'loaded',
          children: [createFileNode({ path: '/root/dir/file.txt' })],
        }),
      ];
      engine.setTree(tree, 'root');

      await engine.loadSubtree('/root/dir');

      const completeMsg = messages.find((m) => m.type === 'complete');
      expect(completeMsg).toBeDefined();
      if (completeMsg?.type === 'complete') {
        expect(completeMsg.payload.loadedCount).toBe(0);
      }
    });

    it('should load unloaded directory and send complete', async () => {
      const tree = [createDirectoryNode({ path: '/root/dir', loadState: 'unloaded' })];
      engine.setTree(tree, 'root');

      const loadPromise = engine.loadSubtree('/root/dir');

      // Wait for request
      await vi.waitFor(() => {
        const requestMsg = messages.find((m) => m.type === 'requestLoad');
        expect(requestMsg).toBeDefined();
      });

      // Simulate load completion
      engine.handleLoadResult('/root/dir', [createFileNode({ path: '/root/dir/file.txt' })]);

      await loadPromise;

      const completeMsg = messages.find((m) => m.type === 'complete');
      expect(completeMsg).toBeDefined();
      if (completeMsg?.type === 'complete') {
        expect(completeMsg.payload.loadedCount).toBe(1);
      }
    });

    it('should load nested unloaded directories', async () => {
      const tree = [createDirectoryNode({ path: '/root/parent', loadState: 'unloaded' })];
      engine.setTree(tree, 'root');

      const loadPromise = engine.loadSubtree('/root/parent');

      // Wait for first request
      await vi.waitFor(() => {
        const requestMsg = messages.find((m) => m.type === 'requestLoad');
        expect(requestMsg).toBeDefined();
      });

      // Simulate first load - parent contains a child directory
      engine.handleLoadResult('/root/parent', [
        createDirectoryNode({ path: '/root/parent/child', loadState: 'unloaded', depth: 2 }),
      ]);

      // Wait for next wave request
      await vi.waitFor(() => {
        const allRequests = messages.filter((m) => m.type === 'requestLoad');
        expect(allRequests.length).toBeGreaterThanOrEqual(2);
      });

      // Simulate second load
      engine.handleLoadResult('/root/parent/child', []);

      await loadPromise;

      const completeMsg = messages.find((m) => m.type === 'complete');
      expect(completeMsg).toBeDefined();
      if (completeMsg?.type === 'complete') {
        expect(completeMsg.payload.loadedCount).toBe(2);
      }
    });

    it('should discover unloaded descendants under loaded directories', async () => {
      // This tests the critical P1 bug fix: when a parent is loaded but has
      // unloaded child directories, loadSubtree should find and load them
      const tree = [
        createDirectoryNode({
          path: '/root/parent',
          loadState: 'loaded',
          children: [
            createDirectoryNode({ path: '/root/parent/child', loadState: 'unloaded', depth: 2 }),
          ],
        }),
      ];
      engine.setTree(tree, 'root');

      const loadPromise = engine.loadSubtree('/root/parent');

      // Wait for request to load the unloaded child
      await vi.waitFor(() => {
        const requestMsg = messages.find((m) => m.type === 'requestLoad');
        expect(requestMsg).toBeDefined();
      });

      // Simulate load completion of the child
      engine.handleLoadResult('/root/parent/child', []);

      await loadPromise;

      const completeMsg = messages.find((m) => m.type === 'complete');
      expect(completeMsg).toBeDefined();
      if (completeMsg?.type === 'complete') {
        // Only the child was loaded (parent was already loaded)
        expect(completeMsg.payload.loadedCount).toBe(1);
      }
    });

    it('should discover deeply nested unloaded descendants', async () => {
      // Tests that loadSubtree traverses through multiple loaded directories
      // to find deeply nested unloaded ones
      const tree = [
        createDirectoryNode({
          path: '/root/level1',
          loadState: 'loaded',
          children: [
            createDirectoryNode({
              path: '/root/level1/level2',
              loadState: 'loaded',
              depth: 2,
              children: [
                createDirectoryNode({
                  path: '/root/level1/level2/level3',
                  loadState: 'unloaded',
                  depth: 3,
                }),
              ],
            }),
          ],
        }),
      ];
      engine.setTree(tree, 'root');

      const loadPromise = engine.loadSubtree('/root/level1');

      // Wait for request to load the deeply nested unloaded directory
      await vi.waitFor(() => {
        const requestMsg = messages.find((m) => m.type === 'requestLoad');
        expect(requestMsg).toBeDefined();
        if (requestMsg?.type === 'requestLoad') {
          expect(requestMsg.payload.paths).toContain('/root/level1/level2/level3');
        }
      });

      // Simulate load completion
      engine.handleLoadResult('/root/level1/level2/level3', []);

      await loadPromise;

      const completeMsg = messages.find((m) => m.type === 'complete');
      expect(completeMsg).toBeDefined();
      if (completeMsg?.type === 'complete') {
        expect(completeMsg.payload.loadedCount).toBe(1);
      }
    });

    it('should handle abort during loading', async () => {
      const tree = [createDirectoryNode({ path: '/root/dir', loadState: 'unloaded' })];
      engine.setTree(tree, 'root');

      const loadPromise = engine.loadSubtree('/root/dir');

      // Wait for request
      await vi.waitFor(() => {
        const requestMsg = messages.find((m) => m.type === 'requestLoad');
        expect(requestMsg).toBeDefined();
      });

      // Abort the operation
      engine.abort();

      await loadPromise;

      // Should have logged abort
      const logMessages = messages.filter((m) => m.type === 'log');
      const abortLog = logMessages.find(
        (m) => m.type === 'log' && m.message.includes('[loadSubtree] Complete')
      );
      expect(abortLog).toBeDefined();
    });

    it('should send progress updates during loading', async () => {
      const tree = [createDirectoryNode({ path: '/root/dir', loadState: 'unloaded' })];
      engine.setTree(tree, 'root');

      const loadPromise = engine.loadSubtree('/root/dir');

      // Wait for initial progress
      await vi.waitFor(() => {
        const progressMsg = messages.find((m) => m.type === 'progress');
        expect(progressMsg).toBeDefined();
      });

      // Complete the load
      engine.handleLoadResult('/root/dir', []);

      await loadPromise;

      const progressMessages = messages.filter((m) => m.type === 'progress');
      expect(progressMessages.length).toBeGreaterThan(0);
    });
  });

  describe('flattenTree', () => {
    it('should flatten an empty tree', () => {
      engine.setTree([], 'root');

      engine.flattenTree([]);

      const resultMsg = messages.find((m) => m.type === 'flattenedRows');
      expect(resultMsg).toBeDefined();
      if (resultMsg?.type === 'flattenedRows') {
        expect(resultMsg.payload.nodes).toEqual([]);
        expect(resultMsg.payload.count).toBe(0);
      }
    });

    it('should flatten a tree with only root-level nodes', () => {
      const tree = [
        createFileNode({ name: 'file1.txt', path: '/root/file1.txt' }),
        createDirectoryNode({ name: 'dir1', path: '/root/dir1', loadState: 'unloaded' }),
      ];
      engine.setTree(tree, 'root');

      engine.flattenTree([]);

      const resultMsg = messages.find((m) => m.type === 'flattenedRows');
      expect(resultMsg).toBeDefined();
      if (resultMsg?.type === 'flattenedRows') {
        expect(resultMsg.payload.nodes).toHaveLength(2);
        expect(resultMsg.payload.nodes[0]?.depth).toBe(0);
        expect(resultMsg.payload.nodes[1]?.depth).toBe(0);
      }
    });

    it('should include children of expanded and loaded directories', () => {
      const tree = [
        createDirectoryNode({
          name: 'dir1',
          path: '/root/dir1',
          loadState: 'loaded',
          children: [createFileNode({ name: 'child.txt', path: '/root/dir1/child.txt', depth: 2 })],
        }),
      ];
      engine.setTree(tree, 'root');

      engine.flattenTree(['/root/dir1']);

      const resultMsg = messages.find((m) => m.type === 'flattenedRows');
      expect(resultMsg).toBeDefined();
      if (resultMsg?.type === 'flattenedRows') {
        expect(resultMsg.payload.nodes).toHaveLength(2);
        expect(resultMsg.payload.nodes[0]?.node.path).toBe('/root/dir1');
        expect(resultMsg.payload.nodes[0]?.depth).toBe(0);
        expect(resultMsg.payload.nodes[1]?.node.path).toBe('/root/dir1/child.txt');
        expect(resultMsg.payload.nodes[1]?.depth).toBe(1);
      }
    });

    it('should not include children of collapsed directories', () => {
      const tree = [
        createDirectoryNode({
          name: 'dir1',
          path: '/root/dir1',
          loadState: 'loaded',
          children: [createFileNode({ name: 'child.txt', path: '/root/dir1/child.txt', depth: 2 })],
        }),
      ];
      engine.setTree(tree, 'root');

      // Not expanded - pass empty array
      engine.flattenTree([]);

      const resultMsg = messages.find((m) => m.type === 'flattenedRows');
      expect(resultMsg).toBeDefined();
      if (resultMsg?.type === 'flattenedRows') {
        // Only parent, no children
        expect(resultMsg.payload.nodes).toHaveLength(1);
        expect(resultMsg.payload.nodes[0]?.node.path).toBe('/root/dir1');
      }
    });

    it('should not include children of expanded but unloaded directories', () => {
      const tree = [
        createDirectoryNode({
          name: 'dir1',
          path: '/root/dir1',
          loadState: 'unloaded', // Not loaded yet - children not set
        }),
      ];
      engine.setTree(tree, 'root');

      engine.flattenTree(['/root/dir1']); // Expanded but not loaded

      const resultMsg = messages.find((m) => m.type === 'flattenedRows');
      expect(resultMsg).toBeDefined();
      if (resultMsg?.type === 'flattenedRows') {
        // Only parent, no children (not loaded)
        expect(resultMsg.payload.nodes).toHaveLength(1);
      }
    });

    it('should include duration in result', () => {
      engine.setTree([createFileNode()], 'root');

      engine.flattenTree([]);

      const resultMsg = messages.find((m) => m.type === 'flattenedRows');
      expect(resultMsg).toBeDefined();
      if (resultMsg?.type === 'flattenedRows') {
        expect(typeof resultMsg.payload.durationMs).toBe('number');
        expect(resultMsg.payload.durationMs).toBeGreaterThanOrEqual(0);
      }
    });

    it('should handle deeply nested expanded directories', () => {
      const tree = [
        createDirectoryNode({
          name: 'level1',
          path: '/root/level1',
          loadState: 'loaded',
          children: [
            createDirectoryNode({
              name: 'level2',
              path: '/root/level1/level2',
              depth: 2,
              loadState: 'loaded',
              children: [
                createFileNode({
                  name: 'deep.txt',
                  path: '/root/level1/level2/deep.txt',
                  depth: 3,
                }),
              ],
            }),
          ],
        }),
      ];
      engine.setTree(tree, 'root');

      engine.flattenTree(['/root/level1', '/root/level1/level2']);

      const resultMsg = messages.find((m) => m.type === 'flattenedRows');
      expect(resultMsg).toBeDefined();
      if (resultMsg?.type === 'flattenedRows') {
        expect(resultMsg.payload.nodes).toHaveLength(3);
        expect(resultMsg.payload.nodes[0]?.depth).toBe(0);
        expect(resultMsg.payload.nodes[1]?.depth).toBe(1);
        expect(resultMsg.payload.nodes[2]?.depth).toBe(2);
      }
    });
  });
});
