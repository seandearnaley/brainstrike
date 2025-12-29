/**
 * Tests for worker-node-conversion utilities
 *
 * Tests the conversion between IFileNode (with FileSystemHandle) and
 * WorkerFileNode (transferable to worker, no handle).
 */

import type { WorkerFileNode } from '@brainstrike/file-tree-worker';
import type { IFileNode } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';

import {
  addHandlesToMap,
  buildHandleMap,
  type FileSystemHandle,
  rehydrateFileNode,
  rehydrateTree,
  toWorkerFileNode,
  toWorkerFileNodes,
} from '../worker-node-conversion';

// Mock FileSystemHandle for testing
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
  describe('toWorkerFileNode', () => {
    it('should convert a basic file node', () => {
      const fileNode: IFileNode = {
        name: 'test.ts',
        path: '/root/test.ts',
        type: 'file',
        depth: 1,
        rootFolderId: 'root',
        handle: createMockFileHandle('test.ts'),
        selectionState: 'checked',
      };

      const result = toWorkerFileNode(fileNode);

      expect(result).toEqual({
        name: 'test.ts',
        path: '/root/test.ts',
        type: 'file',
        depth: 1,
        rootFolderId: 'root',
      });
    });

    it('should convert a directory node with children', () => {
      const dirNode: IFileNode = {
        name: 'src',
        path: '/root/src',
        type: 'directory',
        depth: 1,
        rootFolderId: 'root',
        handle: createMockHandle('src'),
        selectionState: 'unchecked',
        children: [
          {
            name: 'file.ts',
            path: '/root/src/file.ts',
            type: 'file',
            depth: 2,
            rootFolderId: 'root',
            handle: createMockFileHandle('file.ts'),
            selectionState: 'unchecked',
          },
        ],
      };

      const result = toWorkerFileNode(dirNode);

      expect(result?.children).toHaveLength(1);
      expect(result!.children![0]!.name).toBe('file.ts');
    });

    it('should return null for loadMore nodes', () => {
      // loadMore nodes in practice don't have handles, but IFileNode requires one
      // The function filters these out regardless
      const loadMoreNode = {
        name: 'Load more...',
        path: '/root/loadMore',
        type: 'loadMore',
        depth: 1,
        rootFolderId: 'root',
        selectionState: 'unchecked',
        handle: {} as FileSystemFileHandle,
      } as IFileNode;

      const result = toWorkerFileNode(loadMoreNode);

      expect(result).toBeNull();
    });

    it('should filter out loadMore children', () => {
      const dirNode: IFileNode = {
        name: 'src',
        path: '/root/src',
        type: 'directory',
        depth: 1,
        rootFolderId: 'root',
        handle: createMockHandle('src'),
        selectionState: 'unchecked',
        children: [
          {
            name: 'file.ts',
            path: '/root/src/file.ts',
            type: 'file',
            depth: 2,
            rootFolderId: 'root',
            handle: createMockFileHandle('file.ts'),
            selectionState: 'unchecked',
          },
          {
            name: 'Load more...',
            path: '/root/src/loadMore',
            type: 'loadMore',
            depth: 2,
            rootFolderId: 'root',
            selectionState: 'unchecked',
            handle: {} as FileSystemFileHandle,
          } as IFileNode,
        ],
      };

      const result = toWorkerFileNode(dirNode);

      expect(result?.children).toHaveLength(1);
      expect(result!.children![0]!.name).toBe('file.ts');
    });

    it('should copy optional properties', () => {
      const fileNode: IFileNode = {
        name: 'test.ts',
        path: '/root/test.ts',
        type: 'file',
        depth: 1,
        rootFolderId: 'root',
        handle: createMockFileHandle('test.ts'),
        selectionState: 'unchecked',
        loadState: 'loaded',
        loadError: 'test error',
        size: 1024,
        lastModified: 1_234_567_890,
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
          name: 'file1.ts',
          path: '/root/file1.ts',
          type: 'file',
          depth: 1,
          rootFolderId: 'root',
          handle: createMockFileHandle('file1.ts'),
          selectionState: 'unchecked',
        },
        {
          name: 'file2.ts',
          path: '/root/file2.ts',
          type: 'file',
          depth: 1,
          rootFolderId: 'root',
          handle: createMockFileHandle('file2.ts'),
          selectionState: 'unchecked',
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
          name: 'file.ts',
          path: '/root/file.ts',
          type: 'file',
          depth: 1,
          rootFolderId: 'root',
          handle: createMockFileHandle('file.ts'),
          selectionState: 'unchecked',
        },
        {
          name: 'Load more...',
          path: '/root/loadMore',
          type: 'loadMore',
          depth: 1,
          rootFolderId: 'root',
          selectionState: 'unchecked',
          handle: {} as FileSystemFileHandle,
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
        name: 'test.ts',
        path: '/root/test.ts',
        type: 'file',
        depth: 1,
        rootFolderId: 'root',
      };

      const handle = createMockFileHandle('test.ts');
      const handleMap = new Map<string, FileSystemHandle>([['/root/test.ts', handle]]);

      const result = rehydrateFileNode(workerNode, handleMap);

      expect(result).not.toBeNull();
      expect(result?.name).toBe('test.ts');
      expect(result?.handle).toBe(handle);
      expect(result?.selectionState).toBe('unchecked');
    });

    it('should return null when handle is not in map', () => {
      const workerNode: WorkerFileNode = {
        name: 'test.ts',
        path: '/root/test.ts',
        type: 'file',
        depth: 1,
        rootFolderId: 'root',
      };

      const handleMap = new Map<string, FileSystemHandle>();

      const result = rehydrateFileNode(workerNode, handleMap);

      expect(result).toBeNull();
    });

    it('should rehydrate children recursively', () => {
      const workerNode: WorkerFileNode = {
        name: 'src',
        path: '/root/src',
        type: 'directory',
        depth: 1,
        rootFolderId: 'root',
        children: [
          {
            name: 'file.ts',
            path: '/root/src/file.ts',
            type: 'file',
            depth: 2,
            rootFolderId: 'root',
          },
        ],
      };

      const dirHandle = createMockHandle('src');
      const fileHandle = createMockFileHandle('file.ts');
      const handleMap = new Map<string, FileSystemHandle>([
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
        name: 'src',
        path: '/root/src',
        type: 'directory',
        depth: 1,
        rootFolderId: 'root',
        children: [
          {
            name: 'file1.ts',
            path: '/root/src/file1.ts',
            type: 'file',
            depth: 2,
            rootFolderId: 'root',
          },
          {
            name: 'file2.ts',
            path: '/root/src/file2.ts',
            type: 'file',
            depth: 2,
            rootFolderId: 'root',
          },
        ],
      };

      const dirHandle = createMockHandle('src');
      const file1Handle = createMockFileHandle('file1.ts');
      // Intentionally not including file2 handle
      const handleMap = new Map<string, FileSystemHandle>([
        ['/root/src', dirHandle],
        ['/root/src/file1.ts', file1Handle],
      ]);

      const result = rehydrateFileNode(workerNode, handleMap);

      expect(result?.children).toHaveLength(1);
      expect(result!.children![0]!.name).toBe('file1.ts');
    });

    it('should copy optional properties from worker node', () => {
      const workerNode: WorkerFileNode = {
        name: 'test.ts',
        path: '/root/test.ts',
        type: 'file',
        depth: 1,
        rootFolderId: 'root',
        loadState: 'loaded',
        loadError: 'some error',
        size: 2048,
        lastModified: 9_876_543_210,
      };

      const handle = createMockFileHandle('test.ts');
      const handleMap = new Map<string, FileSystemHandle>([['/root/test.ts', handle]]);

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
          name: 'file1.ts',
          path: '/root/file1.ts',
          type: 'file',
          depth: 1,
          rootFolderId: 'root',
        },
        {
          name: 'file2.ts',
          path: '/root/file2.ts',
          type: 'file',
          depth: 1,
          rootFolderId: 'root',
        },
      ];

      const handle1 = createMockFileHandle('file1.ts');
      const handle2 = createMockFileHandle('file2.ts');
      const handleMap = new Map<string, FileSystemHandle>([
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
          name: 'file1.ts',
          path: '/root/file1.ts',
          type: 'file',
          depth: 1,
          rootFolderId: 'root',
        },
        {
          name: 'file2.ts',
          path: '/root/file2.ts',
          type: 'file',
          depth: 1,
          rootFolderId: 'root',
        },
      ];

      const handle1 = createMockFileHandle('file1.ts');
      // Intentionally only including file1 handle
      const handleMap = new Map<string, FileSystemHandle>([['/root/file1.ts', handle1]]);

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
          name: 'file1.ts',
          path: '/root/file1.ts',
          type: 'file',
          depth: 1,
          rootFolderId: 'root',
          handle: handle1,
          selectionState: 'unchecked',
        },
        {
          name: 'file2.ts',
          path: '/root/file2.ts',
          type: 'file',
          depth: 1,
          rootFolderId: 'root',
          handle: handle2,
          selectionState: 'unchecked',
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
          name: 'src',
          path: '/root/src',
          type: 'directory',
          depth: 1,
          rootFolderId: 'root',
          handle: dirHandle,
          selectionState: 'unchecked',
          children: [
            {
              name: 'file.ts',
              path: '/root/src/file.ts',
              type: 'file',
              depth: 2,
              rootFolderId: 'root',
              handle: fileHandle,
              selectionState: 'unchecked',
            },
          ],
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
          name: 'file.ts',
          path: '/root/file.ts',
          type: 'file',
          depth: 1,
          rootFolderId: 'root',
          handle,
          selectionState: 'unchecked',
        },
        // loadMore nodes require handle in IFileNode type, so cast with assertion
        {
          name: 'loadMore',
          path: '/root/loadMore',
          type: 'loadMore',
          depth: 1,
          rootFolderId: 'root',
          selectionState: 'unchecked',
          handle: {} as FileSystemFileHandle,
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

      const existingMap = new Map<string, FileSystemHandle>([
        ['/root/existing.ts', existingHandle],
      ]);

      const nodes: IFileNode[] = [
        {
          name: 'new.ts',
          path: '/root/new.ts',
          type: 'file',
          depth: 1,
          rootFolderId: 'root',
          handle: newHandle,
          selectionState: 'unchecked',
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
      const map = new Map<string, FileSystemHandle>();

      const nodes: IFileNode[] = [
        {
          name: 'file.ts',
          path: '/root/file.ts',
          type: 'file',
          depth: 1,
          rootFolderId: 'root',
          handle,
          selectionState: 'unchecked',
        },
      ];

      addHandlesToMap(nodes, map);

      expect(map.size).toBe(1);
      expect(map.get('/root/file.ts')).toBe(handle);
    });

    it('should add handles from children', () => {
      const dirHandle = createMockHandle('src');
      const fileHandle = createMockFileHandle('file.ts');
      const map = new Map<string, FileSystemHandle>();

      const nodes: IFileNode[] = [
        {
          name: 'src',
          path: '/root/src',
          type: 'directory',
          depth: 1,
          rootFolderId: 'root',
          handle: dirHandle,
          selectionState: 'unchecked',
          children: [
            {
              name: 'file.ts',
              path: '/root/src/file.ts',
              type: 'file',
              depth: 2,
              rootFolderId: 'root',
              handle: fileHandle,
              selectionState: 'unchecked',
            },
          ],
        },
      ];

      addHandlesToMap(nodes, map);

      expect(map.size).toBe(2);
      expect(map.get('/root/src')).toBe(dirHandle);
      expect(map.get('/root/src/file.ts')).toBe(fileHandle);
    });
  });
});
