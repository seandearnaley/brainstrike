import type { DirectoryHandle, FileSystemAdapter, IFileNode } from '@brainstrike/types';
import { describe, expect, it, vi } from 'vitest';

import { querySelectableFiles } from '../recursive-selection-query';

vi.mock('@brainstrike/utils/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/utils/logger')>();
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

function createFileNode(overrides: Partial<IFileNode> & { name: string; path: string }): IFileNode {
  return {
    type: 'file',
    depth: 0,
    handle: {} as FileSystemFileHandle,
    selectionState: 'unchecked',
    rootFolderId: '/root',
    isVisible: true,
    ...overrides,
  };
}

function createDirectoryNode(
  overrides: Partial<IFileNode> & { name: string; path: string }
): IFileNode {
  return {
    type: 'directory',
    depth: 0,
    handle: {} as FileSystemDirectoryHandle,
    selectionState: 'unchecked',
    rootFolderId: '/root',
    isVisible: true,
    loadState: 'unloaded',
    children: [],
    ...overrides,
  };
}

function createMockAdapter(directoryMap: Record<string, IFileNode[]>): FileSystemAdapter {
  const readDirectory = vi.fn(async (handle: DirectoryHandle) => directoryMap[handle.path] ?? []);

  return {
    requestDirectoryAccess: vi.fn(),
    readDirectory,
    readFile: vi.fn(),
    exists: vi.fn(),
  } as unknown as FileSystemAdapter;
}

