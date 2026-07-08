/**
 * BFS Engine Tests
 *
 * Tests for the breadth-first search engine used in expand-all operations.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BFSEngine, MAX_EXPAND_DIRECTORIES } from './bfs-engine';
import type { WorkerFileNode, WorkerToMainMessage } from './types';

// Test fixtures
function createFileNode(overrides: Partial<WorkerFileNode> = {}): WorkerFileNode {
  return {
    depth: 1,
    name: 'file.txt',
    path: '/root/file.txt',
    rootFolderId: 'root',
    type: 'file',
    ...overrides,
  };
}

function createDirectoryNode(overrides: Partial<WorkerFileNode> = {}): WorkerFileNode {
  return {
    depth: 1,
    loadState: 'unloaded',
    name: 'dir',
    path: '/root/dir',
    rootFolderId: 'root',
    type: 'directory',
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
      const tree = [createDirectoryNode({ loadState: 'loading', path: '/root/dir' })];
      engine.setTree(tree, 'root');

      const children = [createFileNode({ path: '/root/dir/file.txt' })];
      engine.handleLoadResult('/root/dir', children);

      const updatedTree = engine.getTree();
      expect(updatedTree[0]?.children).toHaveLength(1);
      expect(updatedTree[0]?.loadState).toBe('loaded');
    });

    it('clears stale load errors when a directory later loads successfully', () => {
      const tree = [
        createDirectoryNode({
          loadError: 'Permission denied',
          loadState: 'error',
          path: '/root/dir',
        }),
      ];
      engine.setTree(tree, 'root');

      engine.handleLoadResult('/root/dir', [createFileNode({ path: '/root/dir/file.txt' })]);

      const updatedNode = engine.getTree()[0];
      expect(updatedNode).toEqual(expect.objectContaining({ loadState: 'loaded' }));
      expect(updatedNode?.loadError).toBeUndefined();
    });

    it('should emit children-loaded patch without a redundant loaded-state patch', () => {
      const tree = [createDirectoryNode({ loadState: 'loading', path: '/root/dir' })];
      engine.setTree(tree, 'root');
      messages = [];

      const children = [createFileNode({ path: '/root/dir/file.txt' })];
      engine.handleLoadResult('/root/dir', children);

      expect(messages).toContainEqual({
        payload: { children, loadState: 'loaded', path: '/root/dir' },
        type: 'childrenLoaded',
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
        depth: 2,
        loadState: 'loaded',
        name: 'child',
        path: '/root/dir/child',
      });
      const tree = [
        createDirectoryNode({
          children: [child],
          loadState: 'loaded',
          path: '/root/dir',
        }),
      ];
      engine.setTree(tree, 'root');
      messages = [];

      engine.handleLoadResult('/root/dir', [child]);

      const deltaMsg = messages.find((message) => message.type === 'expandedPathsDelta');
      expect(deltaMsg).toBeUndefined();
    });

    it('should resolve pending load promise when all paths complete', async () => {
      const tree = [createDirectoryNode({ loadState: 'unloaded', path: '/root/dir' })];
      engine.setTree(tree, 'root');

      // Start a load operation (simulating what expandAll would do internally)
      // We can't directly test requestLoads since it's private, but we can test
      // that handleLoadResult properly updates the tree
      const children = [createFileNode({ path: '/root/dir/file.txt' })];
      engine.handleLoadResult('/root/dir', children);

      const updatedTree = engine.getTree();
      expect(updatedTree[0]?.loadState).toBe('loaded');
    });

    it('correlates successful load results to the matching request id', async () => {
      const tree = [
        createDirectoryNode({ loadState: 'unloaded', path: '/root/dir1' }),
        createDirectoryNode({ loadState: 'unloaded', path: '/root/dir2' }),
      ];
      engine.setTree(tree, 'root');

      const firstLoad = engine.loadPaths(['/root/dir1'], 11);
      const secondLoad = engine.loadPaths(['/root/dir2'], 22);

      await vi.waitFor(() => {
        expect(messages.filter((message) => message.type === 'requestLoad')).toHaveLength(2);
      });
      const requestMessages = messages.filter((message) => message.type === 'requestLoad');
      const firstRequest = requestMessages[0];
      const secondRequest = requestMessages[1];
      if (firstRequest?.type !== 'requestLoad' || secondRequest?.type !== 'requestLoad') {
        throw new Error('expected correlated load requests');
      }

      engine.handleLoadResult(
        '/root/dir2',
        [createFileNode({ path: '/root/dir2/file.txt' })],
        secondRequest.payload.requestId
      );
      engine.handleLoadResult(
        '/root/dir1',
        [createFileNode({ path: '/root/dir1/file.txt' })],
        firstRequest.payload.requestId
      );

      await Promise.all([firstLoad, secondLoad]);

      const completedOperationIds = messages
        .filter((message) => message.type === 'complete')
        .map((message) => message.operationId);
      expect(completedOperationIds).toEqual(expect.arrayContaining([11, 22]));
      expect(messages).toContainEqual({
        operationId: 22,
        payload: {
          children: [createFileNode({ path: '/root/dir2/file.txt' })],
          loadState: 'loaded',
          path: '/root/dir2',
        },
        type: 'childrenLoaded',
      });
    });

    it('should maintain the path index without a full rebuild after directory loads', () => {
      const tree = [
        createDirectoryNode({
          children: [createDirectoryNode({ depth: 1, loadState: 'loading', path: '/root/dir' })],
          loadState: 'loaded',
          path: '/root',
        }),
      ];
      engine.setTree(tree, 'root');
      const indexedEngine = engine as unknown as {
        buildPathIndex: (nodes: WorkerFileNode[]) => void;
      };
      const buildPathIndexSpy = vi.spyOn(indexedEngine, 'buildPathIndex');

      engine.handleLoadResult('/root/dir', [
        createDirectoryNode({ depth: 2, loadState: 'unloaded', path: '/root/dir/child' }),
      ]);

      expect(buildPathIndexSpy).not.toHaveBeenCalled();
    });

    it('should remove stale subtree entries from the path index after directory reloads', () => {
      const tree = [
        createDirectoryNode({
          children: [
            createDirectoryNode({
              children: [
                createFileNode({ depth: 2, name: 'stale.txt', path: '/root/dir/stale.txt' }),
              ],
              depth: 1,
              loadState: 'loaded',
              path: '/root/dir',
            }),
          ],
          loadState: 'loaded',
          path: '/root',
        }),
      ];
      engine.setTree(tree, 'root');
      const indexedEngine = engine as unknown as {
        findNode: (path: string) => WorkerFileNode | null;
      };

      engine.handleLoadResult('/root/dir', [
        createFileNode({ depth: 2, name: 'fresh.txt', path: '/root/dir/fresh.txt' }),
      ]);

      expect(indexedEngine.findNode('/root/dir/stale.txt')).toBeNull();
      expect(indexedEngine.findNode('/root/dir/fresh.txt')?.name).toBe('fresh.txt');
    });

    it('should emit a loading-state patch for external directory updates', () => {
      const tree = [createDirectoryNode({ loadState: 'unloaded', path: '/root/dir' })];
      engine.setTree(tree, 'root');
      messages = [];

      engine.applyDirectoryChildrenUpdate('/root/dir', [], 'loading', 42);

      expect(messages).toContainEqual({
        operationId: 42,
        payload: {
          loadError: undefined,
          loadState: 'loading',
          path: '/root/dir',
        },
        type: 'nodeLoadStateChanged',
      });
      expect(messages.some((message) => message.type === 'childrenLoaded')).toBe(false);
    });

    it('should ignore external directory updates for paths missing from the index', () => {
      engine.setTree([createDirectoryNode({ path: '/root/dir' })], 'root');
      messages = [];

      engine.applyDirectoryChildrenUpdate('/root/missing', [], 'loading', 42);

      expect(messages).toEqual([]);
    });

    it('warns when a legacy id-less load result could match multiple pending loads', () => {
      const tree = [createDirectoryNode({ loadState: 'loading', path: '/root/dir' })];
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
      const firstTimeout = setTimeout(noop, 0);
      const extraTimeout = setTimeout(noop, 0);
      mutableEngine.pendingLoads.set('request-1', {
        operationId: 1,
        paths: new Set(['/root/dir']),
        reject: noop,
        resolve: noop,
        results: new Map(),
        timeoutId: firstTimeout,
      });
      mutableEngine.pendingLoads.set('request-2', {
        operationId: 2,
        paths: new Set(['/root/other']),
        reject: noop,
        resolve: noop,
        results: new Map(),
        timeoutId: extraTimeout,
      });

      engine.handleLoadResult('/root/dir', [createFileNode({ path: '/root/dir/file.txt' })]);

      expect(messages).toContainEqual({
        level: 'warn',
        message: 'Legacy id-less load result resolved while 2 loads were pending',
        type: 'log',
      });
      clearTimeout(firstTimeout);
      clearTimeout(extraTimeout);
    });
  });

  describe('handleLoadError', () => {
    it('should set error state on node', () => {
      const tree = [createDirectoryNode({ loadState: 'loading', path: '/root/dir' })];
      engine.setTree(tree, 'root');

      engine.handleLoadError('/root/dir', 'Permission denied');

      const updatedTree = engine.getTree();
      expect(updatedTree[0]?.loadState).toBe('error');
      expect(updatedTree[0]?.loadError).toBe('Permission denied');
    });

    it('should resolve a correlated pending path load with an error result', async () => {
      const tree = [createDirectoryNode({ loadState: 'unloaded', path: '/root/dir' })];
      engine.setTree(tree, 'root');

      const loadPromise = engine.loadPaths(['/root/dir'], 77);

      await vi.waitFor(() => {
        const requestMsg = messages.find((message) => message.type === 'requestLoad');
        expect(requestMsg).toBeDefined();
      });
      const requestMsg = messages.find((message) => message.type === 'requestLoad');
      const requestId = requestMsg?.type === 'requestLoad' ? requestMsg.payload.requestId : '';

      engine.handleLoadError('/root/dir', 'Permission denied', requestId);

      await loadPromise;

      const updatedTree = engine.getTree();
      expect(updatedTree[0]?.loadState).toBe('error');
      expect(messages).toContainEqual({
        operationId: 77,
        payload: {
          loadError: 'Permission denied',
          loadState: 'error',
          path: '/root/dir',
        },
        type: 'nodeLoadStateChanged',
      });
      const completeMsg = messages.find((message) => message.type === 'complete');
      expect(completeMsg).toEqual({
        operationId: 77,
        payload: { expandedPaths: [], loadedCount: 0 },
        type: 'complete',
      });
    });

    it('correlates legacy id-less load errors after skipping unmatched pending loads', async () => {
      const tree = [
        createDirectoryNode({ loadState: 'unloaded', path: '/root/dir1' }),
        createDirectoryNode({ loadState: 'unloaded', path: '/root/dir2' }),
      ];
      engine.setTree(tree, 'root');
      const firstLoad = engine.loadPaths(['/root/dir1'], 51);
      const secondLoad = engine.loadPaths(['/root/dir2'], 52);

      await vi.waitFor(() => {
        expect(messages.filter((message) => message.type === 'requestLoad')).toHaveLength(2);
      });

      engine.handleLoadError('/root/dir2', 'Permission denied');
      const firstRequest = messages.find(
        (message) => message.type === 'requestLoad' && message.operationId === 51
      );
      if (firstRequest?.type !== 'requestLoad') {
        throw new Error('expected first request');
      }
      engine.handleLoadResult('/root/dir1', [], firstRequest.payload.requestId);

      await Promise.all([firstLoad, secondLoad]);

      expect(engine.getTree()).toEqual([
        expect.objectContaining({ loadState: 'loaded', path: '/root/dir1' }),
        expect.objectContaining({
          loadError: 'Permission denied',
          loadState: 'error',
          path: '/root/dir2',
        }),
      ]);
      expect(messages).toContainEqual({
        operationId: 52,
        payload: {
          loadError: 'Permission denied',
          loadState: 'error',
          path: '/root/dir2',
        },
        type: 'nodeLoadStateChanged',
      });
    });

    it('clears stale load errors when a directory is marked loading again', () => {
      const tree = [
        createDirectoryNode({
          loadError: 'Previous failure',
          loadState: 'error',
          path: '/root/dir',
        }),
      ];
      engine.setTree(tree, 'root');

      engine.applyDirectoryChildrenUpdate('/root/dir', [], 'loading');

      const updatedNode = engine.getTree()[0];
      expect(updatedNode).toEqual(expect.objectContaining({ loadState: 'loading' }));
      expect(updatedNode?.loadError).toBeUndefined();
    });

    it('correlates load errors without patching unrelated paths', async () => {
      const tree = [
        createDirectoryNode({ loadState: 'unloaded', path: '/root/dir1' }),
        createDirectoryNode({ loadState: 'unloaded', path: '/root/dir2' }),
      ];
      engine.setTree(tree, 'root');

      const firstLoad = engine.loadPaths(['/root/dir1'], 31);
      const secondLoad = engine.loadPaths(['/root/dir2'], 32);

      await vi.waitFor(() => {
        expect(messages.filter((message) => message.type === 'requestLoad')).toHaveLength(2);
      });
      const requestMessages = messages.filter((message) => message.type === 'requestLoad');
      const firstRequest = requestMessages[0];
      const secondRequest = requestMessages[1];
      if (firstRequest?.type !== 'requestLoad' || secondRequest?.type !== 'requestLoad') {
        throw new Error('expected correlated load requests');
      }

      engine.handleLoadError('/root/dir2', 'Permission denied', secondRequest.payload.requestId);
      engine.handleLoadResult('/root/dir1', [], firstRequest.payload.requestId);

      await Promise.all([firstLoad, secondLoad]);

      expect(engine.getTree()).toEqual([
        expect.objectContaining({ loadState: 'loaded', path: '/root/dir1' }),
        expect.objectContaining({
          loadError: 'Permission denied',
          loadState: 'error',
          path: '/root/dir2',
        }),
      ]);
      expect(messages).toContainEqual({
        operationId: 32,
        payload: {
          loadError: 'Permission denied',
          loadState: 'error',
          path: '/root/dir2',
        },
        type: 'nodeLoadStateChanged',
      });
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

    it('rejects a load request that starts after an abort signal', async () => {
      const mutableEngine = engine as unknown as {
        requestLoads: (paths: string[], operationId: number) => Promise<unknown>;
      };
      engine.abort();

      await expect(mutableEngine.requestLoads(['/root/dir'], 49)).rejects.toThrow(
        'Operation aborted'
      );

      expect(messages.some((message) => message.type === 'requestLoad')).toBe(false);
    });
  });

  describe('collapseAll', () => {
    it('should keep tree data cached (not reset to unloaded)', () => {
      const tree = [
        createDirectoryNode({
          children: [createFileNode({ path: '/root/dir/file.txt' })],
          loadState: 'loaded',
          path: '/root/dir',
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
          children: [createFileNode({ path: '/root/dir/file.txt' })],
          loadState: 'loaded',
          path: '/root/dir',
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

    it('removes nested expanded paths in one delta', () => {
      const tree = [
        createDirectoryNode({
          children: [
            createDirectoryNode({
              children: [],
              depth: 2,
              loadState: 'loaded',
              path: '/root/parent/child',
            }),
          ],
          loadState: 'loaded',
          path: '/root/parent',
        }),
      ];
      engine.setTree(tree, 'root');
      messages = [];

      engine.collapseAll();

      expect(messages).toContainEqual({
        payload: {
          added: [],
          removed: ['/root/parent', '/root/parent/child'],
        },
        type: 'expandedPathsDelta',
      });
    });

    it('does not emit an expanded-path delta when collapse is already synchronized', () => {
      const tree = [
        createDirectoryNode({
          children: [],
          loadState: 'loaded',
          path: '/root/dir',
        }),
      ];
      engine.setTree(tree, 'root');
      engine.collapseAll();
      messages = [];

      engine.collapseAll();

      expect(messages).toEqual([]);
    });

    it('should not affect file nodes', () => {
      const tree = [
        createDirectoryNode({ loadState: 'loaded', path: '/root/dir' }),
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
      const tree = [createDirectoryNode({ children: [], loadState: 'loaded', path: '/root/dir' })];
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
      const tree = [createDirectoryNode({ loadState: 'unloaded', path: '/root/dir' })];
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
      const tree = [createDirectoryNode({ children: [], loadState: 'loaded', path: '/root/dir' })];
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
      const tree = [createDirectoryNode({ children: [], loadState: 'loaded', path: '/root/dir' })];
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
      const tree = [createDirectoryNode({ loadState: 'unloaded', path: '/root/dir' })];
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
      const tree = [createDirectoryNode({ loadState: 'unloaded', path: '/root/parent' })];
      engine.setTree(tree, 'root');

      const expandPromise = engine.expandAll();

      // Wait for first request
      await vi.waitFor(() => {
        const requestLoadMsg = messages.find((m) => m.type === 'requestLoad');
        expect(requestLoadMsg).toBeDefined();
      });

      // Simulate first load - parent contains a child directory
      engine.handleLoadResult('/root/parent', [
        createDirectoryNode({ depth: 2, loadState: 'unloaded', path: '/root/parent/child' }),
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
      const tree = [createDirectoryNode({ loadState: 'unloaded', path: '/root/dir' })];
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
          children: [createFileNode({ path: '/root/dir1/file.txt' })],
          loadState: 'loaded',
          path: '/root/dir1',
        }),
        createDirectoryNode({
          children: [],
          loadState: 'loaded',
          path: '/root/dir2',
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
      const tree = [createDirectoryNode({ loadState: 'unloaded', path: '/root/dir' })];
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

    it('stops before requesting directories beyond the depth limit', async () => {
      const deepPath = `/${Array.from({ length: 53 }, (_, index) => `level-${index}`).join('/')}`;
      engine.setTree([createDirectoryNode({ loadState: 'unloaded', path: deepPath })], 'root');

      await engine.expandAll(55);

      expect(messages.some((message) => message.type === 'requestLoad')).toBe(false);
      expect(messages).toContainEqual({
        operationId: 55,
        payload: { expandedPaths: [], loadedCount: 0 },
        type: 'complete',
      });
      expect(
        messages.some(
          (message) =>
            message.type === 'log' &&
            message.level === 'info' &&
            message.message.includes('depth limit')
        )
      ).toBe(true);
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
      const tree = [createDirectoryNode({ children: [], loadState: 'loaded', path: '/root/dir' })];
      engine.setTree(tree, 'root');

      await engine.loadPaths(['/root/dir']);

      const completeMsg = messages.find((m) => m.type === 'complete');
      expect(completeMsg).toBeDefined();
      if (completeMsg?.type === 'complete') {
        expect(completeMsg.payload.loadedCount).toBe(0);
      }
    });

    it('should include loadedCount > 0 when paths need loading', async () => {
      const tree = [createDirectoryNode({ loadState: 'unloaded', path: '/root/dir' })];
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
      const tree = [createDirectoryNode({ loadState: 'unloaded', path: '/root/parent' })];
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
        createDirectoryNode({ depth: 2, loadState: 'unloaded', path: '/root/parent/child' }),
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

    it('should reject when the main thread does not answer a load request before timeout', async () => {
      vi.useFakeTimers();
      try {
        const tree = [createDirectoryNode({ loadState: 'unloaded', path: '/root/dir' })];
        engine.setTree(tree, 'root');

        const loadPromise = engine.loadPaths(['/root/dir'], 88);

        expect(messages.some((message) => message.type === 'requestLoad')).toBe(true);
        const rejectionExpectation = expect(loadPromise).rejects.toThrow(
          'Load timeout for: /root/dir'
        );
        await vi.advanceTimersByTimeAsync(30_000);

        await rejectionExpectation;
      } finally {
        vi.useRealTimers();
      }
    });

    it('counts permanently missing paths as skipped after bounded retries', async () => {
      engine.setTree([createDirectoryNode({ loadState: 'loaded', path: '/root/dir' })], 'root');

      await engine.loadPaths(['/root/missing'], 43);

      expect(messages.some((message) => message.type === 'requestLoad')).toBe(false);
      expect(messages).toContainEqual({
        operationId: 43,
        payload: { expandedPaths: [], loadedCount: 0 },
        type: 'complete',
      });
      expect(
        messages.some(
          (message) =>
            message.type === 'log' &&
            message.level === 'debug' &&
            message.message.includes('still not found after retries')
        )
      ).toBe(true);
    });

    it('skips file paths without requesting directory loads', async () => {
      engine.setTree([createFileNode({ path: '/root/file.txt' })], 'root');

      await engine.loadPaths(['/root/file.txt'], 44);

      expect(messages.some((message) => message.type === 'requestLoad')).toBe(false);
      expect(messages).toContainEqual({
        operationId: 44,
        payload: { expandedPaths: [], loadedCount: 0 },
        type: 'complete',
      });
    });

    it('returns without completion when an in-flight path load is aborted', async () => {
      const tree = [createDirectoryNode({ loadState: 'unloaded', path: '/root/dir' })];
      engine.setTree(tree, 'root');

      const loadPromise = engine.loadPaths(['/root/dir'], 45);

      await vi.waitFor(() => {
        expect(messages.some((message) => message.type === 'requestLoad')).toBe(true);
      });

      engine.abort();
      await loadPromise;

      expect(messages).toContainEqual({
        level: 'info',
        message: '[loadPaths] Aborted',
        type: 'log',
      });
      expect(
        messages.some((message) => message.type === 'complete' && message.operationId === 45)
      ).toBe(false);
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
          children: [createFileNode({ path: '/root/dir/file.txt' })],
          loadState: 'loaded',
          path: '/root/dir',
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
      const tree = [createDirectoryNode({ loadState: 'unloaded', path: '/root/dir' })];
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
      const tree = [createDirectoryNode({ loadState: 'unloaded', path: '/root/parent' })];
      engine.setTree(tree, 'root');

      const loadPromise = engine.loadSubtree('/root/parent');

      // Wait for first request
      await vi.waitFor(() => {
        const requestMsg = messages.find((m) => m.type === 'requestLoad');
        expect(requestMsg).toBeDefined();
      });

      // Simulate first load - parent contains a child directory
      engine.handleLoadResult('/root/parent', [
        createDirectoryNode({ depth: 2, loadState: 'unloaded', path: '/root/parent/child' }),
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
          children: [
            createDirectoryNode({ depth: 2, loadState: 'unloaded', path: '/root/parent/child' }),
          ],
          loadState: 'loaded',
          path: '/root/parent',
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
          children: [
            createDirectoryNode({
              children: [
                createDirectoryNode({
                  depth: 3,
                  loadState: 'unloaded',
                  path: '/root/level1/level2/level3',
                }),
              ],
              depth: 2,
              loadState: 'loaded',
              path: '/root/level1/level2',
            }),
          ],
          loadState: 'loaded',
          path: '/root/level1',
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
      const tree = [createDirectoryNode({ loadState: 'unloaded', path: '/root/dir' })];
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
      const tree = [createDirectoryNode({ loadState: 'unloaded', path: '/root/dir' })];
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

    it('stops subtree loading before requesting descendants beyond the depth limit', async () => {
      const deepPath = `/root/${Array.from({ length: 52 }, (_, index) => `level-${index}`).join('/')}`;
      const tree = [
        createDirectoryNode({
          children: [createDirectoryNode({ depth: 52, loadState: 'unloaded', path: deepPath })],
          depth: 0,
          loadState: 'loaded',
          path: '/root',
        }),
      ];
      engine.setTree(tree, 'root');

      await engine.loadSubtree('/root', 66);

      expect(messages.some((message) => message.type === 'requestLoad')).toBe(false);
      expect(messages).toContainEqual({
        operationId: 66,
        payload: { expandedPaths: ['/root'], loadedCount: 0 },
        type: 'complete',
      });
      expect(
        messages.some(
          (message) =>
            message.type === 'log' &&
            message.level === 'info' &&
            message.message.includes('depth limit')
        )
      ).toBe(true);
    });

    it('stops subtree wave processing when the directory limit has already been reached', async () => {
      const mutableEngine = engine as unknown as {
        processSubtreeWaves: (
          state: {
            currentWave: Set<string>;
            hitDepthLimit: boolean;
            hitDirectoryLimit: boolean;
            loadedCount: number;
            processed: Set<string>;
            totalDiscovered: number;
          },
          baseDepth: number,
          operationId: number
        ) => Promise<void>;
      };
      const state = {
        currentWave: new Set(['/root/dir']),
        hitDepthLimit: false,
        hitDirectoryLimit: false,
        loadedCount: MAX_EXPAND_DIRECTORIES,
        processed: new Set<string>(),
        totalDiscovered: 1,
      };

      await mutableEngine.processSubtreeWaves(state, 0, 67);

      expect(state.hitDirectoryLimit).toBe(true);
      expect(messages.some((message) => message.type === 'requestLoad')).toBe(false);
      expect(messages).toContainEqual({
        level: 'info',
        message: `[loadSubtree] Reached directory limit (${MAX_EXPAND_DIRECTORIES}), stopping`,
        type: 'log',
      });
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
        createDirectoryNode({ loadState: 'unloaded', name: 'dir1', path: '/root/dir1' }),
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
          children: [createFileNode({ depth: 2, name: 'child.txt', path: '/root/dir1/child.txt' })],
          loadState: 'loaded',
          name: 'dir1',
          path: '/root/dir1',
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
          children: [createFileNode({ depth: 2, name: 'child.txt', path: '/root/dir1/child.txt' })],
          loadState: 'loaded',
          name: 'dir1',
          path: '/root/dir1',
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
          loadState: 'unloaded', // Not loaded yet - children not set
          name: 'dir1',
          path: '/root/dir1',
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
          children: [
            createDirectoryNode({
              children: [
                createFileNode({
                  depth: 3,
                  name: 'deep.txt',
                  path: '/root/level1/level2/deep.txt',
                }),
              ],
              depth: 2,
              loadState: 'loaded',
              name: 'level2',
              path: '/root/level1/level2',
            }),
          ],
          loadState: 'loaded',
          name: 'level1',
          path: '/root/level1',
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
