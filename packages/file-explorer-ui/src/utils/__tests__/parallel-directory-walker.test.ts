import type { DirectoryHandle, FileSystemAdapter } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import { createBackgroundIndexingEntryPolicy } from '@brainstrike/utils';
import { describe, expect, it, vi } from 'vitest';
import {
  DirectoryListingTruncatedError,
  walkDirectoryParallel,
} from '../parallel-directory-walker';

const rootHandle: DirectoryHandle = {
  _internal: undefined,
  kind: 'directory',
  name: 'root',
  path: '/workspace/root',
  platform: 'electron',
};

function createDirectoryEntry(name: string, path: string): IFileNode {
  return {
    handle: { kind: 'directory', name },
    name,
    path,
    type: 'directory',
  } as IFileNode;
}

function createFileEntry(name: string, path: string): IFileNode {
  return {
    handle: { kind: 'file', name },
    name,
    path,
    size: 32,
    type: 'file',
  } as IFileNode;
}

function createTruncatedEntry(parentPath: string): IFileNode {
  return {
    handle: { kind: 'file', name: '…truncated…' },
    name: 'Showing first 10,000 entries',
    path: `${parentPath}/…truncated…`,
    type: 'truncated',
  } as IFileNode;
}

function createFileSystemAdapter(
  readDirectory: FileSystemAdapter['readDirectory']
): FileSystemAdapter {
  return {
    exists: vi.fn(),
    readDirectory,
    readFile: vi.fn(),
    requestDirectoryAccess: vi.fn(),
  } as unknown as FileSystemAdapter;
}