describe('recursive-selection-query', () => {
  it('stops on already-loaded visible files before reading deeper unloaded directories', async () => {
    const adapter = createMockAdapter({
      '/root/src': [createFileNode({ path: '/root/src/deep.ts', name: 'deep.ts', depth: 2 })],
    });

    const root = createDirectoryNode({
      path: '/root',
      name: 'root',
      loadState: 'loaded',
      children: [
        createFileNode({ path: '/root/README.md', name: 'README.md', depth: 1 }),
        createDirectoryNode({ path: '/root/src', name: 'src', depth: 1, loadState: 'unloaded' }),
      ],
    });

    const result = await querySelectableFiles({
      roots: [root],
      fileSystemAdapter: adapter,
      includeFilters: [],
      excludeFilters: [],
      maxResults: 1,
      useRegex: false,
    });

    expect(result.filePaths).toEqual(['/root/README.md']);
    expect(adapter.readDirectory).not.toHaveBeenCalled();
  });

  it('reads only the breadth-first frontier needed to satisfy a low cap', async () => {
    const adapter = createMockAdapter({
      '/root': [
        createDirectoryNode({
          path: '/root/a-dir',
          name: 'a-dir',
          depth: 1,
          loadState: 'unloaded',
        }),
        createFileNode({ path: '/root/file-1.ts', name: 'file-1.ts', depth: 1 }),
        createFileNode({ path: '/root/file-2.ts', name: 'file-2.ts', depth: 1 }),
      ],
      '/root/a-dir': [createFileNode({ path: '/root/a-dir/deep.ts', name: 'deep.ts', depth: 2 })],
    });

    const root = createDirectoryNode({
      path: '/root',
      name: 'root',
      loadState: 'unloaded',
    });

    const result = await querySelectableFiles({
      roots: [root],
      fileSystemAdapter: adapter,
      includeFilters: [],
      excludeFilters: [],
      maxResults: 2,
      useRegex: false,
    });

    expect(result.filePaths).toEqual(['/root/file-1.ts', '/root/file-2.ts']);
    expect(result.limitReached).toBe(true);
    expect(adapter.readDirectory).toHaveBeenCalledTimes(1);
    expect(adapter.readDirectory).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/root' }),
      expect.anything()
    );
  });

  it('applies filterTreeFn to loaded and adapter-read nodes', async () => {
    const adapter = createMockAdapter({
      '/root': [
        createDirectoryNode({ path: '/root/src', name: 'src', depth: 1, loadState: 'unloaded' }),
        createFileNode({ path: '/root/readme.md', name: 'readme.md', depth: 1 }),
      ],
      '/root/src': [
        createFileNode({ path: '/root/src/keep.ts', name: 'keep.ts', depth: 2 }),
        createFileNode({ path: '/root/src/skip.md', name: 'skip.md', depth: 2 }),
      ],
    });

    const filterTreeFn = vi.fn((nodes: IFileNode[]): IFileNode[] =>
      nodes.filter((node) => (node.type === 'directory' ? true : node.path.endsWith('.ts')))
    );

    const root = createDirectoryNode({
      path: '/root',
      name: 'root',
      loadState: 'unloaded',
    });

    const result = await querySelectableFiles({
      roots: [root],
      fileSystemAdapter: adapter,
      filterTreeFn,
      includeFilters: [],
      excludeFilters: [],
      useRegex: false,
    });

    expect(filterTreeFn).toHaveBeenCalled();
    expect(result.filePaths).toEqual(['/root/src/keep.ts']);
  });

  it('reports progress and skips hidden nodes while scanning', async () => {
    const progress = vi.fn();
    const adapter = createMockAdapter({
      '/root': [
        createFileNode({ path: '/root/visible.ts', name: 'visible.ts', depth: 1 }),
        createFileNode({
          path: '/root/hidden.ts',
          name: 'hidden.ts',
          depth: 1,
          isVisible: false,
        }),
      ],
    });

    const result = await querySelectableFiles({
      roots: [createDirectoryNode({ path: '/root', name: 'root', loadState: 'unloaded' })],
      fileSystemAdapter: adapter,
      includeFilters: [],
      excludeFilters: [],
      onProgress: progress,
      useRegex: false,
    });

    expect(result.filePaths).toEqual(['/root/visible.ts']);
    expect(progress).toHaveBeenCalled();
  });

  it('throws an abort error before scanning when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      querySelectableFiles({
        roots: [createDirectoryNode({ path: '/root', name: 'root', loadState: 'unloaded' })],
        fileSystemAdapter: createMockAdapter({}),
        includeFilters: [],
        excludeFilters: [],
        abortSignal: controller.signal,
        useRegex: false,
      })
    ).rejects.toThrow(/cancelled/i);
  });

  it('returns immediately when no slots are available', async () => {
    const adapter = createMockAdapter({
      '/root': [createFileNode({ path: '/root/file.ts', name: 'file.ts', depth: 1 })],
    });

    const root = createDirectoryNode({
      path: '/root',
      name: 'root',
      loadState: 'unloaded',
    });

    const result = await querySelectableFiles({
      roots: [root],
      fileSystemAdapter: adapter,
      includeFilters: [],
      excludeFilters: [],
      maxResults: 0,
      useRegex: false,
    });

    expect(result.filePaths).toEqual([]);
    expect(adapter.readDirectory).not.toHaveBeenCalled();
  });

  it('stops scheduling additional throughput chunks once the limit is reached', async () => {
    const makeFiles = (prefix: string, count: number): IFileNode[] =>
      Array.from({ length: count }, (_, index) =>
        createFileNode({
          path: `${prefix}/file-${index}.ts`,
          name: `file-${index}.ts`,
          depth: 2,
        })
      );

    const adapter = createMockAdapter({
      '/root': [
        createDirectoryNode({ path: '/root/a', name: 'a', depth: 1, loadState: 'unloaded' }),
        createDirectoryNode({ path: '/root/b', name: 'b', depth: 1, loadState: 'unloaded' }),
        createDirectoryNode({ path: '/root/c', name: 'c', depth: 1, loadState: 'unloaded' }),
        createDirectoryNode({ path: '/root/d', name: 'd', depth: 1, loadState: 'unloaded' }),
      ],
      '/root/a': makeFiles('/root/a', 200),
      '/root/b': makeFiles('/root/b', 200),
      '/root/c': makeFiles('/root/c', 200),
      '/root/d': makeFiles('/root/d', 200),
    });

    const root = createDirectoryNode({
      path: '/root',
      name: 'root',
      loadState: 'unloaded',
    });

    const result = await querySelectableFiles({
      roots: [root],
      fileSystemAdapter: adapter,
      includeFilters: [],
      excludeFilters: [],
      maxResults: 300,
      concurrency: 2,
      useRegex: false,
    });

    expect(result.limitReached).toBe(true);
    expect(result.filePaths).toHaveLength(300);
    expect(adapter.readDirectory).toHaveBeenCalledTimes(3);
    expect(adapter.readDirectory).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ path: '/root' }),
      expect.anything()
    );
    expect(adapter.readDirectory).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ path: '/root/a' }),
      expect.anything()
    );
    expect(adapter.readDirectory).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ path: '/root/b' }),
      expect.anything()
    );
  });

  it('returns once the limit is satisfied without waiting for sibling throughput reads to settle', async () => {
    const readDirectory = vi.fn(async (handle: DirectoryHandle) => {
      if (handle.path === '/root') {
        return [
          createDirectoryNode({ path: '/root/a', name: 'a', depth: 1, loadState: 'unloaded' }),
          createDirectoryNode({ path: '/root/b', name: 'b', depth: 1, loadState: 'unloaded' }),
          createDirectoryNode({ path: '/root/c', name: 'c', depth: 1, loadState: 'unloaded' }),
        ];
      }
      if (handle.path === '/root/a') {
        return Array.from({ length: 300 }, (_, index) =>
          createFileNode({
            path: `/root/a/file-${index}.ts`,
            name: `file-${index}.ts`,
            depth: 2,
          })
        );
      }
      if (handle.path === '/root/b') {
        return new Promise<IFileNode[]>(() => {});
      }
      if (handle.path === '/root/c') {
        throw new Error('throughput scheduling should not reach /root/c once the limit is met');
      }
      return [];
    });

    const adapter = {
      requestDirectoryAccess: vi.fn(),
      readDirectory,
      readFile: vi.fn(),
      exists: vi.fn(),
    } as unknown as FileSystemAdapter;

    const root = createDirectoryNode({
      path: '/root',
      name: 'root',
      loadState: 'unloaded',
    });

    const result = await querySelectableFiles({
      roots: [root],
      fileSystemAdapter: adapter,
      includeFilters: [],
      excludeFilters: [],
      maxResults: 300,
      concurrency: 2,
      useRegex: false,
    });

    expect(result.limitReached).toBe(true);
    expect(result.filePaths).toHaveLength(300);
    expect(readDirectory).toHaveBeenCalledTimes(3);
    expect(readDirectory).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: '/root/c' }),
      expect.anything()
    );
  });

  it('dedupes duplicate directory paths across the traversal frontier', async () => {
    const adapter = createMockAdapter({
      '/root/shared': [createFileNode({ path: '/root/shared/a.ts', name: 'a.ts', depth: 2 })],
    });

    const sharedDirectory = createDirectoryNode({
      path: '/root/shared',
      name: 'shared',
      depth: 1,
      loadState: 'unloaded',
    });

    const result = await querySelectableFiles({
      roots: [
        createDirectoryNode({
          path: '/root',
          name: 'root',
          loadState: 'loaded',
          children: [sharedDirectory],
        }),
        createDirectoryNode({
          path: '/root-2',
          name: 'root-2',
          loadState: 'loaded',
          children: [
            createDirectoryNode({
              path: '/root/shared',
              name: 'shared',
              depth: 1,
              loadState: 'unloaded',
            }),
          ],
        }),
      ],
      fileSystemAdapter: adapter,
      includeFilters: [],
      excludeFilters: [],
      useRegex: false,
    });

    expect(result.filePaths).toEqual(['/root/shared/a.ts']);
    expect(adapter.readDirectory).toHaveBeenCalledTimes(1);
  });

  it('caps throughput concurrency to avoid excessive parallel directory reads', async () => {
    let activeReads = 0;
    let maxActiveReads = 0;
    const childDirectories = Array.from({ length: 40 }, (_, index) =>
      createDirectoryNode({
        path: `/root/dir-${index}`,
        name: `dir-${index}`,
        depth: 1,
        loadState: 'unloaded',
      })
    );

    const readDirectory = vi.fn(async (handle: DirectoryHandle) => {
      if (handle.path === '/root') {
        return childDirectories;
      }

      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      await new Promise((resolve) => setTimeout(resolve, 1));
      activeReads -= 1;

      return [
        createFileNode({
          path: `${handle.path}/file.ts`,
          name: 'file.ts',
          depth: 2,
        }),
      ];
    });

    const adapter = {
      requestDirectoryAccess: vi.fn(),
      readDirectory,
      readFile: vi.fn(),
      exists: vi.fn(),
    } as unknown as FileSystemAdapter;

    const root = createDirectoryNode({
      path: '/root',
      name: 'root',
      loadState: 'unloaded',
    });

    const result = await querySelectableFiles({
      roots: [root],
      fileSystemAdapter: adapter,
      includeFilters: [],
      excludeFilters: [],
      maxResults: 400,
      concurrency: 999,
      useRegex: false,
    });

    expect(result.filePaths).toHaveLength(40);
    expect(maxActiveReads).toBeLessThanOrEqual(32);
  });

  it('does not prematurely close a throughput batch when synchronous directory reads settle immediately', async () => {
    const adapter = createMockAdapter({
      '/root': [
        createDirectoryNode({ path: '/root/a', name: 'a', depth: 1, loadState: 'unloaded' }),
        createDirectoryNode({ path: '/root/b', name: 'b', depth: 1, loadState: 'unloaded' }),
        createDirectoryNode({ path: '/root/c', name: 'c', depth: 1, loadState: 'unloaded' }),
      ],
      '/root/a': [createFileNode({ path: '/root/a/a.ts', name: 'a.ts', depth: 2 })],
      '/root/b': [createFileNode({ path: '/root/b/b.ts', name: 'b.ts', depth: 2 })],
      '/root/c': [createFileNode({ path: '/root/c/c.ts', name: 'c.ts', depth: 2 })],
    });

    const result = await querySelectableFiles({
      roots: [createDirectoryNode({ path: '/root', name: 'root', loadState: 'unloaded' })],
      fileSystemAdapter: adapter,
      includeFilters: [],
      excludeFilters: [],
      concurrency: 2,
      maxResults: 10,
      useRegex: false,
    });

    expect(result.filePaths).toEqual(['/root/a/a.ts', '/root/b/b.ts', '/root/c/c.ts']);
  });
});
