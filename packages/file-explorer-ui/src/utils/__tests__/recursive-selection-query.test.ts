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
});
