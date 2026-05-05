import type { DirectoryHandle, FileSystemAdapter } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import { describe, expect, it, vi } from 'vitest';
import { walkDirectoryParallel } from '../parallel-directory-walker';

function createDirectoryEntry(name: string, path: string): IFileNode {
  return {
    name,
    path,
    type: 'directory',
    handle: { kind: 'directory', name },
  } as IFileNode;
}

function createFileEntry(name: string, path: string): IFileNode {
  return {
    name,
    path,
    type: 'file',
    handle: { kind: 'file', name },
    size: 32,
  } as IFileNode;
}

describe('walkDirectoryParallel', () => {
  it('skips excluded directories before traversing them', async () => {
    const rootHandle: DirectoryHandle = {
      kind: 'directory',
      name: 'root',
      path: '/workspace/root',
      platform: 'electron',
      _internal: undefined,
    };

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

    const fileSystemAdapter: FileSystemAdapter = {
      exists: vi.fn(),
      readDirectory,
      readFile: vi.fn(),
      requestDirectoryAccess: vi.fn(),
    } as unknown as FileSystemAdapter;

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
        name: 'src',
        children: [expect.objectContaining({ name: 'index.ts' })],
      }),
    ]);
  });

  it('skips package manager stores before traversing them', async () => {
    const rootHandle: DirectoryHandle = {
      kind: 'directory',
      name: 'root',
      path: '/workspace/root',
      platform: 'electron',
      _internal: undefined,
    };

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

    const fileSystemAdapter: FileSystemAdapter = {
      exists: vi.fn(),
      readDirectory,
      readFile: vi.fn(),
      requestDirectoryAccess: vi.fn(),
    } as unknown as FileSystemAdapter;

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
        name: 'src',
        children: [expect.objectContaining({ name: 'index.ts' })],
      }),
    ]);
  });
});