describe('walkDirectoryParallel', () => {
  it('skips excluded directories before traversing them', async () => {
    const readDirectory = vi.fn(async (handle: DirectoryHandle) => {
      if (handle.path === '/workspace/root') {
        return [
          createDirectoryEntry('coverage', '/workspace/root/coverage'),
          createDirectoryEntry('src', '/workspace/root/src'),
          createFileEntry('README.md', '/workspace/root/README.md'),
        ];
      }
      if (handle.path === '/workspace/root/src') {
        return [createFileEntry('index.ts', '/workspace/root/src/index.ts')];
      }
      if (handle.path === '/workspace/root/coverage') {
        return [createFileEntry('lcov.info', '/workspace/root/coverage/lcov.info')];
      }
      return [];
    });

    const fileSystemAdapter = createFileSystemAdapter(readDirectory);

    const tree = await walkDirectoryParallel(fileSystemAdapter, rootHandle, {
      entryPolicy: {
        shouldIncludeFile: ({ relativePath }) => relativePath !== 'README.md',
        shouldTraverseDirectory: ({ relativePath }) => relativePath !== 'coverage',
      },
    });

    expect(readDirectory).toHaveBeenCalledTimes(2);
    expect(readDirectory).not.toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/workspace/root/coverage',
      })
    );
    expect(tree).toEqual([
      expect.objectContaining({
        children: [expect.objectContaining({ name: 'index.ts' })],
        name: 'src',
      }),
    ]);
  });

  it('skips package manager stores before traversing them', async () => {
    const readDirectory = vi.fn(async (handle: DirectoryHandle) => {
      if (handle.path === '/workspace/root') {
        return [
          createDirectoryEntry('.pnpm-store', '/workspace/root/.pnpm-store'),
          createDirectoryEntry('src', '/workspace/root/src'),
        ];
      }
      if (handle.path === '/workspace/root/src') {
        return [createFileEntry('index.ts', '/workspace/root/src/index.ts')];
      }
      if (handle.path === '/workspace/root/.pnpm-store') {
        return [createDirectoryEntry('v10', '/workspace/root/.pnpm-store/v10')];
      }
      throw new Error(`Unexpected directory read: ${handle.path}`);
    });

    const fileSystemAdapter = createFileSystemAdapter(readDirectory);

    const skipped: string[] = [];
    const tree = await walkDirectoryParallel(fileSystemAdapter, rootHandle, {
      onEntrySkipped: ({ relativePath }) => {
        skipped.push(relativePath);
      },
    });

    expect(readDirectory).toHaveBeenCalledTimes(2);
    expect(readDirectory).not.toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/workspace/root/.pnpm-store',
      })
    );
    expect(skipped).toContain('.pnpm-store');
    expect(tree).toEqual([
      expect.objectContaining({
        children: [expect.objectContaining({ name: 'index.ts' })],
        name: 'src',
      }),
    ]);
  });

  it('prunes Python environments before balanced recursive reads', async () => {
    const pythonDirectories = ['.venv', 'venv', '__pycache__'];
    const readDirectory = vi.fn(async (handle: DirectoryHandle) => {
      if (handle.path === '/workspace/root') {
        return [
          ...pythonDirectories.map((name) => createDirectoryEntry(name, `/workspace/root/${name}`)),
          createDirectoryEntry('env', '/workspace/root/env'),
          createDirectoryEntry('src', '/workspace/root/src'),
        ];
      }
      if (handle.path === '/workspace/root/env') {
        return [createFileEntry('config.ts', '/workspace/root/env/config.ts')];
      }
      if (handle.path === '/workspace/root/src') {
        return [createFileEntry('index.py', '/workspace/root/src/index.py')];
      }
      throw new Error(`Python environment should have been pruned: ${handle.path}`);
    });

    const tree = await walkDirectoryParallel(createFileSystemAdapter(readDirectory), rootHandle, {
      entryPolicy: createBackgroundIndexingEntryPolicy({ preset: 'balanced' }),
    });

    expect(readDirectory).toHaveBeenCalledTimes(3);
    for (const name of pythonDirectories) {
      expect(readDirectory).not.toHaveBeenCalledWith(
        expect.objectContaining({ path: `/workspace/root/${name}` })
      );
    }
    expect(tree).toEqual([
      expect.objectContaining({
        children: [expect.objectContaining({ name: 'config.ts' })],
        name: 'env',
      }),
      expect.objectContaining({
        children: [expect.objectContaining({ name: 'index.py' })],
        name: 'src',
      }),
    ]);
  });

  it('reports truncated directory listings to onDirectoryTruncated and omits the marker from the tree', async () => {
    const readDirectory = vi.fn(async (handle: DirectoryHandle) => {
      if (handle.path === '/workspace/root') {
        return [
          createDirectoryEntry('src', '/workspace/root/src'),
          createTruncatedEntry('/workspace/root'),
        ];
      }
      if (handle.path === '/workspace/root/src') {
        return [
          createFileEntry('index.ts', '/workspace/root/src/index.ts'),
          createTruncatedEntry('/workspace/root/src'),
        ];
      }
      return [];
    });

    const truncated: Array<{ depth: number; path: string }> = [];
    const tree = await walkDirectoryParallel(createFileSystemAdapter(readDirectory), rootHandle, {
      onDirectoryTruncated: (info) => {
        truncated.push(info);
      },
    });

    expect(truncated).toEqual(
      expect.arrayContaining([
        { depth: 0, path: '/workspace/root' },
        { depth: 1, path: '/workspace/root/src' },
      ])
    );
    expect(truncated).toHaveLength(2);
    expect(tree).toEqual([
      expect.objectContaining({
        children: [expect.objectContaining({ name: 'index.ts', type: 'file' })],
        name: 'src',
      }),
    ]);
  });

  it('throws on a truncated subdirectory listing when no onDirectoryTruncated handler is installed', async () => {
    const readDirectory = vi.fn(async (handle: DirectoryHandle) => {
      if (handle.path === '/workspace/root') {
        return [createDirectoryEntry('src', '/workspace/root/src')];
      }
      if (handle.path === '/workspace/root/src') {
        return [
          createFileEntry('index.ts', '/workspace/root/src/index.ts'),
          createTruncatedEntry('/workspace/root/src'),
        ];
      }
      return [];
    });

    // No propagateDirectoryReadErrors: truncation must still fail loud for a
    // non-root directory instead of riding the silent unreadable-subdir skip.
    await expect(
      walkDirectoryParallel(createFileSystemAdapter(readDirectory), rootHandle, {})
    ).rejects.toThrow(DirectoryListingTruncatedError);
  });

  it('sorts directories before files using the default collator', async () => {
    const readDirectory = vi.fn(async (handle: DirectoryHandle) => {
      if (handle.path === '/workspace/root') {
        return [
          createFileEntry('zeta.ts', '/workspace/root/zeta.ts'),
          createDirectoryEntry('beta', '/workspace/root/beta'),
          createFileEntry('alpha.ts', '/workspace/root/alpha.ts'),
          createDirectoryEntry('alpha', '/workspace/root/alpha'),
        ];
      }
      return [];
    });

    const tree = await walkDirectoryParallel(createFileSystemAdapter(readDirectory), rootHandle);

    expect(tree.map((node) => node.name)).toEqual(['alpha', 'beta', 'alpha.ts', 'zeta.ts']);
  });

  it('preserves the durable rootId on rebuilt child directory handles', async () => {
    const stampedRootHandle: DirectoryHandle = {
      ...rootHandle,
      rootId: 'outer-root-id',
    };
    const readDirectory = vi.fn(async (handle: DirectoryHandle): Promise<IFileNode[]> => {
      if (handle.path === '/workspace/root') {
        return [
          {
            ...createDirectoryEntry('nested-root', '/workspace/root/nested-root'),
            handle: {
              kind: 'directory',
              name: 'nested-root',
              path: '/workspace/root/nested-root',
              platform: 'electron',
              rootId: 'outer-root-id',
            } as unknown as IFileNode['handle'],
          },
        ];
      }
      return [];
    });

    await walkDirectoryParallel(createFileSystemAdapter(readDirectory), stampedRootHandle);

    expect(readDirectory).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/workspace/root/nested-root',
        rootId: 'outer-root-id',
      })
    );
  });

  it('inherits the parent rootId when a child directory handle is unstamped', async () => {
    const stampedRootHandle: DirectoryHandle = {
      ...rootHandle,
      rootId: 'outer-root-id',
    };
    const readDirectory = vi.fn(async (handle: DirectoryHandle): Promise<IFileNode[]> => {
      if (handle.path === '/workspace/root') {
        return [createDirectoryEntry('nested-root', '/workspace/root/nested-root')];
      }
      return [];
    });

    await walkDirectoryParallel(createFileSystemAdapter(readDirectory), stampedRootHandle);

    expect(readDirectory).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/workspace/root/nested-root',
        rootId: 'outer-root-id',
      })
    );
  });

  it('uses canonical entry handle paths for web child directory reads while preserving relative node paths', async () => {
    const rawDirectory = { kind: 'directory', name: 'docs' };
    const webRootHandle: DirectoryHandle = {
      _internal: undefined,
      kind: 'directory',
      name: 'web-root',
      path: 'web-root',
      platform: 'web',
    };
    const readDirectory = vi.fn(async (handle: DirectoryHandle): Promise<IFileNode[]> => {
      if (handle.path === 'web-root') {
        return [
          {
            ...createDirectoryEntry('docs', 'web-root/docs'),
            handle: {
              _internal: rawDirectory,
              kind: 'directory',
              name: 'docs',
              path: 'web-root/docs',
              platform: 'web',
            },
          },
        ];
      }
      if (handle.path === 'web-root/docs') {
        return [createFileEntry('guide.md', 'web-root/docs/guide.md')];
      }
      throw new Error(`Unexpected directory read: ${handle.path}`);
    });

    const tree = await walkDirectoryParallel(createFileSystemAdapter(readDirectory), webRootHandle);

    expect(readDirectory).toHaveBeenCalledWith(
      expect.objectContaining({ _internal: rawDirectory, path: 'web-root/docs' })
    );
    expect(tree).toEqual([
      expect.objectContaining({
        children: [
          expect.objectContaining({
            name: 'guide.md',
            path: 'docs/guide.md',
          }),
        ],
        name: 'docs',
        path: 'docs',
      }),
    ]);
  });

  it('rejects a root handle without a canonical path', async () => {
    const readDirectory = vi.fn(async () => []);
    const handleWithoutPath = {
      ...rootHandle,
      path: '',
    };

    await expect(
      walkDirectoryParallel(createFileSystemAdapter(readDirectory), handleWithoutPath)
    ).rejects.toThrow('Root directory handle is missing its canonical path');
    expect(readDirectory).not.toHaveBeenCalled();
  });

  it('emits streaming snapshots with progress metadata', async () => {
    const readDirectory = vi.fn(async (handle: DirectoryHandle) => {
      if (handle.path === '/workspace/root') {
        return [
          createDirectoryEntry('src', '/workspace/root/src'),
          createFileEntry('README.md', '/workspace/root/README.md'),
        ];
      }
      if (handle.path === '/workspace/root/src') {
        return [createFileEntry('index.ts', '/workspace/root/src/index.ts')];
      }
      return [];
    });
    const onTreeSnapshot = vi.fn();

    await walkDirectoryParallel(createFileSystemAdapter(readDirectory), rootHandle, {
      onTreeSnapshot,
      snapshotIntervalMs: 0,
    });

    const snapshots = onTreeSnapshot.mock.calls.map((call) => call[1]);
    expect(snapshots.some((meta) => meta.isComplete === false)).toBe(true);
    expect(snapshots.at(-1)).toEqual(
      expect.objectContaining({
        depthProgress: expect.objectContaining({
          directoriesCompleted: 2,
          directoriesRemaining: 0,
          filesFound: 2,
          maxDepthSeen: 1,
        }),
        isComplete: true,
        totalNodesDiscovered: 4,
      })
    );
  });

  it('rejects with an abort error when the signal is already cancelled', async () => {
    const readDirectory = vi.fn(async () => []);
    const abortController = new AbortController();
    abortController.abort();

    await expect(
      walkDirectoryParallel(createFileSystemAdapter(readDirectory), rootHandle, {
        abortSignal: abortController.signal,
      })
    ).rejects.toThrow('Operation was cancelled');
    expect(readDirectory).not.toHaveBeenCalled();
  });

  it('wraps non-error root directory read failures', async () => {
    const readDirectory = vi.fn(() => Promise.reject('root read failed'));

    await expect(
      walkDirectoryParallel(createFileSystemAdapter(readDirectory), rootHandle)
    ).rejects.toThrow('root read failed');
  });

  it('keeps unreadable child directories as empty nodes', async () => {
    const readDirectory = vi.fn(async (handle: DirectoryHandle) => {
      if (handle.path === '/workspace/root') {
        return [createDirectoryEntry('locked', '/workspace/root/locked')];
      }
      if (handle.path === '/workspace/root/locked') {
        throw new Error('permission denied');
      }
      return [];
    });

    const tree = await walkDirectoryParallel(createFileSystemAdapter(readDirectory), rootHandle);

    expect(tree).toEqual([
      expect.objectContaining({
        children: [],
        name: 'locked',
      }),
    ]);
  });
});
