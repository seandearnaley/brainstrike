// @vitest-environment node
import type { DirectoryHandle, FileSystemAdapter, IFileNode } from '@brainstrike/types';
import { describe, expect, it, vi } from 'vitest';
import { querySelectableFiles } from '../recursive-selection-query';
// Shared test doubles: the factories live in one place so the suites cannot
// drift (BST-478 review thread — the helper was added without migrating this
// suite's byte-identical local copies).
import {
  createDirectoryNode,
  createFileNode,
  createMockAdapter,
} from './helpers/recursive-selection-test-kit';

vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    }),
  };
});

describe('recursive-selection-query', () => {
  it('stops on already-loaded visible files before reading deeper unloaded directories', async () => {
    const adapter = createMockAdapter({
      '/root/src': [createFileNode({ depth: 2, name: 'deep.ts', path: '/root/src/deep.ts' })],
    });

    const root = createDirectoryNode({
      children: [
        createFileNode({ depth: 1, name: 'README.md', path: '/root/README.md' }),
        createDirectoryNode({ depth: 1, loadState: 'unloaded', name: 'src', path: '/root/src' }),
      ],
      loadState: 'loaded',
      name: 'root',
      path: '/root',
    });

    const result = await querySelectableFiles({
      excludeFilters: [],
      fileSystemAdapter: adapter,
      includeFilters: [],
      maxResults: 1,
      roots: [root],
      useRegex: false,
    });

    expect(result.filePaths).toEqual(['/root/README.md']);
    expect(adapter.readDirectory).not.toHaveBeenCalled();
  });

  it('reads only the breadth-first frontier needed to satisfy a low cap', async () => {
    const adapter = createMockAdapter({
      '/root': [
        createDirectoryNode({
          depth: 1,
          loadState: 'unloaded',
          name: 'a-dir',
          path: '/root/a-dir',
        }),
        createFileNode({ depth: 1, name: 'file-1.ts', path: '/root/file-1.ts' }),
        createFileNode({ depth: 1, name: 'file-2.ts', path: '/root/file-2.ts' }),
      ],
      '/root/a-dir': [createFileNode({ depth: 2, name: 'deep.ts', path: '/root/a-dir/deep.ts' })],
    });

    const root = createDirectoryNode({
      loadState: 'unloaded',
      name: 'root',
      path: '/root',
    });

    const result = await querySelectableFiles({
      excludeFilters: [],
      fileSystemAdapter: adapter,
      includeFilters: [],
      maxResults: 2,
      roots: [root],
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

  it('does not mark the limit reached when matches exactly fill the requested cap', async () => {
    const adapter = createMockAdapter({
      '/root': [
        createFileNode({ depth: 1, name: 'file-1.ts', path: '/root/file-1.ts' }),
        createFileNode({ depth: 1, name: 'file-2.ts', path: '/root/file-2.ts' }),
      ],
    });

    const root = createDirectoryNode({
      loadState: 'unloaded',
      name: 'root',
      path: '/root',
    });

    const result = await querySelectableFiles({
      excludeFilters: [],
      fileSystemAdapter: adapter,
      includeFilters: [],
      maxResults: 2,
      roots: [root],
      useRegex: false,
    });

    expect(result.filePaths).toEqual(['/root/file-1.ts', '/root/file-2.ts']);
    expect(result.limitReached).toBe(false);
    expect(adapter.readDirectory).toHaveBeenCalledTimes(1);
  });

  it('does not mark the limit reached when throughput scanning exactly fills the cap', async () => {
    const makeFiles = (prefix: string, count: number): IFileNode[] =>
      Array.from({ length: count }, (_, index) =>
        createFileNode({
          depth: 2,
          name: `file-${index}.ts`,
          path: `${prefix}/file-${index}.ts`,
        })
      );

    const adapter = createMockAdapter({
      '/root': [
        createDirectoryNode({ depth: 1, loadState: 'unloaded', name: 'a', path: '/root/a' }),
        createDirectoryNode({ depth: 1, loadState: 'unloaded', name: 'b', path: '/root/b' }),
        createDirectoryNode({ depth: 1, loadState: 'unloaded', name: 'c', path: '/root/c' }),
        createDirectoryNode({ depth: 1, loadState: 'unloaded', name: 'd', path: '/root/d' }),
      ],
      '/root/a': makeFiles('/root/a', 40),
      '/root/b': makeFiles('/root/b', 40),
      '/root/c': makeFiles('/root/c', 40),
      '/root/d': makeFiles('/root/d', 40),
    });

    const root = createDirectoryNode({
      loadState: 'unloaded',
      name: 'root',
      path: '/root',
    });

    const result = await querySelectableFiles({
      concurrency: 4,
      excludeFilters: [],
      fileSystemAdapter: adapter,
      includeFilters: [],
      maxResults: 160,
      roots: [root],
      useRegex: false,
    });

    expect(result.filePaths).toHaveLength(160);
    expect(result.limitReached).toBe(false);
  });

  it('does not revisit the same directory path when traversal encounters a cycle', async () => {
    const adapter = createMockAdapter({
      '/root': [
        createDirectoryNode({
          depth: 1,
          loadState: 'unloaded',
          name: 'loop',
          path: '/root/loop',
        }),
      ],
      '/root/loop': [
        createDirectoryNode({
          depth: 2,
          loadState: 'unloaded',
          name: 'loop',
          path: '/root/loop',
        }),
        createFileNode({ depth: 2, name: 'file.ts', path: '/root/loop/file.ts' }),
      ],
    });

    const result = await querySelectableFiles({
      excludeFilters: [],
      fileSystemAdapter: adapter,
      includeFilters: [],
      roots: [createDirectoryNode({ loadState: 'unloaded', name: 'root', path: '/root' })],
      useRegex: false,
    });

    expect(result.filePaths).toEqual(['/root/loop/file.ts']);
    expect(adapter.readDirectory).toHaveBeenCalledTimes(2);
  });

  it('applies filterTreeFn to loaded and adapter-read nodes', async () => {
    const adapter = createMockAdapter({
      '/root': [
        createDirectoryNode({ depth: 1, loadState: 'unloaded', name: 'src', path: '/root/src' }),
        createFileNode({ depth: 1, name: 'readme.md', path: '/root/readme.md' }),
      ],
      '/root/src': [
        createFileNode({ depth: 2, name: 'keep.ts', path: '/root/src/keep.ts' }),
        createFileNode({ depth: 2, name: 'skip.md', path: '/root/src/skip.md' }),
      ],
    });

    const filterTreeFn = vi.fn((nodes: IFileNode[]): IFileNode[] =>
      nodes.filter((node) => (node.type === 'directory' ? true : node.path.endsWith('.ts')))
    );

    const root = createDirectoryNode({
      loadState: 'unloaded',
      name: 'root',
      path: '/root',
    });

    const result = await querySelectableFiles({
      excludeFilters: [],
      fileSystemAdapter: adapter,
      filterTreeFn,
      includeFilters: [],
      roots: [root],
      useRegex: false,
    });

    expect(filterTreeFn).toHaveBeenCalled();
    expect(result.filePaths).toEqual(['/root/src/keep.ts']);
  });

  it('reports progress and skips hidden nodes while scanning', async () => {
    const progress = vi.fn();
    const adapter = createMockAdapter({
      '/root': [
        createFileNode({ depth: 1, name: 'visible.ts', path: '/root/visible.ts' }),
        createFileNode({
          depth: 1,
          isVisible: false,
          name: 'hidden.ts',
          path: '/root/hidden.ts',
        }),
      ],
    });

    const result = await querySelectableFiles({
      excludeFilters: [],
      fileSystemAdapter: adapter,
      includeFilters: [],
      onProgress: progress,
      roots: [createDirectoryNode({ loadState: 'unloaded', name: 'root', path: '/root' })],
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
        abortSignal: controller.signal,
        excludeFilters: [],
        fileSystemAdapter: createMockAdapter({}),
        includeFilters: [],
        roots: [createDirectoryNode({ loadState: 'unloaded', name: 'root', path: '/root' })],
        useRegex: false,
      })
    ).rejects.toThrow(/cancelled/i);
  });

  it('returns immediately when no slots are available', async () => {
    const adapter = createMockAdapter({
      '/root': [createFileNode({ depth: 1, name: 'file.ts', path: '/root/file.ts' })],
    });

    const root = createDirectoryNode({
      loadState: 'unloaded',
      name: 'root',
      path: '/root',
    });

    const result = await querySelectableFiles({
      excludeFilters: [],
      fileSystemAdapter: adapter,
      includeFilters: [],
      maxResults: 0,
      roots: [root],
      useRegex: false,
    });

    expect(result.filePaths).toEqual([]);
    expect(adapter.readDirectory).not.toHaveBeenCalled();
  });

  it('throws when discovered directories exceed the traversal safety limit', async () => {
    const adapter = createMockAdapter({
      '/root': [
        createDirectoryNode({
          depth: 1,
          loadState: 'unloaded',
          name: 'a',
          path: '/root/a',
        }),
        createDirectoryNode({
          depth: 1,
          loadState: 'unloaded',
          name: 'b',
          path: '/root/b',
        }),
      ],
    });

    await expect(
      querySelectableFiles({
        excludeFilters: [],
        fileSystemAdapter: adapter,
        includeFilters: [],
        maxDirectories: 2,
        roots: [createDirectoryNode({ loadState: 'unloaded', name: 'root', path: '/root' })],
        useRegex: false,
      })
    ).rejects.toThrow('Recursive selection traversal limit exceeded (2)');
  });

  it('stops scheduling additional throughput chunks once the limit is reached', async () => {
    const makeFiles = (prefix: string, count: number): IFileNode[] =>
      Array.from({ length: count }, (_, index) =>
        createFileNode({
          depth: 2,
          name: `file-${index}.ts`,
          path: `${prefix}/file-${index}.ts`,
        })
      );

    const adapter = createMockAdapter({
      '/root': [
        createDirectoryNode({ depth: 1, loadState: 'unloaded', name: 'a', path: '/root/a' }),
        createDirectoryNode({ depth: 1, loadState: 'unloaded', name: 'b', path: '/root/b' }),
        createDirectoryNode({ depth: 1, loadState: 'unloaded', name: 'c', path: '/root/c' }),
        createDirectoryNode({ depth: 1, loadState: 'unloaded', name: 'd', path: '/root/d' }),
      ],
      '/root/a': makeFiles('/root/a', 200),
      '/root/b': makeFiles('/root/b', 200),
      '/root/c': makeFiles('/root/c', 200),
      '/root/d': makeFiles('/root/d', 200),
    });

    const root = createDirectoryNode({
      loadState: 'unloaded',
      name: 'root',
      path: '/root',
    });

    const result = await querySelectableFiles({
      concurrency: 2,
      excludeFilters: [],
      fileSystemAdapter: adapter,
      includeFilters: [],
      maxResults: 300,
      roots: [root],
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
          createDirectoryNode({ depth: 1, loadState: 'unloaded', name: 'a', path: '/root/a' }),
          createDirectoryNode({ depth: 1, loadState: 'unloaded', name: 'b', path: '/root/b' }),
          createDirectoryNode({ depth: 1, loadState: 'unloaded', name: 'c', path: '/root/c' }),
        ];
      }
      if (handle.path === '/root/a') {
        return Array.from({ length: 300 }, (_, index) =>
          createFileNode({
            depth: 2,
            name: `file-${index}.ts`,
            path: `/root/a/file-${index}.ts`,
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
      exists: vi.fn(),
      readDirectory,
      readFile: vi.fn(),
      requestDirectoryAccess: vi.fn(),
    } as unknown as FileSystemAdapter;

    const root = createDirectoryNode({
      loadState: 'unloaded',
      name: 'root',
      path: '/root',
    });

    const result = await querySelectableFiles({
      concurrency: 2,
      excludeFilters: [],
      fileSystemAdapter: adapter,
      includeFilters: [],
      maxResults: 300,
      roots: [root],
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
      '/root/shared': [createFileNode({ depth: 2, name: 'a.ts', path: '/root/shared/a.ts' })],
    });

    const sharedDirectory = createDirectoryNode({
      depth: 1,
      loadState: 'unloaded',
      name: 'shared',
      path: '/root/shared',
    });

    const result = await querySelectableFiles({
      excludeFilters: [],
      fileSystemAdapter: adapter,
      includeFilters: [],
      roots: [
        createDirectoryNode({
          children: [sharedDirectory],
          loadState: 'loaded',
          name: 'root',
          path: '/root',
        }),
        createDirectoryNode({
          children: [
            createDirectoryNode({
              depth: 1,
              loadState: 'unloaded',
              name: 'shared',
              path: '/root/shared',
            }),
          ],
          loadState: 'loaded',
          name: 'root-2',
          path: '/root-2',
        }),
      ],
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
        depth: 1,
        loadState: 'unloaded',
        name: `dir-${index}`,
        path: `/root/dir-${index}`,
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
          depth: 2,
          name: 'file.ts',
          path: `${handle.path}/file.ts`,
        }),
      ];
    });

    const adapter = {
      exists: vi.fn(),
      readDirectory,
      readFile: vi.fn(),
      requestDirectoryAccess: vi.fn(),
    } as unknown as FileSystemAdapter;

    const root = createDirectoryNode({
      loadState: 'unloaded',
      name: 'root',
      path: '/root',
    });

    const result = await querySelectableFiles({
      concurrency: 999,
      excludeFilters: [],
      fileSystemAdapter: adapter,
      includeFilters: [],
      maxResults: 400,
      roots: [root],
      useRegex: false,
    });

    expect(result.filePaths).toHaveLength(40);
    expect(maxActiveReads).toBeLessThanOrEqual(12);
  });

  it('retains one frontier entry per unloaded directory in a wide tree', async () => {
    const directoryCount = 4096;
    const childDirectories = Array.from({ length: directoryCount }, (_, index) =>
      createDirectoryNode({
        depth: 1,
        loadState: 'unloaded',
        name: `dir-${index}`,
        path: `/root/dir-${index}`,
      })
    );
    const adapter = createMockAdapter({ '/root': childDirectories });
    let peakBufferedDirectoryEntries = 0;

    const result = await querySelectableFiles({
      concurrency: 12,
      excludeFilters: [],
      fileSystemAdapter: adapter,
      includeFilters: [],
      onBufferProfile: (profile) => {
        peakBufferedDirectoryEntries = Math.max(
          peakBufferedDirectoryEntries,
          profile.bufferedDirectoryEntries
        );
      },
      roots: [createDirectoryNode({ loadState: 'unloaded', name: 'root', path: '/root' })],
      useRegex: false,
    });

    expect(result.filePaths).toEqual([]);
    // The root remains retained while its adapter listing fills the next frontier.
    expect(peakBufferedDirectoryEntries).toBe(directoryCount + 1);
  });

  it('profiles loaded frontier entries without mutating the caller roots', async () => {
    const directoryCount = 64;
    const roots = Array.from({ length: directoryCount }, (_, index) =>
      createDirectoryNode({
        children: [],
        loadState: 'loaded',
        name: `dir-${index}`,
        path: `/dir-${index}`,
      })
    );
    const originalRoots = [...roots];
    let peakBufferedDirectoryEntries = 0;

    const result = await querySelectableFiles({
      excludeFilters: [],
      fileSystemAdapter: createMockAdapter({}),
      includeFilters: [],
      onBufferProfile: (profile) => {
        peakBufferedDirectoryEntries = Math.max(
          peakBufferedDirectoryEntries,
          profile.bufferedDirectoryEntries
        );
      },
      roots,
      useRegex: false,
    });

    expect(result.filePaths).toEqual([]);
    expect(peakBufferedDirectoryEntries).toBe(directoryCount);
    expect(roots).toStrictEqual(originalRoots);
  });

  it('does not prematurely close a throughput batch when synchronous directory reads settle immediately', async () => {
    const adapter = createMockAdapter({
      '/root': [
        createDirectoryNode({ depth: 1, loadState: 'unloaded', name: 'a', path: '/root/a' }),
        createDirectoryNode({ depth: 1, loadState: 'unloaded', name: 'b', path: '/root/b' }),
        createDirectoryNode({ depth: 1, loadState: 'unloaded', name: 'c', path: '/root/c' }),
      ],
      '/root/a': [createFileNode({ depth: 2, name: 'a.ts', path: '/root/a/a.ts' })],
      '/root/b': [createFileNode({ depth: 2, name: 'b.ts', path: '/root/b/b.ts' })],
      '/root/c': [createFileNode({ depth: 2, name: 'c.ts', path: '/root/c/c.ts' })],
    });

    const result = await querySelectableFiles({
      concurrency: 2,
      excludeFilters: [],
      fileSystemAdapter: adapter,
      includeFilters: [],
      maxResults: 10,
      roots: [createDirectoryNode({ loadState: 'unloaded', name: 'root', path: '/root' })],
      useRegex: false,
    });

    expect(result.filePaths).toEqual(['/root/a/a.ts', '/root/b/b.ts', '/root/c/c.ts']);
  });
});

describe('recursive-selection-query directory hydration updates', () => {
  it('returns RAW children updates for every adapter-read directory (filters not applied)', async () => {
    const adapter = createMockAdapter({
      '/root/sub': [
        createFileNode({ depth: 2, name: 'b.ts', path: '/root/sub/b.ts' }),
        createFileNode({ depth: 2, name: 'c.md', path: '/root/sub/c.md' }),
      ],
    });
    const root = createDirectoryNode({
      children: [
        createFileNode({ depth: 1, name: 'a.ts', path: '/root/a.ts' }),
        createDirectoryNode({ depth: 1, loadState: 'unloaded', name: 'sub', path: '/root/sub' }),
      ],
      loadState: 'loaded',
      name: 'root',
      path: '/root',
    });

    const result = await querySelectableFiles({
      collectDirectoryUpdates: true,
      excludeFilters: [],
      fileSystemAdapter: adapter,
      // Workspace filter drops markdown — the SELECTION must respect it, but
      // hydration updates must carry the RAW listing (the normalized tree is
      // the unfiltered universe; display filtering happens downstream).
      filterTreeFn: (tree) => tree.filter((node) => !node.path.endsWith('.md')),
      includeFilters: [],
      roots: [root],
      useRegex: false,
    });

    expect(result.filePaths.sort()).toEqual(['/root/a.ts', '/root/sub/b.ts']);
    expect(result.directoryUpdates).toEqual([
      {
        children: [
          expect.objectContaining({ path: '/root/sub/b.ts' }),
          expect.objectContaining({ path: '/root/sub/c.md' }),
        ],
        path: '/root/sub',
      },
    ]);
  });

  it('returns no update for directories that were already loaded in the tree', async () => {
    const adapter = createMockAdapter({});
    const root = createDirectoryNode({
      children: [
        createDirectoryNode({
          children: [createFileNode({ depth: 2, name: 'x.ts', path: '/root/lib/x.ts' })],
          depth: 1,
          loadState: 'loaded',
          name: 'lib',
          path: '/root/lib',
        }),
      ],
      loadState: 'loaded',
      name: 'root',
      path: '/root',
    });

    const result = await querySelectableFiles({
      collectDirectoryUpdates: true,
      excludeFilters: [],
      fileSystemAdapter: adapter,
      includeFilters: [],
      roots: [root],
      useRegex: false,
    });

    expect(result.filePaths).toEqual(['/root/lib/x.ts']);
    expect(result.directoryUpdates).toEqual([]);
  });

  it.each([
    { maxResults: 4 as number | undefined, mode: 'early-stop' },
    { maxResults: undefined, mode: 'throughput' },
  ])(
    'does not retain directory updates in $mode mode unless collection is opted in',
    async ({ maxResults, mode }) => {
      const adapter = createMockAdapter({
        '/root/sub': [createFileNode({ depth: 2, name: 'b.ts', path: '/root/sub/b.ts' })],
      });
      const root = createDirectoryNode({
        children: [
          createDirectoryNode({ depth: 1, loadState: 'unloaded', name: 'sub', path: '/root/sub' }),
        ],
        loadState: 'loaded',
        name: 'root',
        path: '/root',
      });

      const result = await querySelectableFiles({
        excludeFilters: [],
        fileSystemAdapter: adapter,
        includeFilters: [],
        ...(maxResults === undefined ? {} : { maxResults }),
        roots: [root],
        useRegex: false,
      });

      expect(result.filePaths).toEqual(['/root/sub/b.ts']);
      // Proves the variant really exercised its intended scan-mode branch, so
      // a LOW_LIMIT_SCAN_THRESHOLD change cannot silently collapse both cases
      // onto one path and leave the other unpinned.
      expect(result.metrics.mode).toBe(mode);
      expect(adapter.readDirectory).toHaveBeenCalledTimes(1);
      expect(result.directoryUpdates).toEqual([]);
    }
  );

  it.each([
    { maxResults: 4 as number | undefined, mode: 'early-stop' },
    { maxResults: undefined, mode: 'throughput' },
  ])(
    'still retains directory updates in $mode mode when collection IS opted in',
    async ({ maxResults, mode }) => {
      const adapter = createMockAdapter({
        '/root/sub': [createFileNode({ depth: 2, name: 'b.ts', path: '/root/sub/b.ts' })],
      });
      const root = createDirectoryNode({
        children: [
          createDirectoryNode({ depth: 1, loadState: 'unloaded', name: 'sub', path: '/root/sub' }),
        ],
        loadState: 'loaded',
        name: 'root',
        path: '/root',
      });

      const result = await querySelectableFiles({
        collectDirectoryUpdates: true,
        excludeFilters: [],
        fileSystemAdapter: adapter,
        includeFilters: [],
        ...(maxResults === undefined ? {} : { maxResults }),
        roots: [root],
        useRegex: false,
      });

      expect(result.metrics.mode).toBe(mode);
      expect(adapter.readDirectory).toHaveBeenCalledTimes(1);
      expect(result.directoryUpdates).toEqual([
        {
          children: [expect.objectContaining({ path: '/root/sub/b.ts' })],
          path: '/root/sub',
        },
      ]);
    }
  );
});
