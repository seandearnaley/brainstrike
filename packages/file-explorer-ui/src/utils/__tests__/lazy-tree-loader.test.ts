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
  loadDirectoryChildrenStreaming,
  loadRootDirectory,
  loadRootDirectoryStreaming,
  needsLoading,
  setNodeLoadState,
  supportsStreaming,
  updateNodeChildren,
} from '../lazy-tree-loader';

// Mock file filter while preserving real tree operations
vi.mock('@brainstrike/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/utils')>();
  return {
    ...actual,
    fileFilter: {
      shouldIgnorePath: (path: string) => path.startsWith('.') || path === 'node_modules',
    },
  };
});

describe('lazy-tree-loader', () => {
  // Mock handle for test nodes
  const mockHandle = {} as FileSystemDirectoryHandle;

  // Helper to create a mock file node
  const createFileNode = (overrides: Partial<IFileNode> = {}): IFileNode => ({
    depth: 0,
    handle: mockHandle,
    isVisible: true,
    name: 'test-file.ts',
    path: '/root/test-file.ts',
    rootFolderId: 'root',
    selectionState: 'unchecked',
    type: 'file',
    ...overrides,
  });

  // Helper to create a mock directory node (simulating adapter output with children: [])
  const createDirectoryNode = (overrides: Partial<IFileNode> = {}): IFileNode => ({
    children: [], // Adapters set this to empty array
    depth: 0,
    handle: mockHandle,
    isVisible: true,
    name: 'test-dir',
    path: '/root/test-dir',
    rootFolderId: 'root',
    selectionState: 'unchecked',
    type: 'directory',
    ...overrides,
  });

  // Helper to create a mock directory handle
  const createDirectoryHandle = (overrides: Partial<DirectoryHandle> = {}): DirectoryHandle => ({
    kind: 'directory',
    name: 'root',
    path: '/root',
    platform: 'electron',
    ...overrides,
  });

  // Helper to create a mock file system adapter
  const createMockAdapter = (readDirectoryResult: IFileNode[] = []): FileSystemAdapter => ({
    exists: vi.fn(),
    readDirectory: vi.fn().mockResolvedValue(readDirectoryResult),
    readFile: vi.fn(),
    requestDirectoryAccess: vi.fn(),
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
        createDirectoryNode({ children: [], name: 'subdir', path: '/root/subdir' }),
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
        createDirectoryNode({ children: [], name: 'subdir', path: '/root/subdir' }),
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

    it('sets rootFolderId from the canonical handle path', async () => {
      const mockChildren = [createFileNode({ name: 'file.ts', path: '/my-project/file.ts' })];
      const adapter = createMockAdapter(mockChildren);
      const handle = createDirectoryHandle({ name: 'display-name', path: '/my-project' });

      const result = await loadRootDirectory(adapter, handle);

      expect(result[0]!.rootFolderId).toBe('/my-project');
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
        createDirectoryNode({ children: [], name: 'nested', path: '/root/parent/nested' }),
      ];
      const adapter = createMockAdapter(mockChildren);
      const parentNode = createDirectoryNode({
        depth: 0,
        name: 'parent',
        path: '/root/parent',
        rootFolderId: 'root',
      });

      const result = await loadDirectoryChildren(adapter, parentNode);

      expect(result[0]!.loadState).toBe('unloaded');
    });

    it('removes children property from nested directories', async () => {
      const mockChildren = [
        createDirectoryNode({ children: [], name: 'nested', path: '/root/parent/nested' }),
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
        depth: 2,
        name: 'parent',
        path: '/root/parent',
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
      const tree: IFileNode[] = [createDirectoryNode({ loadState: 'loading', path: '/root/dir' })];
      const newChildren = [createFileNode({ path: '/root/dir/file.ts' })];

      const result = updateNodeChildren(tree, '/root/dir', newChildren, 'loaded');

      expect(result[0]!.children).toEqual(newChildren);
      expect(result[0]!.loadState).toBe('loaded');
    });

    it('traverses nested paths', () => {
      const tree: IFileNode[] = [
        createDirectoryNode({
          children: [createDirectoryNode({ loadState: 'loading', path: '/root/parent/child' })],
          path: '/root/parent',
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
      const tree: IFileNode[] = [createDirectoryNode({ loadState: 'unloaded', path: '/root/dir' })];

      const result = setNodeLoadState(tree, '/root/dir', 'loading');

      expect(result[0]!.loadState).toBe('loading');
    });

    it('sets error message when provided', () => {
      const tree: IFileNode[] = [createDirectoryNode({ loadState: 'loading', path: '/root/dir' })];

      const result = setNodeLoadState(tree, '/root/dir', 'error', 'Failed to load');

      expect(result[0]!.loadState).toBe('error');
      expect(result[0]!.loadError).toBe('Failed to load');
    });

    it('clears error when not provided', () => {
      const tree: IFileNode[] = [
        createDirectoryNode({
          loadError: 'Previous error',
          loadState: 'error',
          path: '/root/dir',
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
          children: [
            createDirectoryNode({
              children: [createFileNode({ path: '/root/parent/child/file.ts' })],
              path: '/root/parent/child',
            }),
          ],
          path: '/root/parent',
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

  describe('supportsStreaming', () => {
    it('returns true when adapter has readDirectoryStreaming', () => {
      const adapter = createMockAdapter();
      adapter.readDirectoryStreaming = vi.fn();

      expect(supportsStreaming(adapter)).toBe(true);
    });

    it('returns false when adapter lacks readDirectoryStreaming', () => {
      const adapter = createMockAdapter();

      expect(supportsStreaming(adapter)).toBe(false);
    });
  });

  describe('loadDirectoryChildrenStreaming', () => {
    it('falls back to non-streaming when adapter lacks streaming support', async () => {
      const mockChildren = [createFileNode({ name: 'file.ts', path: '/root/parent/file.ts' })];
      const adapter = createMockAdapter(mockChildren);
      const parentNode = createDirectoryNode({
        depth: 0,
        name: 'parent',
        path: '/root/parent',
        rootFolderId: 'root',
      });

      const batches: { nodes: IFileNode[]; done: boolean }[] = [];
      await loadDirectoryChildrenStreaming(adapter, parentNode, (nodes, meta) => {
        batches.push({ done: meta.done, nodes });
      });

      expect(batches).toHaveLength(1);
      expect(batches[0]!.done).toBe(true);
      expect(batches[0]!.nodes).toHaveLength(1);
    });

    it('preserves the signal reason when the non-streaming fallback is aborted during read', async () => {
      const adapter = createMockAdapter();
      const parentNode = createDirectoryNode({
        depth: 0,
        name: 'parent',
        path: '/root/parent',
        rootFolderId: 'root',
      });
      const abortController = new AbortController();
      const abortReason = new Error('caller cancelled child fallback');
      vi.mocked(adapter.readDirectory).mockImplementation(async () => {
        abortController.abort(abortReason);
        return [];
      });
      const onBatch = vi.fn();

      await expect(
        loadDirectoryChildrenStreaming(adapter, parentNode, onBatch, {
          abortSignal: abortController.signal,
        })
      ).rejects.toBe(abortReason);

      expect(onBatch).not.toHaveBeenCalled();
    });

    it('uses streaming when adapter supports it', async () => {
      const adapter = createMockAdapter();
      adapter.readDirectoryStreaming = vi.fn(async (_handle, onBatch) => {
        // Simulate batched streaming
        onBatch([createFileNode({ name: 'file1.ts', path: '/root/parent/file1.ts' })], {
          done: false,
          total: 2,
        });
        onBatch([createFileNode({ name: 'file2.ts', path: '/root/parent/file2.ts' })], {
          done: true,
          total: 2,
        });
      });

      const parentNode = createDirectoryNode({
        depth: 0,
        name: 'parent',
        path: '/root/parent',
        rootFolderId: 'root',
      });

      const batches: { nodes: IFileNode[]; done: boolean; total: number }[] = [];
      await loadDirectoryChildrenStreaming(adapter, parentNode, (nodes, meta) => {
        batches.push({ done: meta.done, nodes, total: meta.total });
      });

      expect(batches).toHaveLength(2);
      expect(batches[0]!.done).toBe(false);
      expect(batches[1]!.done).toBe(true);
    });

    it('throws for non-directory parent', async () => {
      const adapter = createMockAdapter();
      const fileNode = createFileNode();

      await expect(loadDirectoryChildrenStreaming(adapter, fileNode, vi.fn())).rejects.toThrow(
        'Cannot load children of non-directory node'
      );
    });

    it('throws on abort signal', async () => {
      const adapter = createMockAdapter([]);
      const parentNode = createDirectoryNode({ path: '/root/parent' });
      const abortController = new AbortController();
      const abortReason = new Error('caller cancelled child enumeration');
      abortController.abort(abortReason);

      await expect(
        loadDirectoryChildrenStreaming(adapter, parentNode, vi.fn(), {
          abortSignal: abortController.signal,
        })
      ).rejects.toBe(abortReason);
    });
  });

  describe('loadRootDirectoryStreaming', () => {
    it('falls back to non-streaming when adapter lacks streaming support', async () => {
      const mockChildren = [createFileNode({ name: 'file.ts', path: '/root/file.ts' })];
      const adapter = createMockAdapter(mockChildren);
      const handle = createDirectoryHandle();

      const batches: { nodes: IFileNode[]; done: boolean }[] = [];
      await loadRootDirectoryStreaming(adapter, handle, (nodes, meta) => {
        batches.push({ done: meta.done, nodes });
      });

      expect(batches).toHaveLength(1);
      expect(batches[0]!.done).toBe(true);
      expect(batches[0]!.nodes).toHaveLength(1);
    });

    it('preserves the signal reason when the root fallback is aborted during read', async () => {
      const adapter = createMockAdapter();
      const handle = createDirectoryHandle();
      const abortController = new AbortController();
      const abortReason = new Error('caller cancelled root fallback');
      vi.mocked(adapter.readDirectory).mockImplementation(async () => {
        abortController.abort(abortReason);
        return [];
      });
      const onBatch = vi.fn();

      await expect(
        loadRootDirectoryStreaming(adapter, handle, onBatch, {
          abortSignal: abortController.signal,
        })
      ).rejects.toBe(abortReason);

      expect(onBatch).not.toHaveBeenCalled();
    });

    it('uses streaming when adapter supports it', async () => {
      const adapter = createMockAdapter();
      adapter.readDirectoryStreaming = vi.fn(async (_handle, onBatch) => {
        onBatch([createDirectoryNode({ children: [], name: 'src', path: '/root/src' })], {
          done: false,
          total: 2,
        });
        onBatch([createFileNode({ name: 'README.md', path: '/root/README.md' })], {
          done: true,
          total: 2,
        });
      });

      const handle = createDirectoryHandle();

      const batches: { nodes: IFileNode[]; done: boolean }[] = [];
      await loadRootDirectoryStreaming(adapter, handle, (nodes, meta) => {
        batches.push({ done: meta.done, nodes });
      });

      expect(batches).toHaveLength(2);
      // Final batch has sorted accumulated nodes
      expect(batches[1]!.done).toBe(true);
    });

    it('sets loadState=unloaded for directories in streamed results', async () => {
      const adapter = createMockAdapter();
      adapter.readDirectoryStreaming = vi.fn(async (_handle, onBatch) => {
        onBatch([createDirectoryNode({ children: [], name: 'src', path: '/root/src' })], {
          done: true,
          total: 1,
        });
      });

      const handle = createDirectoryHandle();

      let finalNodes: IFileNode[] = [];
      await loadRootDirectoryStreaming(adapter, handle, (nodes, meta) => {
        if (meta.done) {
          finalNodes = nodes;
        }
      });

      const dirNode = finalNodes.find((n) => n.type === 'directory');
      expect(dirNode?.loadState).toBe('unloaded');
      expect(dirNode?.children).toBeUndefined();
    });

    it('throws on abort signal', async () => {
      const adapter = createMockAdapter([]);
      const handle = createDirectoryHandle();
      const abortController = new AbortController();
      const abortReason = new Error('caller cancelled root enumeration');
      abortController.abort(abortReason);

      await expect(
        loadRootDirectoryStreaming(adapter, handle, vi.fn(), {
          abortSignal: abortController.signal,
        })
      ).rejects.toBe(abortReason);
    });

    it('propagates cancellation after a partial batch without emitting successful completion', async () => {
      const adapter = createMockAdapter();
      const handle = createDirectoryHandle();
      const abortController = new AbortController();
      const abortReason = new DOMException('Directory enumeration cancelled', 'AbortError');
      adapter.readDirectoryStreaming = vi.fn(async (_handle, onBatch, options) => {
        onBatch([createFileNode({ name: 'partial.ts', path: '/root/partial.ts' })], {
          done: false,
          total: 1,
        });
        abortController.abort(abortReason);
        options?.signal?.throwIfAborted();
      });
      const batches: Array<{ done: boolean; names: string[] }> = [];

      await expect(
        loadRootDirectoryStreaming(
          adapter,
          handle,
          (nodes, meta) => {
            batches.push({ done: meta.done, names: nodes.map((node) => node.name) });
          },
          { abortSignal: abortController.signal }
        )
      ).rejects.toBe(abortReason);

      expect(batches).toEqual([{ done: false, names: ['partial.ts'] }]);
    });
  });

  describe('streaming batch semantics', () => {
    it('intermediate batches contain only current batch items, final batch contains all sorted', async () => {
      const adapter = createMockAdapter();
      adapter.readDirectoryStreaming = vi.fn(async (_handle, onBatch) => {
        // Emit 3 batches with deterministic data (names chosen to test sorting)
        onBatch(
          [
            createDirectoryNode({ children: [], name: 'zulu', path: '/root/zulu' }),
            createFileNode({ name: 'beta.ts', path: '/root/beta.ts' }),
          ],
          { done: false, total: 6 }
        );
        onBatch(
          [
            createFileNode({ name: 'alpha.ts', path: '/root/alpha.ts' }),
            createDirectoryNode({ children: [], name: 'src', path: '/root/src' }),
          ],
          { done: false, total: 6 }
        );
        onBatch(
          [
            createFileNode({ name: 'gamma.ts', path: '/root/gamma.ts' }),
            createDirectoryNode({ children: [], name: 'docs', path: '/root/docs' }),
          ],
          { done: true, total: 6 }
        );
      });

      const handle = createDirectoryHandle();
      const batches: { nodes: IFileNode[]; done: boolean; total: number }[] = [];

      await loadRootDirectoryStreaming(adapter, handle, (nodes, meta) => {
        batches.push({ done: meta.done, nodes: [...nodes], total: meta.total });
      });

      // Verify batch count
      expect(batches).toHaveLength(3);

      // Verify intermediate batches contain only their batch items
      expect(batches[0]!.done).toBe(false);
      expect(batches[0]!.nodes).toHaveLength(2);
      expect(batches[0]!.nodes.map((n) => n.name)).toEqual(['zulu', 'beta.ts']);

      expect(batches[1]!.done).toBe(false);
      expect(batches[1]!.nodes).toHaveLength(2);
      expect(batches[1]!.nodes.map((n) => n.name)).toEqual(['alpha.ts', 'src']);

      // Verify final batch contains ALL items (6 total), sorted (directories first, then files alphabetically)
      expect(batches[2]!.done).toBe(true);
      expect(batches[2]!.nodes).toHaveLength(6);

      // Default sort: directories first (alphabetically), then files (alphabetically)
      const finalNames = batches[2]!.nodes.map((n) => n.name);
      expect(finalNames).toEqual(['docs', 'src', 'zulu', 'alpha.ts', 'beta.ts', 'gamma.ts']);
    });

    it('filters ignored items from all batches including final accumulated result', async () => {
      const adapter = createMockAdapter();
      adapter.readDirectoryStreaming = vi.fn(async (_handle, onBatch) => {
        onBatch(
          [
            createFileNode({ name: 'valid.ts', path: '/root/valid.ts' }),
            createDirectoryNode({ children: [], name: 'node_modules', path: '/root/node_modules' }),
          ],
          { done: false, total: 4 }
        );
        onBatch(
          [
            createDirectoryNode({ children: [], name: '.git', path: '/root/.git' }),
            createFileNode({ name: 'also-valid.ts', path: '/root/also-valid.ts' }),
          ],
          { done: true, total: 4 }
        );
      });

      const handle = createDirectoryHandle();
      const batches: { nodes: IFileNode[]; done: boolean }[] = [];

      await loadRootDirectoryStreaming(adapter, handle, (nodes, meta) => {
        batches.push({ done: meta.done, nodes: [...nodes] });
      });

      // Intermediate batch should only contain valid.ts (node_modules filtered)
      expect(batches[0]!.nodes).toHaveLength(1);
      expect(batches[0]!.nodes[0]!.name).toBe('valid.ts');

      // Final batch should contain only valid items (2 total, not 4)
      expect(batches[1]!.nodes).toHaveLength(2);
      const finalNames = batches[1]!.nodes.map((n) => n.name);
      expect(finalNames).toContain('valid.ts');
      expect(finalNames).toContain('also-valid.ts');
      expect(finalNames).not.toContain('node_modules');
      expect(finalNames).not.toContain('.git');
    });

    it('handles empty batches correctly', async () => {
      const adapter = createMockAdapter();
      adapter.readDirectoryStreaming = vi.fn(async (_handle, onBatch) => {
        // First batch has items
        onBatch([createFileNode({ name: 'file.ts', path: '/root/file.ts' })], {
          done: false,
          total: 1,
        });
        // Final batch is empty (all items were in previous batch)
        onBatch([], { done: true, total: 1 });
      });

      const handle = createDirectoryHandle();
      const batches: { nodes: IFileNode[]; done: boolean }[] = [];

      await loadRootDirectoryStreaming(adapter, handle, (nodes, meta) => {
        batches.push({ done: meta.done, nodes: [...nodes] });
      });

      expect(batches).toHaveLength(2);
      expect(batches[0]!.nodes).toHaveLength(1);
      // Final batch should still have accumulated items even though this batch was empty
      expect(batches[1]!.done).toBe(true);
      expect(batches[1]!.nodes).toHaveLength(1);
      expect(batches[1]!.nodes[0]!.name).toBe('file.ts');
    });
  });
});
