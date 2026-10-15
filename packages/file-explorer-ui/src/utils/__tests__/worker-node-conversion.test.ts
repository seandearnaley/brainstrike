// @vitest-environment node
/**
 * Tests for worker-node-conversion utilities
 *
 * Tests the conversion between IFileNode (with FileNodeHandle) and
 * WorkerFileNode (transferable to worker, no handle).
 */

import type { WorkerFileNode } from '@brainstrike/file-tree-worker';
import type { IFileNode } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';

import {
  addHandlesToMap,
  buildHandleMap,
  type FileNodeHandle,
  rehydrateFileNode,
  rehydrateTree,
  toWorkerFileNode,
  toWorkerFileNodes,
} from '../worker-node-conversion';

// Mock FileNodeHandle for testing
const createMockHandle = (name: string): FileSystemDirectoryHandle =>
  ({
    kind: 'directory',
    name,
  }) as FileSystemDirectoryHandle;

const createMockFileHandle = (name: string): FileSystemFileHandle =>
  ({
    kind: 'file',
    name,
  }) as FileSystemFileHandle;

describe('worker-node-conversion', () => {
  it('retains native descriptor identity when a worker tree is rehydrated', () => {
    const node: IFileNode = {
      depth: 1,
      handle: {
        kind: 'file',
        name: 'file.ts',
        path: '/root/file.ts',
        platform: 'electron',
        rootId: 'mounted-root',
      },
      name: 'file.ts',
      path: '/root/file.ts',
      rootFolderId: 'selection-root',
      selectionState: 'unchecked',
      type: 'file',
    };

    const handles = buildHandleMap([node]);
    const [rehydrated] = rehydrateTree(toWorkerFileNodes([node]), handles);

    expect(rehydrated?.handle).toBe(node.handle);
    expect(rehydrated?.handle).toMatchObject({ rootId: 'mounted-root' });
  });

  describe('toWorkerFileNode', () => {
    it('should convert a basic file node', () => {
      const fileNode: IFileNode = {
        depth: 1,
        handle: createMockFileHandle('test.ts'),
        name: 'test.ts',
        path: '/root/test.ts',
        rootFolderId: 'root',
        selectionState: 'checked',
        type: 'file',
      };

      const result = toWorkerFileNode(fileNode);

      expect(result).toEqual({
        depth: 1,
        name: 'test.ts',
        path: '/root/test.ts',
        rootFolderId: 'root',
        type: 'file',
      });
    });

    it('should convert a directory node with children', () => {
      const dirNode: IFileNode = {
        children: [
          {
            depth: 2,
            handle: createMockFileHandle('file.ts'),
            name: 'file.ts',
            path: '/root/src/file.ts',
            rootFolderId: 'root',
            selectionState: 'unchecked',
            type: 'file',
          },
        ],
        depth: 1,
        handle: createMockHandle('src'),
        name: 'src',
        path: '/root/src',
        rootFolderId: 'root',
        selectionState: 'unchecked',
        type: 'directory',
      };

      const result = toWorkerFileNode(dirNode);

      expect(result?.children).toHaveLength(1);
      expect(result!.children![0]!.name).toBe('file.ts');
    });

    it('should return null for loadMore nodes', () => {
      // loadMore nodes in practice don't have handles, but IFileNode requires one
      // The function filters these out regardless
      const loadMoreNode = {
        depth: 1,
        handle: {} as FileSystemFileHandle,
        name: 'Load more...',
        path: '/root/loadMore',
        rootFolderId: 'root',
        selectionState: 'unchecked',
        type: 'loadMore',
      } as IFileNode;

      const result = toWorkerFileNode(loadMoreNode);

      expect(result).toBeNull();
    });

    it('should return null for truncated nodes', () => {
      const truncatedNode = {
        depth: 1,
        handle: {} as FileSystemFileHandle,
        name: 'Showing first 10,000 entries',
        path: '/root/…truncated…',
        rootFolderId: 'root',
        selectionState: 'unchecked',
        type: 'truncated',
      } as IFileNode;

      const result = toWorkerFileNode(truncatedNode);

      expect(result).toBeNull();
    });

    it('should filter out loadMore children', () => {
      const dirNode: IFileNode = {
        children: [
          {
            depth: 2,
            handle: createMockFileHandle('file.ts'),
            name: 'file.ts',
            path: '/root/src/file.ts',
            rootFolderId: 'root',
            selectionState: 'unchecked',
            type: 'file',
          },
          {
            depth: 2,
            handle: {} as FileSystemFileHandle,
            name: 'Load more...',
            path: '/root/src/loadMore',
            rootFolderId: 'root',
            selectionState: 'unchecked',
            type: 'loadMore',
          } as IFileNode,
        ],
        depth: 1,
        handle: createMockHandle('src'),
        name: 'src',
        path: '/root/src',
        rootFolderId: 'root',
        selectionState: 'unchecked',
        type: 'directory',
      };

      const result = toWorkerFileNode(dirNode);

      expect(result?.children).toHaveLength(1);
      expect(result!.children![0]!.name).toBe('file.ts');
    });

    it('should copy optional properties', () => {
      const fileNode: IFileNode = {
        depth: 1,
        handle: createMockFileHandle('test.ts'),
        lastModified: 1_234_567_890,
        loadError: 'test error',
        loadState: 'loaded',
        name: 'test.ts',
        path: '/root/test.ts',
        rootFolderId: 'root',
        selectionState: 'unchecked',
        size: 1024,
        type: 'file',
      };

      const result = toWorkerFileNode(fileNode);

      expect(result?.loadState).toBe('loaded');
      expect(result?.loadError).toBe('test error');
      expect(result?.size).toBe(1024);
      expect(result?.lastModified).toBe(1_234_567_890);
    });
  });

  describe('toWorkerFileNodes', () => {
    it('should convert multiple nodes', () => {
      const nodes: IFileNode[] = [
        {
          depth: 1,
          handle: createMockFileHandle('file1.ts'),
          name: 'file1.ts',
          path: '/root/file1.ts',
          rootFolderId: 'root',
          selectionState: 'unchecked',
          type: 'file',
        },
        {
          depth: 1,
          handle: createMockFileHandle('file2.ts'),
          name: 'file2.ts',
          path: '/root/file2.ts',
          rootFolderId: 'root',
          selectionState: 'unchecked',
          type: 'file',
        },
      ];

      const result = toWorkerFileNodes(nodes);

      expect(result).toHaveLength(2);
      expect(result[0]!.name).toBe('file1.ts');
      expect(result[1]!.name).toBe('file2.ts');
    });

    it('should filter out loadMore nodes from array', () => {
      const nodes: IFileNode[] = [
        {
          depth: 1,
          handle: createMockFileHandle('file.ts'),
          name: 'file.ts',
          path: '/root/file.ts',
          rootFolderId: 'root',
          selectionState: 'unchecked',
          type: 'file',
        },
        {
          depth: 1,
          handle: {} as FileSystemFileHandle,
          name: 'Load more...',
          path: '/root/loadMore',
          rootFolderId: 'root',
          selectionState: 'unchecked',
          type: 'loadMore',
        } as IFileNode,
      ];

      const result = toWorkerFileNodes(nodes);

      expect(result).toHaveLength(1);
      expect(result[0]!.name).toBe('file.ts');
    });
  });

  describe('rehydrateFileNode', () => {
    it('should rehydrate a node with handle from map', () => {
      const workerNode: WorkerFileNode = {
        depth: 1,
        name: 'test.ts',
        path: '/root/test.ts',
        rootFolderId: 'root',
        type: 'file',
      };

      const handle = createMockFileHandle('test.ts');
      const handleMap = new Map<string, FileNodeHandle>([['/root/test.ts', handle]]);

      const result = rehydrateFileNode(workerNode, handleMap);

      expect(result).not.toBeNull();
      expect(result?.name).toBe('test.ts');
      expect(result?.handle).toBe(handle);
      expect(result?.selectionState).toBe('unchecked');
    });

    it('should return null when handle is not in map', () => {
      const workerNode: WorkerFileNode = {
        depth: 1,
        name: 'test.ts',
        path: '/root/test.ts',
        rootFolderId: 'root',
        type: 'file',
      };

      const handleMap = new Map<string, FileNodeHandle>();

      const result = rehydrateFileNode(workerNode, handleMap);

      expect(result).toBeNull();
    });

    it('should rehydrate children recursively', () => {
      const workerNode: WorkerFileNode = {
        children: [
          {
            depth: 2,
            name: 'file.ts',
            path: '/root/src/file.ts',
            rootFolderId: 'root',
            type: 'file',
          },
        ],
        depth: 1,
        name: 'src',
        path: '/root/src',
        rootFolderId: 'root',
        type: 'directory',
      };

      const dirHandle = createMockHandle('src');
      const fileHandle = createMockFileHandle('file.ts');
      const handleMap = new Map<string, FileNodeHandle>([
        ['/root/src', dirHandle],
        ['/root/src/file.ts', fileHandle],
      ]);

      const result = rehydrateFileNode(workerNode, handleMap);

      expect(result?.children).toHaveLength(1);
      expect(result!.children![0]!.name).toBe('file.ts');
      expect(result!.children![0]!.handle).toBe(fileHandle);
    });

    it('should filter out children without handles', () => {
      const workerNode: WorkerFileNode = {
        children: [
          {
            depth: 2,
            name: 'file1.ts',
            path: '/root/src/file1.ts',
            rootFolderId: 'root',
            type: 'file',
          },
          {
            depth: 2,
            name: 'file2.ts',
            path: '/root/src/file2.ts',
            rootFolderId: 'root',
            type: 'file',
          },
        ],
        depth: 1,
        name: 'src',
        path: '/root/src',
        rootFolderId: 'root',
        type: 'directory',
      };

      const dirHandle = createMockHandle('src');
      const file1Handle = createMockFileHandle('file1.ts');
      // Intentionally not including file2 handle
      const handleMap = new Map<string, FileNodeHandle>([
        ['/root/src', dirHandle],
        ['/root/src/file1.ts', file1Handle],
      ]);

      const result = rehydrateFileNode(workerNode, handleMap);

      expect(result?.children).toHaveLength(1);
      expect(result!.children![0]!.name).toBe('file1.ts');
    });

    it('should copy optional properties from worker node', () => {
      const workerNode: WorkerFileNode = {
        depth: 1,
        lastModified: 9_876_543_210,
        loadError: 'some error',
        loadState: 'loaded',
        name: 'test.ts',
        path: '/root/test.ts',
        rootFolderId: 'root',
        size: 2048,
        type: 'file',
      };

      const handle = createMockFileHandle('test.ts');
      const handleMap = new Map<string, FileNodeHandle>([['/root/test.ts', handle]]);

      const result = rehydrateFileNode(workerNode, handleMap);

      expect(result?.loadState).toBe('loaded');
      expect(result?.loadError).toBe('some error');
      expect(result?.size).toBe(2048);
      expect(result?.lastModified).toBe(9_876_543_210);
    });
  });

  describe('rehydrateTree', () => {
    it('should rehydrate all nodes in tree', () => {
      const workerNodes: WorkerFileNode[] = [
        {
          depth: 1,
          name: 'file1.ts',
          path: '/root/file1.ts',
          rootFolderId: 'root',
          type: 'file',
        },
        {
          depth: 1,
          name: 'file2.ts',
          path: '/root/file2.ts',
          rootFolderId: 'root',
          type: 'file',
        },
      ];

      const handle1 = createMockFileHandle('file1.ts');
      const handle2 = createMockFileHandle('file2.ts');
      const handleMap = new Map<string, FileNodeHandle>([
        ['/root/file1.ts', handle1],
        ['/root/file2.ts', handle2],
      ]);

      const result = rehydrateTree(workerNodes, handleMap);

      expect(result).toHaveLength(2);
      expect(result[0]!.handle).toBe(handle1);
      expect(result[1]!.handle).toBe(handle2);
    });

    it('should filter out nodes without handles', () => {
      const workerNodes: WorkerFileNode[] = [
        {
          depth: 1,
          name: 'file1.ts',
          path: '/root/file1.ts',
          rootFolderId: 'root',
          type: 'file',
        },
        {
          depth: 1,
          name: 'file2.ts',
          path: '/root/file2.ts',
          rootFolderId: 'root',
          type: 'file',
        },
      ];

      const handle1 = createMockFileHandle('file1.ts');
      // Intentionally only including file1 handle
      const handleMap = new Map<string, FileNodeHandle>([['/root/file1.ts', handle1]]);

      const result = rehydrateTree(workerNodes, handleMap);

      expect(result).toHaveLength(1);
      expect(result[0]!.name).toBe('file1.ts');
    });
  });

  describe('buildHandleMap', () => {
    it('should build a map from nodes with handles', () => {
      const handle1 = createMockFileHandle('file1.ts');
      const handle2 = createMockFileHandle('file2.ts');

      const nodes: IFileNode[] = [
        {
          depth: 1,
          handle: handle1,
          name: 'file1.ts',
          path: '/root/file1.ts',
          rootFolderId: 'root',
          selectionState: 'unchecked',
          type: 'file',
        },
        {
          depth: 1,
          handle: handle2,
          name: 'file2.ts',
          path: '/root/file2.ts',
          rootFolderId: 'root',
          selectionState: 'unchecked',
          type: 'file',
        },
      ];

      const result = buildHandleMap(nodes);

      expect(result.size).toBe(2);
      expect(result.get('/root/file1.ts')).toBe(handle1);
      expect(result.get('/root/file2.ts')).toBe(handle2);
    });

    it('should include handles from children', () => {
      const dirHandle = createMockHandle('src');
      const fileHandle = createMockFileHandle('file.ts');

      const nodes: IFileNode[] = [
        {
          children: [
            {
              depth: 2,
              handle: fileHandle,
              name: 'file.ts',
              path: '/root/src/file.ts',
              rootFolderId: 'root',
              selectionState: 'unchecked',
              type: 'file',
            },
          ],
          depth: 1,
          handle: dirHandle,
          name: 'src',
          path: '/root/src',
          rootFolderId: 'root',
          selectionState: 'unchecked',
          type: 'directory',
        },
      ];

      const result = buildHandleMap(nodes);

      expect(result.size).toBe(2);
      expect(result.get('/root/src')).toBe(dirHandle);
      expect(result.get('/root/src/file.ts')).toBe(fileHandle);
    });

    it('should skip nodes without handles', () => {
      const handle = createMockFileHandle('file.ts');

      const nodes: IFileNode[] = [
        {
          depth: 1,
          handle,
          name: 'file.ts',
          path: '/root/file.ts',
          rootFolderId: 'root',
          selectionState: 'unchecked',
          type: 'file',
        },
        // loadMore nodes require handle in IFileNode type, so cast with assertion
        {
          depth: 1,
          handle: {} as FileSystemFileHandle,
          name: 'loadMore',
          path: '/root/loadMore',
          rootFolderId: 'root',
          selectionState: 'unchecked',
          type: 'loadMore',
        } as IFileNode,
      ];

      const result = buildHandleMap(nodes);

      // The loadMore node does have a handle (empty object), so it will be in the map
      expect(result.size).toBe(2);
      expect(result.get('/root/file.ts')).toBe(handle);
    });

    it('should use existing map when provided', () => {
      const existingHandle = createMockFileHandle('existing.ts');
      const newHandle = createMockFileHandle('new.ts');

      const existingMap = new Map<string, FileNodeHandle>([['/root/existing.ts', existingHandle]]);

      const nodes: IFileNode[] = [
        {
          depth: 1,
          handle: newHandle,
          name: 'new.ts',
          path: '/root/new.ts',
          rootFolderId: 'root',
          selectionState: 'unchecked',
          type: 'file',
        },
      ];

      const result = buildHandleMap(nodes, existingMap);

      expect(result.size).toBe(2);
      expect(result.get('/root/existing.ts')).toBe(existingHandle);
      expect(result.get('/root/new.ts')).toBe(newHandle);
    });
  });

  describe('addHandlesToMap', () => {
    it('should add handles to existing map', () => {
      const handle = createMockFileHandle('file.ts');
      const map = new Map<string, FileNodeHandle>();

      const nodes: IFileNode[] = [
        {
          depth: 1,
          handle,
          name: 'file.ts',
          path: '/root/file.ts',
          rootFolderId: 'root',
          selectionState: 'unchecked',
          type: 'file',
        },
      ];

      addHandlesToMap(nodes, map);

      expect(map.size).toBe(1);
      expect(map.get('/root/file.ts')).toBe(handle);
    });

    it('should add handles from children', () => {
      const dirHandle = createMockHandle('src');
      const fileHandle = createMockFileHandle('file.ts');
      const map = new Map<string, FileNodeHandle>();

      const nodes: IFileNode[] = [
        {
          children: [
            {
              depth: 2,
              handle: fileHandle,
              name: 'file.ts',
              path: '/root/src/file.ts',
              rootFolderId: 'root',
              selectionState: 'unchecked',
              type: 'file',
            },
          ],
          depth: 1,
          handle: dirHandle,
          name: 'src',
          path: '/root/src',
          rootFolderId: 'root',
          selectionState: 'unchecked',
          type: 'directory',
        },
      ];

      addHandlesToMap(nodes, map);

      expect(map.size).toBe(2);
      expect(map.get('/root/src')).toBe(dirHandle);
      expect(map.get('/root/src/file.ts')).toBe(fileHandle);
    });
  });
});
