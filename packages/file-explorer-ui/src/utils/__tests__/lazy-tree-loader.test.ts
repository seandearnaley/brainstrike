/**
 * Tests for lazy-tree-loader utilities
 *
 * These tests verify the lazy loading functionality for the file tree,
 * including proper handling of loadState and children properties.
 */

import type { DirectoryHandle, FileSystemAdapter, IFileNode } from '@brainstrike/types';
import { describe, expect, it, vi } from 'vitest';
import {
  findNodeByPath,
  loadDirectoryChildren,
  loadRootDirectory,
  needsLoading,
  setNodeLoadState,
  updateNodeChildren,
} from '../lazy-tree-loader';

// Mock file filter
vi.mock('@brainstrike/utils', () => ({
  fileFilter: {
    shouldIgnorePath: (path: string) => path.startsWith('.') || path === 'node_modules',
  },
}));

describe('lazy-tree-loader', () => {
  // Mock handle for test nodes
  const mockHandle = {} as FileSystemDirectoryHandle;

  // Helper to create a mock file node
  const createFileNode = (overrides: Partial<IFileNode> = {}): IFileNode => ({
    name: 'test-file.ts',
    path: '/root/test-file.ts',
    type: 'file',
    depth: 0,
    selectionState: 'unchecked',
    rootFolderId: 'root',
    isVisible: true,
    handle: mockHandle,
    ...overrides,
  });

  // Helper to create a mock directory node (simulating adapter output with children: [])
  const createDirectoryNode = (overrides: Partial<IFileNode> = {}): IFileNode => ({
    name: 'test-dir',
    path: '/root/test-dir',
    type: 'directory',
    depth: 0,
    selectionState: 'unchecked',
    children: [], // Adapters set this to empty array
    rootFolderId: 'root',
    isVisible: true,
    handle: mockHandle,
    ...overrides,
  });

  // Helper to create a mock directory handle
  const createDirectoryHandle = (overrides: Partial<DirectoryHandle> = {}): DirectoryHandle => ({
    path: '/root',
    name: 'root',
    kind: 'directory',
    platform: 'electron',
    ...overrides,
  });

  // Helper to create a mock file system adapter
  const createMockAdapter = (readDirectoryResult: IFileNode[] = []): FileSystemAdapter => ({
    requestDirectoryAccess: vi.fn(),
    readDirectory: vi.fn().mockResolvedValue(readDirectoryResult),
    readFile: vi.fn(),
    exists: vi.fn(),
    watchDirectory: vi.fn(),
  });

  describe('needsLoading', () => {
    it('returns true for directory with loadState=unloaded', () => {
      const node = createDirectoryNode({ loadState: 'unloaded' });
      expect(needsLoading(node)).toBe(true);
    });

    it('returns true for directory with no loadState', () => {
      // Create node without loadState property (the default from createDirectoryNode)
      const node = createDirectoryNode();
      // Verify loadState is not set
      expect(node.loadState).toBeUndefined();
      expect(needsLoading(node)).toBe(true);
    });

    it('returns false for directory with loadState=loading', () => {
      const node = createDirectoryNode({ loadState: 'loading' });
      expect(needsLoading(node)).toBe(false);
    });

    it('returns false for directory with loadState=loaded', () => {
      const node = createDirectoryNode({ loadState: 'loaded' });
      expect(needsLoading(node)).toBe(false);
    });

    it('returns false for directory with loadState=error', () => {
      const node = createDirectoryNode({ loadState: 'error' });
      expect(needsLoading(node)).toBe(false);
    });

    it('returns false for file nodes regardless of loadState', () => {
      const node = createFileNode({ loadState: 'unloaded' as never });
      expect(needsLoading(node)).toBe(false);
    });
  });

  describe('loadRootDirectory', () => {
    it('sets loadState=unloaded for directories', async () => {
      const mockChildren = [
        createDirectoryNode({ name: 'subdir', path: '/root/subdir', children: [] }),
        createFileNode({ name: 'file.ts', path: '/root/file.ts' }),
      ];
      const adapter = createMockAdapter(mockChildren);
      const handle = createDirectoryHandle();

      const result = await loadRootDirectory(adapter, handle);

      const dirNode = result.find((n) => n.type === 'directory');
      expect(dirNode?.loadState).toBe('unloaded');
    });

    it('removes children property from directories (adapters set children: [])', async () => {
      const mockChildren = [
        createDirectoryNode({ name: 'subdir', path: '/root/subdir', children: [] }),
      ];
      const adapter = createMockAdapter(mockChildren);
      const handle = createDirectoryHandle();

      const result = await loadRootDirectory(adapter, handle);

      const dirNode = result.find((n) => n.type === 'directory');
      expect(dirNode?.children).toBeUndefined();
    });

    it('does not set loadState for files', async () => {
      const mockChildren = [createFileNode({ name: 'file.ts', path: '/root/file.ts' })];
      const adapter = createMockAdapter(mockChildren);
      const handle = createDirectoryHandle();

      const result = await loadRootDirectory(adapter, handle);

      const fileNode = result.find((n) => n.type === 'file');
      expect(fileNode?.loadState).toBeUndefined();
    });

    it('filters out ignored paths', async () => {
      const mockChildren = [
        createDirectoryNode({ name: 'node_modules', path: '/root/node_modules' }),
        createDirectoryNode({ name: '.git', path: '/root/.git' }),
        createDirectoryNode({ name: 'src', path: '/root/src' }),
      ];
      const adapter = createMockAdapter(mockChildren);
      const handle = createDirectoryHandle();

      const result = await loadRootDirectory(adapter, handle);

      expect(result).toHaveLength(1);
      expect(result[0]!.name).toBe('src');
    });

    it('sets rootFolderId from handle name', async () => {
      const mockChildren = [createFileNode({ name: 'file.ts', path: '/my-project/file.ts' })];
      const adapter = createMockAdapter(mockChildren);
      const handle = createDirectoryHandle({ name: 'my-project', path: '/my-project' });

      const result = await loadRootDirectory(adapter, handle);

      expect(result[0]!.rootFolderId).toBe('my-project');
    });

    it('throws on abort signal', async () => {
      const adapter = createMockAdapter([]);
      const handle = createDirectoryHandle();
      const abortController = new AbortController();
      abortController.abort();

      await expect(
        loadRootDirectory(adapter, handle, { abortSignal: abortController.signal })
      ).rejects.toThrow('Operation was cancelled');
    });
  });

  describe('loadDirectoryChildren', () => {
    it('sets loadState=unloaded for nested directories', async () => {
      const mockChildren = [
        createDirectoryNode({ name: 'nested', path: '/root/parent/nested', children: [] }),
      ];
      const adapter = createMockAdapter(mockChildren);
      const parentNode = createDirectoryNode({
        name: 'parent',
        path: '/root/parent',
        depth: 0,
        rootFolderId: 'root',
      });

      const result = await loadDirectoryChildren(adapter, parentNode);

      expect(result[0]!.loadState).toBe('unloaded');
    });

    it('removes children property from nested directories', async () => {
      const mockChildren = [
        createDirectoryNode({ name: 'nested', path: '/root/parent/nested', children: [] }),
      ];
      const adapter = createMockAdapter(mockChildren);
      const parentNode = createDirectoryNode({
        name: 'parent',
        path: '/root/parent',
      });

      const result = await loadDirectoryChildren(adapter, parentNode);

      expect(result[0]!.children).toBeUndefined();
    });

    it('increments depth for children', async () => {
      const mockChildren = [
        createFileNode({ name: 'file.ts', path: '/root/parent/file.ts' }),
        createDirectoryNode({ name: 'nested', path: '/root/parent/nested' }),
      ];
      const adapter = createMockAdapter(mockChildren);
      const parentNode = createDirectoryNode({
        name: 'parent',
        path: '/root/parent',
        depth: 2,
      });

      const result = await loadDirectoryChildren(adapter, parentNode);

      expect(result.every((n) => n.depth === 3)).toBe(true);
    });

    it('preserves rootFolderId from parent', async () => {
      const mockChildren = [createFileNode({ name: 'file.ts', path: '/root/parent/file.ts' })];
      const adapter = createMockAdapter(mockChildren);
      const parentNode = createDirectoryNode({
        name: 'parent',
        path: '/root/parent',
        rootFolderId: 'my-root',
      });

      const result = await loadDirectoryChildren(adapter, parentNode);

      expect(result[0]!.rootFolderId).toBe('my-root');
    });

    it('throws for non-directory parent', async () => {
      const adapter = createMockAdapter([]);
      const fileNode = createFileNode();

      await expect(loadDirectoryChildren(adapter, fileNode)).rejects.toThrow(
        'Cannot load children of non-directory node'
      );
    });
  });

  describe('updateNodeChildren', () => {
    it('updates children of target node', () => {
      const tree: IFileNode[] = [createDirectoryNode({ path: '/root/dir', loadState: 'loading' })];
      const newChildren = [createFileNode({ path: '/root/dir/file.ts' })];

      const result = updateNodeChildren(tree, '/root/dir', newChildren, 'loaded');

      expect(result[0]!.children).toEqual(newChildren);
      expect(result[0]!.loadState).toBe('loaded');
    });

    it('traverses nested paths', () => {
      const tree: IFileNode[] = [
        createDirectoryNode({
          path: '/root/parent',
          children: [createDirectoryNode({ path: '/root/parent/child', loadState: 'loading' })],
        }),
      ];
      const newChildren = [createFileNode({ path: '/root/parent/child/file.ts' })];

      const result = updateNodeChildren(tree, '/root/parent/child', newChildren, 'loaded');

      const parent = result[0]!;
      const child = parent.children?.[0];
      expect(child?.children).toEqual(newChildren);
      expect(child?.loadState).toBe('loaded');
    });

    it('returns unmodified tree if path not found', () => {
      const tree: IFileNode[] = [createDirectoryNode({ path: '/root/dir' })];

      const result = updateNodeChildren(tree, '/nonexistent', [], 'loaded');

      expect(result).toEqual(tree);
    });
  });

  describe('setNodeLoadState', () => {
    it('sets loadState on target node', () => {
      const tree: IFileNode[] = [createDirectoryNode({ path: '/root/dir', loadState: 'unloaded' })];

      const result = setNodeLoadState(tree, '/root/dir', 'loading');

      expect(result[0]!.loadState).toBe('loading');
    });

    it('sets error message when provided', () => {
      const tree: IFileNode[] = [createDirectoryNode({ path: '/root/dir', loadState: 'loading' })];

      const result = setNodeLoadState(tree, '/root/dir', 'error', 'Failed to load');

      expect(result[0]!.loadState).toBe('error');
      expect(result[0]!.loadError).toBe('Failed to load');
    });

    it('clears error when not provided', () => {
      const tree: IFileNode[] = [
        createDirectoryNode({
          path: '/root/dir',
          loadState: 'error',
          loadError: 'Previous error',
        }),
      ];

      const result = setNodeLoadState(tree, '/root/dir', 'loaded');

      expect(result[0]!.loadError).toBeUndefined();
    });
  });

  describe('findNodeByPath', () => {
    it('finds root-level node', () => {
      const tree: IFileNode[] = [
        createDirectoryNode({ path: '/root/dir' }),
        createFileNode({ path: '/root/file.ts' }),
      ];

      const result = findNodeByPath(tree, '/root/dir');

      expect(result?.path).toBe('/root/dir');
    });

    it('finds nested node', () => {
      const tree: IFileNode[] = [
        createDirectoryNode({
          path: '/root/parent',
          children: [
            createDirectoryNode({
              path: '/root/parent/child',
              children: [createFileNode({ path: '/root/parent/child/file.ts' })],
            }),
          ],
        }),
      ];

      const result = findNodeByPath(tree, '/root/parent/child/file.ts');

      expect(result?.path).toBe('/root/parent/child/file.ts');
    });

    it('returns null for non-existent path', () => {
      const tree: IFileNode[] = [createDirectoryNode({ path: '/root/dir' })];

      const result = findNodeByPath(tree, '/nonexistent');

      expect(result).toBeNull();
    });
  });
});
